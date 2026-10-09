#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DEFAULT_BROWSER_START_PAGE } from '@cardbush/bush-protocol';
import { BrowserArtifacts, digest, exportedImage, type BrowserArtifact } from './imageArtifacts.js';
import { prepareCapture, captureClip, setViewport, evaluate, canvasExportExpression, type Viewport } from './pageCapture.js';
import { dispatchPointer } from './pagePointer.js';
import { PageSnapshots, snapshotSchema } from './pageSnapshot.js';

import {
  ChromeConnectorError,
  requestChromeConnector,
  type ChromeConnectorDiagnostics,
} from './bridgeClient.js';

type BrowserPage = {
  id: number;
  title: string;
  url: string;
  active: boolean;
  selected?: boolean;
  browser?: string;
  targetKey?: string;
};

type ToolContext = {
  mcpReq: {
    signal: AbortSignal;
    _meta?: Record<string, unknown>;
  };
};

type BrowserScope = {
  id: string;
  title: string;
};

const viewportSchema = z.object({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096),
  deviceScaleFactor: z.number().min(0.5).max(3).optional() });

/** HTTP MCP uses per-request server instances; browser selections and snapshot cursors belong to the host. */
export function createBrowserUseState(artifactsDirectory?: string) {
  return {
    selectedPageIds: new Map<string, number>(), targetKeys: new Map<string, string>(), snapshots: new PageSnapshots(),
    requestedViewports: new Map<string, Viewport>(), artifacts: new BrowserArtifacts(artifactsDirectory),
    screenshotFailures: new Map<string, { attempts: number; elapsedMs: number; firstFailureAt: number }>(),
  };
}

