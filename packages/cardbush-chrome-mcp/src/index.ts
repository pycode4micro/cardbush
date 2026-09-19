#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { BrowserConfigStore } from '@cardbush/product-host';
import { DEFAULT_BROWSER_START_PAGE } from '@cardbush/bush-protocol';
import { BrowserArtifacts, digest, exportedImage, type BrowserArtifact } from './imageArtifacts.js';
import { prepareCapture, captureClip, setViewport, evaluate, canvasExportExpression, type Viewport } from './pageCapture.js';

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

export function createCardbushChromeServer(options: { connector?: typeof requestChromeConnector; artifactsDirectory?: string; browserConfigPath?: string } = {}): McpServer {
  const server = new McpServer({
    name: 'cardbush_chrome',
    version: '0.1.0',
  }, {
    instructions: [
      "Controls the user's existing Chrome tabs through the CardBush Browser Connector.",
      'Each CardBush session is isolated in its own visibly named Chrome tab group. Only tabs in the current session group are visible or controllable.',
      'Use new_page to create an isolated tab. To use an existing personal tab, ask the user to copy it into the current CardBush group from the extension popup.',
      'Call release_browser when browser work is complete; it detaches and collapses only the current session groups.',
      'For visual verification use take_screenshot (viewport/selector supported) or export_image; images are attached to the model and saved automatically. Do not trigger a browser download or open a popup merely to inspect an image.',
      'For actual file downloads use download_file and then download_status with its taskId. A pending task is not a failed download; reuse it instead of clicking or starting another download.',
    ].join(' '),
  });
  const selectedPageIds = new Map<string, number>();
  const requestedViewports = new Map<string, Viewport>();
  const artifacts = new BrowserArtifacts(options.artifactsDirectory);
  const viewportKey = (context: ToolContext, tabId: number) => JSON.stringify([scopeFromContext(context).id, tabId]);
  const screenshotFailures = new Map<string, { attempts: number; elapsedMs: number; firstFailureAt: number }>();
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
      scopeId: scope.id,
      scopeTitle: scope.title,
    }, {
      signal: context.mcpReq.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(onDiagnostics ? { onDiagnostics } : {}),
    }).catch(error => {
      if (method.startsWith('downloads.') && error instanceof ChromeConnectorError && error.code === 'unsupported_method') {
        throw new ChromeConnectorError('extension_update_required',
          'Reload CardBush Browser Connector 1.0.2 or later in chrome://extensions to enable tracked downloads. Do not fall back to repeated download clicks. Screenshots and export_image do not require browser downloads.');
      }
      throw error;
    });
    if (['tabs.navigate', 'tabs.close', 'debugger.detachScope'].includes(method)) clearScreenshotFailures(scope.id, params.tabId);
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
      return id == null ? [] : [{
        id,
        title: string(value.title),
        url: string(value.url),
        active: value.active === true,
      }];
    }) : [];
  };

  const pageId = async (context: ToolContext): Promise<number> => {
    const scope = scopeFromContext(context);
    const listed = await pages(context);
    const selectedPageId = selectedPageIds.get(scope.id);
    if (selectedPageId != null && listed.some((page) => page.id === selectedPageId)) {
      return selectedPageId;
    }
    const selected = listed.find((page) => page.active) ?? listed[0];
    if (!selected) {
      throw new ChromeConnectorError(
        'chrome_page_missing',
        'This CardBush session has no isolated Chrome tabs. Open one with new_page or copy an existing tab from the extension popup.',
      );
    }
    selectedPageIds.set(scope.id, selected.id);
    return selected.id;
  };

  server.registerTool('list_pages', toolDefinition(
    'List Chrome pages',
    'List only tabs isolated in the current CardBush session group. Personal Chrome tabs and other CardBush sessions are hidden.',
    z.object({}),
    true,
  ), async (_input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const listed = await pages(context);
    let selectedPageId = selectedPageIds.get(scope.id);
    if (selectedPageId == null || !listed.some((page) => page.id === selectedPageId)) {
      selectedPageId = listed.find((page) => page.active)?.id ?? listed[0]?.id;
      if (selectedPageId == null) selectedPageIds.delete(scope.id);
      else selectedPageIds.set(scope.id, selectedPageId);
    }
    return {
      text: listed.length > 0
        ? listed.map((page) => `${page.id === selectedPageId ? '*' : ' '} [${page.id}] ${page.title || '(untitled)'} — ${page.url}`).join('\n')
        : 'This CardBush session has no isolated Chrome tabs. Use new_page, or copy an existing tab into the session group from the extension popup.',
      structured: { pages: listed, selectedPageId },
    };
  }));

  server.registerTool('select_page', toolDefinition(
    'Select Chrome page',
    'Select and focus a Chrome tab by the numeric id returned by list_pages.',
    z.object({ pageId: z.number().int().nonnegative() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const result = record(await request('tabs.activate', { tabId: input.pageId }, context));
    selectedPageIds.set(scope.id, input.pageId);
    return { text: `Selected Chrome tab ${input.pageId}: ${string(result.title)}`, structured: result };
  }));

  server.registerTool('new_page', toolDefinition(
    'Open Chrome page',
    'Open a new tab in a visibly named group isolated to the current CardBush session. Omit url to use the start page in CardBush browser settings (initially https://www.google.com/).',
    z.object({ url: z.string().url().optional() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const settingsPath = options.browserConfigPath ?? process.env.CARDBUSH_BROWSER_CONFIG_PATH?.trim();
    const url = input.url ?? (settingsPath ? (await new BrowserConfigStore(settingsPath).read()).startPage : DEFAULT_BROWSER_START_PAGE);
    const result = record(await request('tabs.create', { url }, context));
    const selectedPageId = integer(result.id);
    if (selectedPageId != null) selectedPageIds.set(scope.id, selectedPageId);
    return { text: `Opened Chrome tab ${selectedPageId ?? ''}: ${string(result.url)}`, structured: result };
  }));

  server.registerTool('close_page', toolDefinition(
    'Close Chrome page',
    'Close the selected Chrome tab, or a tab specified by pageId.',
    z.object({ pageId: z.number().int().nonnegative().optional() }),
    false,
    true,
  ), async (input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const target = input.pageId ?? await pageId(context);
    const result = record(await request('tabs.close', { tabId: target }, context));
    if (selectedPageIds.get(scope.id) === target) selectedPageIds.delete(scope.id);
    return { text: `Closed Chrome tab ${target}.`, structured: result };
  }));

  server.registerTool('navigate_page', toolDefinition(
    'Navigate Chrome page',
    'Navigate, reload, go back, or go forward in the selected Chrome tab.',
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
    return { text: `Chrome tab ${target} navigated to ${string(result.url) || input.type}.`, structured: result };
  }));

  server.registerTool('take_snapshot', toolDefinition(
    'Take page snapshot',
    'Return an accessibility snapshot of the selected Chrome tab. Use uid values from this output with click, fill, and hover.',
    z.object({}),
    true,
  ), async (_input, context) => withToolResult(async () => {
    const target = await pageId(context);
    await request('debugger.command', {
      tabId: target,
      command: 'Accessibility.enable',
      commandParams: {},
    }, context);
    const result = record(await request('debugger.command', {
      tabId: target,
      command: 'Accessibility.getFullAXTree',
      commandParams: {},
    }, context));
    const nodes = Array.isArray(result.nodes) ? result.nodes : [];
    const lines = nodes.flatMap((candidate) => snapshotLine(candidate));
    return {
      text: lines.join('\n') || 'The page accessibility tree is empty.',
      structured: { pageId: target, nodeCount: nodes.length, snapshot: lines },
    };
  }));

  server.registerTool('click', toolDefinition(
    'Click page element',
    'Click an element by uid from take_snapshot.',
    z.object({ uid: z.string().regex(/^cb_\d+$/), doubleClick: z.boolean().optional() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const point = await elementCenter(target, input.uid, context, request);
    await request('debugger.command', {
      tabId: target,
      command: 'Input.dispatchMouseEvent',
      commandParams: { type: 'mouseMoved', x: point.x, y: point.y },
    }, context);
    const clicks = input.doubleClick === true ? 2 : 1;
    for (let clickCount = 1; clickCount <= clicks; clickCount += 1) {
      await request('debugger.command', {
        tabId: target,
        command: 'Input.dispatchMouseEvent',
        commandParams: {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount,
        },
      }, context);
      await request('debugger.command', {
        tabId: target,
        command: 'Input.dispatchMouseEvent',
        commandParams: {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount,
        },
      }, context);
    }
    return {
      text: `Clicked ${input.uid}.`,
      structured: { pageId: target, uid: input.uid, x: point.x, y: point.y, clicks },
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
    'Dispatch a keyboard key to the selected Chrome tab, such as Enter, Tab, Escape, ArrowDown, or a single character.',
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
    const { x, y } = await elementCenter(target, input.uid, context, request);
    await request('debugger.command', {
      tabId: target,
      command: 'Input.dispatchMouseEvent',
      commandParams: { type: 'mouseMoved', x, y },
    }, context);
    return { text: `Hovered ${input.uid}.`, structured: { pageId: target, uid: input.uid, x, y } };
  }));

  server.registerTool('resize_page', toolDefinition(
    'Set page viewport',
    'Set this session tab’s virtual viewport without resizing the user’s Chrome window. It survives navigation and is cleared on release. Explicit small viewports are preserved for responsive tests.',
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
      if (!data) throw new ChromeConnectorError('screenshot_empty', 'Chrome returned an empty screenshot.');
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
      throw new ChromeConnectorError(error instanceof ChromeConnectorError ? error.code : 'chrome_connector_failed',
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
          'Chrome completed the download, but its local artifact could not be copied. Keep the existing taskId; do not start another download.',
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
    'Wait until text appears in the selected Chrome tab.',
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
    'Release Chrome',
    'Detach CardBush from the current session tabs and collapse its Chrome groups after browser work is complete.',
    z.object({}),
    false,
  ), async (_input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const result = record(await request('debugger.detachScope', {}, context));
    selectedPageIds.delete(scope.id);
    return { text: 'Released this CardBush session\'s Chrome tabs.', structured: result };
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
      : { code: 'chrome_connector_failed', message: errorMessage(error), details: {} };
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

async function elementCenter(
  tabId: number,
  uid: string,
  context: ToolContext,
  request: (method: string, params: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
): Promise<{ x: number; y: number }> {
  const objectId = await resolveObjectId(tabId, uid, context, request);
  await request('debugger.command', {
    tabId,
    command: 'Runtime.callFunctionOn',
    commandParams: {
      objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', inline: 'center' });
      }`,
      returnByValue: true,
    },
  }, context);
  const model = record(await request('debugger.command', {
    tabId,
    command: 'DOM.getBoxModel',
    commandParams: { objectId },
  }, context));
  const candidate = record(model.model).content;
  const content = Array.isArray(candidate) ? candidate.map(Number) : [];
  if (content.length < 8 || content.slice(0, 8).some((value) => !Number.isFinite(value))) {
    throw new ChromeConnectorError('element_box_missing', `Unable to locate ${uid}.`);
  }
  return {
    x: (content[0] + content[2] + content[4] + content[6]) / 4,
    y: (content[1] + content[3] + content[5] + content[7]) / 4,
  };
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

function snapshotLine(value: unknown): string[] {
  const node = record(value);
  if (node.ignored === true) return [];
  const backendNodeId = integer(node.backendDOMNodeId);
  const role = string(record(node.role).value) || 'generic';
  const name = string(record(node.name).value);
  const description = string(record(node.description).value);
  const valueText = String(record(node.value).value ?? '').trim();
  const properties = Array.isArray(node.properties)
    ? node.properties.flatMap((candidate) => {
        const property = record(candidate);
        const propertyValue = record(property.value).value;
        return typeof propertyValue === 'boolean' && propertyValue
          ? [string(property.name)]
          : [];
      }).filter(Boolean)
    : [];
  return [[
    backendNodeId == null ? '' : `uid=cb_${backendNodeId}`,
    `role=${role}`,
    name ? `name=${JSON.stringify(name)}` : '',
    valueText ? `value=${JSON.stringify(valueText)}` : '',
    description ? `description=${JSON.stringify(description)}` : '',
    properties.length > 0 ? `state=${properties.join(',')}` : '',
  ].filter(Boolean).join(' ')];
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
  console.error('cardbush_chrome MCP server running on stdio');
}
