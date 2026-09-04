#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import {
  ChromeConnectorError,
  requestChromeConnector,
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

export function createCardbushChromeServer(): McpServer {
  const server = new McpServer({
    name: 'cardbush_chrome',
    version: '0.1.0',
  }, {
    instructions: [
      "Controls the user's existing Chrome tabs through the CardBush Browser Connector.",
      'Each CardBush session is isolated in its own visibly named Chrome tab group. Only tabs in the current session group are visible or controllable.',
      'Use new_page to create an isolated tab. To use an existing personal tab, ask the user to copy it into the current CardBush group from the extension popup.',
      'Call release_browser when browser work is complete; it detaches and collapses only the current session groups.',
    ].join(' '),
  });
  const selectedPageIds = new Map<string, number>();

  const request = (
    method: string,
    params: Record<string, unknown>,
    context: ToolContext,
    timeoutMs?: number,
  ) => {
    const scope = scopeFromContext(context);
    return requestChromeConnector(method, {
      ...params,
      scopeId: scope.id,
      scopeTitle: scope.title,
    }, {
      signal: context.mcpReq.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
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
    'Open a new tab in a visibly named group isolated to the current CardBush session.',
    z.object({ url: z.string().url().optional() }),
    false,
  ), async (input, context) => withToolResult(async () => {
    const scope = scopeFromContext(context);
    const result = record(await request('tabs.create', { url: input.url ?? 'about:blank' }, context));
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

  server.registerTool('take_screenshot', toolDefinition(
    'Take page screenshot',
    'Capture the selected Chrome tab as PNG or JPEG.',
    z.object({ format: z.enum(['png', 'jpeg']).default('png'), quality: z.number().int().min(1).max(100).optional(), fullPage: z.boolean().optional() }),
    true,
  ), async (input, context) => withToolResult(async () => {
    const target = await pageId(context);
    const result = record(await request('debugger.command', {
      tabId: target,
      command: 'Page.captureScreenshot',
      commandParams: {
        format: input.format,
        captureBeyondViewport: input.fullPage === true,
        fromSurface: true,
        ...(input.format === 'jpeg' && input.quality ? { quality: input.quality } : {}),
      },
    }, context));
    const data = string(result.data);
    if (!data) throw new ChromeConnectorError('screenshot_empty', 'Chrome returned an empty screenshot.');
    return {
      text: `Captured Chrome tab ${target}.`,
      structured: { pageId: target, format: input.format, bytes: Math.floor(data.length * 0.75) },
      image: { data, mimeType: input.format === 'jpeg' ? 'image/jpeg' : 'image/png' },
    };
  }));

  server.registerTool('evaluate_script', toolDefinition(
    'Evaluate JavaScript',
    'Evaluate a JavaScript expression in the selected Chrome tab and return its JSON-serializable value.',
    z.object({ expression: z.string().min(1) }),
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
    return { text: JSON.stringify(value, null, 2) ?? 'undefined', structured: { pageId: target, value } };
  }));

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
        ...(result.image ? [{ type: 'image' as const, ...result.image }] : []),
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