export function createCardbushChromeServer(options: { connector?: typeof requestChromeConnector; artifactsDirectory?: string; browserConfigPath?: string; state?: ReturnType<typeof createBrowserUseState> } = {}): McpServer {
  const server = new McpServer({
    name: 'browser_use',
    version: '0.1.0',
  }, {
    instructions: [
      "Browser Use controls CardBush's integrated browser and the user's paired Chrome or Edge on Windows 11. CardBush tabs do not need an extension or pairing.",
      'An @ CardBush browser reference identifies an exact integrated tab, not an interchangeable URL. The desktop binds that conversation to CardBush. Use list_pages, then a fresh snapshot; never substitute a Chrome/Edge page with the same URL. If the referenced tab is unavailable, report it and ask the user to select it again.',
      'Use list_browsers and select_browser when the user names a browser or profile. Otherwise use the conversation binding, including integrated pages returned by local child agents; if no binding exists, the configured default is bound on first use. Binding survives disconnects; never silently switch browsers or replay a failed mutation.',
      'For Chrome/Edge, each session is isolated in a visibly named tab group. For the integrated browser, controllable tabs are those explicitly referenced by the user, created in this conversation, or newly created by its verified local descendant tasks. Selecting a browser does not grant unrelated tabs. Use select_browser with connectionId cardbush to create integrated tabs.',
      'Use new_page to create a tab in the selected browser. For existing Chrome/Edge personal tabs, ask the user to copy them into the current session group from the extension popup.',
      'Call release_browser when browser work is complete; it detaches control and collapses external session groups without closing tabs.',
      'For visual verification use take_screenshot (viewport/selector supported) or export_image; images are attached to the model and saved automatically. Do not trigger a browser download or open a popup merely to inspect an image.',
      'Tracked file downloads (download_file/download_status) are currently supported only in Chrome/Edge. Integrated tabs return an explicit unsupported error, never redirect to another browser. Reuse pending download taskIds instead of starting repeated downloads.',
      'take_snapshot returns a bounded page of accessibility text only once, with a nextCursor when more is available. Prefer rootUid/query/roles to narrow the page; continue only as needed. Click receipts confirm checked targeting and dispatched input, not that the page completed the requested operation; observe the relevant state afterwards.',
    ].join(' '),
  });
  const { selectedPageIds, targetKeys, snapshots, requestedViewports, artifacts, screenshotFailures } = options.state ?? createBrowserUseState(options.artifactsDirectory);
  const viewportKey = (context: ToolContext, tabId: number) => JSON.stringify([scopeFromContext(context).id, tabId]);
  const clearScreenshotFailures = (scopeId: string, tabId?: unknown) => {
    for (const key of screenshotFailures.keys()) {
      if (tabId !== undefined ? key === JSON.stringify([scopeId, tabId]) : key.startsWith(`[${JSON.stringify(scopeId)},`)) screenshotFailures.delete(key);
    }
  };

  const request = async (
    method: string,
    params: Record<string, unknown>,
    context: ToolContext,
    timeoutMs?: number,
    onDiagnostics?: (diagnostics: ChromeConnectorDiagnostics) => void,
  ) => {
    const scope = scopeFromContext(context);
    const result = await (options.connector ?? requestChromeConnector)(method, {
      ...params,
      ...(typeof params.tabId === 'number' && targetKeys.has(JSON.stringify([scope.id, params.tabId]))
        ? { expectedTargetKey: targetKeys.get(JSON.stringify([scope.id, params.tabId])) } : {}),
      scopeId: scope.id,
      scopeTitle: scope.title,
    }, {
      signal: context.mcpReq.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(onDiagnostics ? { onDiagnostics } : {}),
    }).catch(error => {
      if (method.startsWith('downloads.') && error instanceof ChromeConnectorError && error.code === 'unsupported_method') {
        throw new ChromeConnectorError('extension_update_required',
          'Reload CardBush Browser Use 1.2.0 or later in chrome://extensions or edge://extensions to enable tracked downloads. Do not fall back to repeated download clicks. Screenshots and export_image do not require browser downloads.');
      }
      throw error;
    });
    if (['tabs.navigate', 'tabs.close', 'debugger.detachScope'].includes(method)) clearScreenshotFailures(scope.id, params.tabId);
    if (['tabs.navigate', 'tabs.close', 'debugger.detachScope'].includes(method)) snapshots.clear(scope.id, params.tabId);
    if (method === 'tabs.close') requestedViewports.delete(JSON.stringify([scope.id, params.tabId]));
    if (method === 'debugger.detachScope') for (const key of requestedViewports.keys()) {
      if (key.startsWith(`[${JSON.stringify(scope.id)},`)) requestedViewports.delete(key);
    }
    return result;
  };

  const commandFor = (target: number, context: ToolContext) => (command: string, commandParams: Record<string, unknown> = {}) =>
    request('debugger.command', { tabId: target, command, commandParams }, context);
  const imageResult = async (context: ToolContext, image: { data: string; mimeType: string }, details: Record<string, unknown> = {}) => {
    const saved = await artifacts.image(scopeFromContext(context).id, image, context.mcpReq.signal);
    return { text: `Image attached and saved (${saved.width} × ${saved.height}). No browser download is needed.`, image: saved.image,
      structured: { ...details, width: saved.width, height: saved.height, bytes: saved.artifact.size, path: saved.artifact.path, artifacts: [saved.artifact] } };
  };

  const pages = async (context: ToolContext): Promise<BrowserPage[]> => {
    const result = await request('tabs.list', {}, context);
    return Array.isArray(result) ? result.flatMap((item) => {
      const value = record(item);
      const id = integer(value.id);
      if (id != null && typeof value.targetKey === 'string') targetKeys.set(JSON.stringify([scopeFromContext(context).id, id]), value.targetKey);
      return id == null ? [] : [{
        id,
        title: string(value.title),
        url: string(value.url),
        active: value.active === true,
        ...(value.selected === true ? { selected: true } : {}),
        ...(typeof value.browser === 'string' ? { browser: value.browser } : {}),
        ...(typeof value.targetKey === 'string' ? { targetKey: value.targetKey } : {}),
      }];
    }) : [];
  };

  const pageId = async (context: ToolContext): Promise<number> => {
    const scope = scopeFromContext(context);
    const listed = await pages(context);
    const selectedPageId = selectedPageIds.get(scope.id);
    const explicit = listed.find(page => page.selected);
    if (explicit) { selectedPageIds.set(scope.id, explicit.id); return explicit.id; }
    if (selectedPageId != null && listed.some((page) => page.id === selectedPageId)) {
      return selectedPageId;
    }
    const selected = listed.find((page) => page.active) ?? listed[0];
    if (!selected) {
      throw new ChromeConnectorError(
        'browser_page_missing',
        'This CardBush session has no isolated browser tabs. Open one with new_page or copy an existing tab from the extension popup.',
      );
    }
    selectedPageIds.set(scope.id, selected.id);
    return selected.id;
  };

  server.registerTool('list_browsers', toolDefinition(
    'List Browser Use connections',
    'Discover browsers available for web search, internet research and reading websites. List the CardBush integrated browser and paired Chrome/Edge connections, online state, default and this conversation’s selection. No personal tabs or credentials are returned. CardBush needs no pairing.',
    z.object({}), true,
  ), async (_input, context) => withToolResult(async () => {
    const result = record(await request('browser.list', {}, context));
    return { text: JSON.stringify(result), structured: result };
  }));
  server.registerTool('select_browser', toolDefinition(
    'Select Browser Use connection',
    'Explicitly bind this session to a connected browser/profile id from list_browsers. Switching releases the old session group first; a failed release leaves the binding unchanged. Take a fresh snapshot after switching; old tab and element ids must not be reused.',
    z.object({ connectionId: z.union([z.literal('cardbush'), z.string().regex(/^[a-f0-9]{32}$/)]) }), false,
  ), async (input, context) => withToolResult(async () => {
    const result = record(await request('browser.select', input, context));
    const scopeId = scopeFromContext(context).id;
    selectedPageIds.delete(scopeId); clearScreenshotFailures(scopeId);
    snapshots.clear(scopeId);
    for (const key of targetKeys.keys()) if (key.startsWith(`[${JSON.stringify(scopeId)},`)) targetKeys.delete(key);
    for (const key of requestedViewports.keys()) if (key.startsWith(`[${JSON.stringify(scopeId)},`)) requestedViewports.delete(key);
    return { text: 'Browser selected. Use list_pages or new_page, then take a fresh snapshot.', structured: result };
  }));

  server.registerTool('list_pages', toolDefinition(
    'List browser pages',
    'List controllable tabs in the selected browser. An @ CardBush reference binds the exact integrated tab; its numeric page id and browser identity are returned here. Do not substitute another browser with the same URL. Chrome/Edge shows only the current session group; personal tabs require extension consent. Closed or unavailable targets require explicit re-selection, never an automatic fallback.',
    z.object({}),
    true,
  ), async (_input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const listed = await pages(context);
    let selectedPageId = listed.find(page => page.selected)?.id ?? selectedPageIds.get(scope.id);
    if (selectedPageId == null || !listed.some((page) => page.id === selectedPageId)) {
      selectedPageId = listed.find((page) => page.active)?.id ?? listed[0]?.id;
      if (selectedPageId == null) selectedPageIds.delete(scope.id);
      else selectedPageIds.set(scope.id, selectedPageId);
    }
    return {
      text: listed.length > 0
        ? listed.map((page) => `${page.id === selectedPageId ? '*' : ' '} [${page.id}] ${page.browser === 'cardbush' ? '[CardBush] ' : ''}${page.title || '(untitled)'} — ${page.url}`).join('\n')
        : 'This CardBush session has no isolated browser tabs. Use new_page, or copy an existing tab into the session group from the extension popup.',
      structured: { pages: listed, selectedPageId },
    };
  }));

  server.registerTool('select_page', toolDefinition(
    'Select browser page',
    'Select and focus a browser tab by the numeric id returned by list_pages.',
    z.object({ pageId: z.number().int().nonnegative() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const result = record(await request('tabs.activate', { tabId: input.pageId }, context));
    selectedPageIds.set(scope.id, input.pageId);
    return { text: `Selected browser tab ${input.pageId}: ${string(result.title)}`, structured: result };
  }));

  server.registerTool('new_page', toolDefinition(
    'Open browser page',
    'Open a website in the selected browser, scoped to this conversation. For web search, current news or internet research, pass a search-engine URL with the query, then read results with take_snapshot. CardBush opens a visible integrated tab; Chrome/Edge uses the session group. Omit url for a blank new tab; otherwise pass an HTTP(S) URL.',
    z.object({ url: z.string().url().optional() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const url = input.url ?? DEFAULT_BROWSER_START_PAGE;
    const result = record(await request('tabs.create', { url }, context));
    const selectedPageId = integer(result.id);
    if (selectedPageId != null) selectedPageIds.set(scope.id, selectedPageId);
    return { text: `Opened browser tab ${selectedPageId ?? ''}: ${string(result.url)}`, structured: result };
  }));

  server.registerTool('close_page', toolDefinition(
    'Close browser page',
    'Close the selected browser tab, or a tab specified by pageId.',
    z.object({ pageId: z.number().int().nonnegative().optional() }),
    false,
    true,
  ), async (input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const target = input.pageId ?? await pageId(context);
    const result = record(await request('tabs.close', { tabId: target }, context));
    if (selectedPageIds.get(scope.id) === target) selectedPageIds.delete(scope.id);
    return { text: `Closed browser tab ${target}.`, structured: result };
  }));

  server.registerTool('navigate_page', toolDefinition(
    'Navigate browser page',
    'Navigate, reload, go back, or go forward in the selected browser tab.',
    z.object({
      type: z.enum(['url', 'back', 'forward', 'reload']).default('url'),
      url: z.string().optional(),
      ignoreCache: z.boolean().optional(),
    }).superRefine((input, issue) => {
      if (input.type === 'url' && !input.url?.trim()) {
        issue.addIssue({ code: 'custom', path: ['url'], message: 'url is required when type is url.' });
      }
    }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const result = record(await request('tabs.navigate', {
      tabId: target,
      action: input.type,
      ...(input.url ? { url: input.url } : {}),
      ignoreCache: input.ignoreCache === true,
    }, context));
    return { text: `browser tab ${target} navigated to ${string(result.url) || input.type}.`, structured: result };
  }));

  server.registerTool('take_snapshot', toolDefinition(
    'Take page snapshot',
    'Read webpage text, links and web search results as a bounded accessibility snapshot (default 60 rows, about 7000 escaped characters). Use returned uids with click/fill/hover. Narrow with rootUid, query, or roles. Continue with cursor and optional limit; a cursor reads the same captured snapshot for up to 3 minutes, not live updates. Navigation or a fresh snapshot invalidates it. Long fields are marked previews; use rootUid with fullText:true to read their text in chunks with offsets, then continue the cursor. Page text appears only in content; structuredContent contains pagination metadata.',
    snapshotSchema,
    true,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    return snapshots.read(commandFor(target, context), scopeFromContext(context).id, target, input);
  }));

  server.registerTool('click', toolDefinition(
    'Click page element',
    'Send a real mouse click to a uid from take_snapshot after checking visible area, enabled state, and actual hit target, including after hover. A zero-area control may use its explicitly associated visible label. Covered or stale targets return an error; no JavaScript click or Enter fallback is used. input_dispatched does not prove submission/navigation/task completion: observe the resulting page state before continuing or retrying.',
    z.object({ uid: z.string().regex(/^cb_\d+$/), doubleClick: z.boolean().optional() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const result = await dispatchPointer(commandFor(target, context), input.uid, 'click', input.doubleClick);
    return {
      text: `Click input dispatched to ${input.uid}${result.target === 'associated_label' ? ` via associated label ${result.targetUid}` : ''}. Hit target checked; page outcome not verified. Observe the page to confirm the intended result.`,
      structured: { pageId: target, ...result },
    };
  }));

  server.registerTool('fill', toolDefinition(
    'Fill page element',
    'Replace the value of an input, textarea, or editable element identified by uid.',
    z.object({ uid: z.string().regex(/^cb_\d+$/), value: z.string() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const result = await callOnNode(target, input.uid, [input.value], `function(value) {
      this.scrollIntoView({ block: 'center', inline: 'center' });
      this.focus?.();
      if (this.isContentEditable) this.textContent = value;
      else {
        const prototype = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(this, value); else this.value = value;
      }
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { tag: this.tagName, value: this.value ?? this.textContent };
    }`, context, request);
    return { text: `Filled ${input.uid}.`, structured: record(result) };
  }));

  server.registerTool('type_text', toolDefinition(
    'Type text in page',
    'Insert text at the currently focused element, optionally focusing an element uid first.',
    z.object({ text: z.string(), uid: z.string().regex(/^cb_\d+$/).optional() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    if (input.uid) {
      await callOnNode(target, input.uid, [], `function() { this.scrollIntoView({ block: 'center' }); this.focus(); }`, context, request);
    }
    await request('debugger.command', {
      tabId: target,
      command: 'Input.insertText',
      commandParams: { text: input.text },
    }, context);
    return { text: `Typed ${input.text.length} characters.`, structured: { pageId: target, length: input.text.length } };
  }));

  server.registerTool('press_key', toolDefinition(
    'Press key in page',
    'Dispatch a keyboard key to the selected browser tab, such as Enter, Tab, Escape, ArrowDown, or a single character.',
    z.object({ key: z.string().min(1).max(40) }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const key = keyboardDescriptor(input.key);
    await request('debugger.command', {
      tabId: target,
      command: 'Input.dispatchKeyEvent',
      commandParams: { type: 'keyDown', ...key },
    }, context);
    await request('debugger.command', {
      tabId: target,
      command: 'Input.dispatchKeyEvent',
      commandParams: { type: 'keyUp', ...key },
    }, context);
    return { text: `Pressed ${input.key}.`, structured: { pageId: target, key: input.key } };
  }));

  server.registerTool('hover', toolDefinition(
    'Hover page element',
    'Move the virtual mouse over an element identified by uid.',
    z.object({ uid: z.string().regex(/^cb_\d+$/) }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const result = await dispatchPointer(commandFor(target, context), input.uid, 'hover');
    return { text: `Pointer moved to ${input.uid}; page outcome not verified.`, structured: { pageId: target, ...result } };
  }));

  server.registerTool('resize_page', toolDefinition(
    'Set page viewport',
    'Set this session tab’s virtual viewport without resizing the user’s browser window. It survives navigation and is cleared on release. Explicit small viewports are preserved for responsive tests.',
    viewportSchema, false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    await setViewport(commandFor(target, context), input);
    requestedViewports.set(viewportKey(context, target), input);
    return { text: `Page viewport set to ${input.width} × ${input.height}.`, structured: { pageId: target, ...input } };
  }));

  server.registerTool('take_screenshot', toolDefinition(
    'Take page screenshot',
    'Capture a page or CSS selector as an attached image and automatically saved artifact. Supply viewport for a specific layout. An accidental tiny viewport is repaired once unless autoViewport=false or resize_page explicitly set it. fullPage captures document bounds; it does not choose the layout width. Never download an image just to inspect it.',
    z.object({ format: z.enum(['png', 'jpeg']).default('png'), quality: z.number().int().min(1).max(100).optional(), fullPage: z.boolean().optional(),
      viewport: viewportSchema.optional(), autoViewport: z.boolean().default(true), selector: z.string().min(1).max(2000).optional() })
      .refine(input => !(input.fullPage && input.selector), 'Choose fullPage or selector, not both.'),
    true,
  ), async (input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const startedAt = Date.now();
    let target: number | undefined;
    let pageSelectionMs: number | undefined;
    let connector: ChromeConnectorDiagnostics | undefined;
    try {
      target = await pageId(context);
      pageSelectionMs = Date.now() - startedAt;
      const command = commandFor(target, context);
      const viewport = await prepareCapture(command, input.viewport ?? requestedViewports.get(viewportKey(context, target)), input.autoViewport !== false);
      const clip = await captureClip(command, input.fullPage, input.selector, viewport.deviceScaleFactor);
      const result = record(await request('debugger.command', {
        tabId: target,
        command: 'Page.captureScreenshot',
        commandParams: {
          format: input.format,
          captureBeyondViewport: !!clip,
          fromSurface: true,
          ...(clip ? { clip } : {}),
          ...(input.format === 'jpeg' && input.quality ? { quality: input.quality } : {}),
        },
      }, context, undefined, value => { connector = value; }));
      const data = string(result.data);
      if (!data) throw new ChromeConnectorError('screenshot_empty', 'The browser returned an empty screenshot.');
      clearScreenshotFailures(scope.id, target);
      screenshotFailures.delete(JSON.stringify([scope.id, 'page_selection']));
      return imageResult(context, { data, mimeType: input.format === 'jpeg' ? 'image/jpeg' : 'image/png' }, {
        pageId: target, format: input.format, viewport, ...(clip ? { clip } : {}),
        ...(clip && clip.scale < 1 ? { notice: 'Large page scaled for capture. Use selector to inspect details at full resolution.' } : {}),
        timings: { elapsedMs: Date.now() - startedAt, pageSelectionMs, connector },
      });
    } catch (error) {
      if (context.mcpReq.signal.aborted || error instanceof Error && error.name === 'AbortError') throw error;
      const key = JSON.stringify([scope.id, target ?? 'page_selection']);
      const previous = screenshotFailures.get(key);
      const failure = { attempts: (previous?.attempts ?? 0) + 1,
        elapsedMs: (previous?.elapsedMs ?? 0) + Date.now() - startedAt,
        firstFailureAt: previous?.firstFailureAt ?? startedAt };
      screenshotFailures.set(key, failure);
      // Bound diagnostic history, never the number of permitted tool calls.
      if (screenshotFailures.size > 256) screenshotFailures.delete(screenshotFailures.keys().next().value!);
      throw new ChromeConnectorError(error instanceof ChromeConnectorError ? error.code : 'browser_connector_failed',
        errorMessage(error), {
          ...(error instanceof ChromeConnectorError ? error.details : {}),
          pageId: target, consecutiveFailures: failure.attempts, cumulativeAttemptMs: failure.elapsedMs,
          failureWindowMs: Date.now() - failure.firstFailureAt,
          timings: { elapsedMs: Date.now() - startedAt, pageSelectionMs, connector },
          ...(failure.attempts >= 2 ? { recovery: 'Repeated screenshot failures on this page. Changing PNG/JPEG quality alone does not recover a pending command. Check the reported stage; release/reconnect if the debugger is stuck, or use a different preview route. Preserve the existing artifact; do not reconstruct image Base64 in tool arguments.' } : {}),
        });
    }
  }));

  server.registerTool('export_image', toolDefinition(
    'Export browser image',
    'Return an attached image and saved local artifact without any Save As dialog. Use selector for a canvas, SVG or rendered element; or expression returning a data:image/png/jpeg/webp URL or {data,mimeType}. JSON-stringified {url:dataURL} is also accepted. Do not click a download link or return Base64 as text.',
    z.object({ selector: z.string().min(1).max(2000).optional(), expression: z.string().min(1).optional(),
      format: z.enum(['png', 'jpeg', 'webp']).default('png'), quality: z.number().int().min(1).max(100).optional(), viewport: viewportSchema.optional() })
      .refine(input => !!input.selector !== !!input.expression, 'Supply exactly one of selector or expression.'), false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context), command = commandFor(target, context);
    const viewport = await prepareCapture(command, input.viewport ?? requestedViewports.get(viewportKey(context, target)));
    let image;
    if (input.expression) image = exportedImage(await evaluate(command, input.expression));
    else if (await evaluate(command, `document.querySelector(${JSON.stringify(input.selector)}) instanceof HTMLCanvasElement`)) {
      image = exportedImage(await evaluate(command, canvasExportExpression(input.selector!, input.format, input.quality)));
    } else {
      const clip = await captureClip(command, false, input.selector, viewport.deviceScaleFactor);
      const result = record(await command('Page.captureScreenshot', { format: input.format, clip, captureBeyondViewport: true, fromSurface: true,
        ...(input.format === 'jpeg' && input.quality ? { quality: input.quality } : {}) }));
      image = { data: string(result.data), mimeType: `image/${input.format}` };
    }
    return imageResult(context, image, { pageId: target, viewport });
  }));

  server.registerTool('evaluate_script', toolDefinition(
    'Evaluate JavaScript',
    'Evaluate JavaScript. By default, image data URLs and {url:dataURL}/{data,mimeType} (including JSON-stringified results) become attached, saved images. Use resultType=image to require an image or json for literal JSON. Prefer export_image for canvas/SVG and download_file for files; a.click() does not confirm download completion.',
    z.object({ expression: z.string().min(1), resultType: z.enum(['auto', 'json', 'image']).default('auto') }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const result = record(await request('debugger.command', {
      tabId: target,
      command: 'Runtime.evaluate',
      commandParams: {
        expression: input.expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
    }, context));
    if (result.exceptionDetails) {
      throw new ChromeConnectorError('javascript_exception', JSON.stringify(result.exceptionDetails));
    }
    const remote = record(result.result);
    const value = 'value' in remote ? remote.value : remote.description;
    if (input.resultType !== 'json') {
      let image;
      try { image = exportedImage(value); } catch (error) { if (input.resultType === 'image') throw error; }
      if (image) return imageResult(context, image, { pageId: target });
    }
    return { text: JSON.stringify(value, null, 2) ?? 'undefined', structured: { pageId: target, value } };
  }));

  const downloadResult = async (context: ToolContext, result: Record<string, unknown>) => {
    let artifact: BrowserArtifact | undefined;
    if (result.state === 'complete' && typeof result.filename === 'string') {
      try { artifact = await artifacts.download(scopeFromContext(context).id, string(result.taskId), result.filename); }
      catch (error) {
        throw new ChromeConnectorError('download_artifact_unavailable',
          'The browser completed the download, but its local artifact could not be copied. Keep the existing taskId; do not start another download.',
          { taskId: result.taskId, state: 'complete', filename: result.filename, reason: errorMessage(error) });
      }
    }
    return { text: artifact ? `Download complete. Saved to ${artifact.path}`
      : `Download ${string(result.taskId)}: ${string(result.state)}. ${result.state === 'interrupted' || result.state === 'cancelled'
        ? 'The download stopped. Do not automatically start it again.' : 'Use download_status with this taskId; do not create another download.'}`,
      structured: { ...result, ...(artifact ? { path: artifact.path, artifacts: [artifact] } : {}) } };
  };
  server.registerTool('download_file', toolDefinition(
    'Download file',
    'Start a tracked download without a Save As dialog, scoped to this session. Repeating the same URL/filename in a turn reuses its task, including pending or cancelled tasks. Supply a new requestKey only for an intentionally new download. Poll download_status; only state=complete confirms a usable file. For visual checks use export_image or take_screenshot instead.',
    z.object({ url: z.string().url(), filename: z.string().min(1).max(180).optional(), requestKey: z.string().min(1).max(160).optional() }), false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const requestKey = input.requestKey ?? digest(JSON.stringify([context.mcpReq._meta?.cardbush_turn_id ?? '', input.url, input.filename ?? '']));
    const result = record(await request('downloads.start', { tabId: target, url: input.url, filename: input.filename, requestKey }, context));
    return downloadResult(context, result);
  }));
  server.registerTool('download_status', toolDefinition(
    'Read download status',
    'Read or briefly wait for this session’s download task. complete includes a saved artifact; starting/in_progress are pending, not failures. Do not infer completion from a .tmp file or PNG signature. Waiting never starts another download.',
    z.object({ taskId: z.string().min(1), waitMs: z.number().int().min(0).max(20_000).default(0) }), true,
  ), async (input, context) => withToolResult(async () => downloadResult(context,
    record(await request('downloads.status', { taskId: input.taskId, waitMs: input.waitMs }, context)))));
  server.registerTool('cancel_download', toolDefinition(
    'Cancel download', 'Cancel only a tracked download belonging to the current session. A cancelled task is not automatically restarted.',
    z.object({ taskId: z.string().min(1) }), false,
  ), async (input, context) => withToolResult(async () => downloadResult(context,
    record(await request('downloads.cancel', { taskId: input.taskId }, context)))));

  server.registerTool('wait_for', toolDefinition(
    'Wait for page text',
    'Wait until text appears in the selected browser tab.',
    z.object({ text: z.string().min(1), timeout: z.number().int().min(100).max(30_000).default(10_000) }),
    true,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const expression = `(async () => {
      const expected = ${JSON.stringify(input.text)};
      const deadline = Date.now() + ${input.timeout};
      while (Date.now() < deadline) {
        if ((document.body?.innerText || '').includes(expected)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Timed out waiting for text: ' + expected);
    })()`;
    const result = record(await request('debugger.command', {
      tabId: target,
      command: 'Runtime.evaluate',
      commandParams: { expression, awaitPromise: true, returnByValue: true },
    }, context, input.timeout + 5_000));
    if (result.exceptionDetails) throw new ChromeConnectorError('wait_for_timeout', `Timed out waiting for: ${input.text}`);
    return { text: `Found text: ${input.text}`, structured: { pageId: target, found: true, text: input.text } };
  }));

  server.registerTool('release_browser', toolDefinition(
    'Release browser',
    'Detach CardBush from the current session tabs and collapse its browser groups after browser work is complete.',
    z.object({}),
    false,
  ), async (_input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const result = record(await request('debugger.detachScope', {}, context));
    selectedPageIds.delete(scope.id);
    return { text: 'Released this CardBush session\'s browser tabs.', structured: result };
  }));

  return server;
}

function scopeFromContext(context: ToolContext): BrowserScope {
  const metadata = context.mcpReq._meta ?? {};
  const id = string(metadata.cardbush_session_id).slice(0, 160);
  if (!id) {
    throw new ChromeConnectorError(
      'browser_scope_missing',
      'CardBush did not provide a browser session scope. Browser control was denied to protect personal tabs.',
    );
  }
  return {
    id,
    title: string(metadata.cardbush_session_title).slice(0, 80) || `Session ${id.slice(0, 8)}`,
  };
}

function toolDefinition<T extends z.ZodType>(
  title: string,
  description: string,
  inputSchema: T,
  readOnly: boolean,
  destructive = false,
) {
  return {
    title,
    description,
    inputSchema,
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: readOnly,
      openWorldHint: true,
    },
    _meta: { 'cardbush/plugin_id': 'chrome' },
  };
}

async function withToolResult(operation: () => Promise<{
  text: string;
  structured: unknown;
  image?: { data: string; mimeType: string };
}>) {
  try {
    const result = await operation();
    return {
      content: [
        { type: 'text' as const, text: result.text },
        ...(result.image ? [{ type: 'image' as const, ...result.image, annotations: { audience: ['assistant' as const] } }] : []),
      ],
      structuredContent: result.structured,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const normalized = error instanceof ChromeConnectorError
      ? { code: error.code, message: error.message, details: error.details }
      : { code: 'browser_connector_failed', message: errorMessage(error), details: {} };
    return {
      content: [{ type: 'text' as const, text: normalized.message }],
      structuredContent: { error: normalized },
      isError: true,
    };
  }
}

async function resolveObjectId(
  tabId: number,
  uid: string,
  context: ToolContext,
  request: (method: string, params: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
): Promise<string> {
  const backendNodeId = Number(uid.slice(3));
  const result = record(await request('debugger.command', {
    tabId,
    command: 'DOM.resolveNode',
    commandParams: { backendNodeId },
  }, context));
  const objectId = string(record(result.object).objectId);
  if (!objectId) throw new ChromeConnectorError('element_not_found', `The page element ${uid} is no longer available. Take a new snapshot.`);
  return objectId;
}

async function callOnNode(
  tabId: number,
  uid: string,
  arguments_: unknown[],
  functionDeclaration: string,
  context: ToolContext,
  request: (method: string, params: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
): Promise<unknown> {
  const objectId = await resolveObjectId(tabId, uid, context, request);
  const result = record(await request('debugger.command', {
    tabId,
    command: 'Runtime.callFunctionOn',
    commandParams: {
      objectId,
      functionDeclaration,
      arguments: arguments_.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
  }, context));
  if (result.exceptionDetails) throw new ChromeConnectorError('page_action_failed', JSON.stringify(result.exceptionDetails));
  return record(result.result).value;
}

function keyboardDescriptor(input: string): Record<string, unknown> {
  const aliases: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  };
  if (aliases[input]) return aliases[input];
  const key = [...input][0] ?? input;
  return { key, text: key, unmodifiedText: key };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function integer(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { ChromeConnectorError, requestChromeConnector } from './bridgeClient.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void serveStdio(() => createCardbushChromeServer());
  console.error('browser_use MCP server running on stdio');
}
