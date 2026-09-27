import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';

import { executeComputerUse, type ComputerUseResult } from './computerUseRuntime.js';
import type { ComputerUsePluginConfig } from '../config.js';
import { computerUseFailure, formatComputerUseError } from './computerUseErrors.js';
import { failedComputerUseTimings } from './computerUseTimings.js';

const inputSchema = z.object({
  action: z.enum([
    'observe',
    'screenshot',
    'click',
    'invoke',
    'set_value',
    'type',
    'clipboard',
    'key',
    'scroll',
    'drag',
    'window',
    'open_app',
    'finish',
  ]),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  to_x: z.number().int().optional(),
  to_y: z.number().int().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clicks: z.number().int().min(1).max(5).optional(),
  state_id: z.string().trim().min(1).max(160).optional().describe(
    'One-use state identifier returned by a target-specific observe call. Required for every action against an existing window.',
  ),
  element_index: z.number().int().min(0).optional().describe(
    'Accessibility element index returned by observe. Check its supported_actions before choosing click, invoke, or set_value; Text or Value alone does not support semantic click.',
  ),
  value: z.string().max(8192).optional(),
  text: z.string().max(8192).optional().describe(
    'For type, line breaks send Enter and can submit. For clipboard, text is copied literally, without typing, pasting or sending. Use text OR files for clipboard.',
  ),
  files: z.array(z.string().min(1).max(32760)).min(1).max(64).optional().describe('For clipboard only: absolute paths of existing files on the Windows host. Sets a copy file list (CF_HDROP); does not paste or send.'),
  key: z.string().trim().min(1).max(64).optional(),
  keys: z.array(z.string().trim().min(1).max(64)).min(1).max(8).optional(),
  delta: z.number().int().min(-20).max(20).optional(),
  duration_ms: z.number().int().min(0).max(1500).optional(),
  steps: z.number().int().min(1).max(120).optional(),
  title_pattern: z.string().trim().max(512).optional().describe('Case-insensitive substring of the window title.'),
  hwnd: z.number().int().positive().optional().describe(
    'Exact top-level window handle returned by observe. For input actions, rejects the action if the visible target changed.',
  ),
  operation: z.enum([
    'activate',
    'focus',
    'minimize',
    'maximize',
    'restore',
    'close',
    'move',
    'resize',
  ]).optional(),
  app: z.string().trim().max(1024).optional().describe(
    'Application executable or process name, such as chrome, msedge, or code. Supported by open_app and window actions.',
  ),
  max_elements: z.number().int().min(20).max(300).optional().describe(
    'Maximum accessibility elements when include_text=true. Default 80, also bounded by response size. Focused controls, inputs and buttons come first; use element_query or element_offset if truncated.',
  ),
  element_query: z.object({
    name: z.string().trim().min(1).max(240).optional().describe('Case-insensitive substring of the accessible name.'),
    automation_id: z.string().trim().min(1).max(160).optional().describe('Case-insensitive exact automation ID.'),
    control_type: z.string().trim().min(1).max(80).optional().describe('Case-insensitive exact UIA type, such as Edit, Button or ComboBox.'),
    focused: z.boolean().optional(),
  }).refine((value) => Object.values(value).some((item) => item !== undefined), 'Provide at least one element filter.').optional().describe('Filter accessible controls before response truncation. Fields combine with AND. Requires include_text=true and a target window.'),
  element_offset: z.number().int().min(0).max(5000).optional().describe('Continue a truncated accessibility result using its next_offset and the same element_query. A fresh state_id and fresh indexes are issued on every observation.'),
  include_text: z.boolean().optional().describe('Include accessibility elements and supported_actions. Default false; enable for semantic actions or reading text.'),
  include_screenshot: z.boolean().optional().describe('Return the screenshot directly as an MCP image. Default true. If false, include_text must be true.'),
  region: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().positive(), height: z.number().int().positive() }).optional().describe('Crop the returned target-window screenshot. Values are in original window pixels. Input coordinates still use the full window; use the returned image origin and scale to map points.'),
  scale: z.number().int().min(1).max(3).optional().describe('Screenshot magnification, default 1. Use 2 for dense controls. Enlarging does not create more source detail.'),
  grid: z.boolean().optional().describe('Optional coordinate grid on the returned image, labelled in original window pixels. Default false.'),
  observe_after: z.boolean().optional().describe('Automatically return a fresh observation and one-use state after a window/input action. Default true. False requires an explicit observe before further input.'),
  settle_ms: z.number().int().min(0).max(1000).optional().describe('Bounded delay before the post-action observation. Default 120 ms. Does not assert application readiness.'),
}).superRefine((input, context) => {
  if (input.region || input.scale != null || input.grid != null) {
    if (input.hwnd == null || input.include_screenshot === false ||
        !['observe', 'screenshot', 'click', 'invoke', 'set_value', 'type', 'clipboard', 'key', 'scroll', 'drag', 'window'].includes(input.action) ||
        (!['observe', 'screenshot'].includes(input.action) && input.observe_after === false)) {
      context.addIssue({ code: 'custom', path: ['region'], message: 'Image options require an exact hwnd and a screenshot observation.' });
    }
  }
  if (input.action === 'clipboard') {
    if ((input.text != null) === (input.files != null)) context.addIssue({ code: 'custom', path: ['files'], message: 'clipboard requires exactly one of text or files.' });
  } else if (input.files != null) context.addIssue({ code: 'custom', path: ['files'], message: 'files is only supported by clipboard.' });
  if (input.element_query != null || input.element_offset != null) {
    if (input.include_text !== true || (input.hwnd == null && !input.app && !input.title_pattern)) {
      context.addIssue({ code: 'custom', path: ['element_query'], message: 'Element queries and pagination require include_text=true and a target window.' });
    }
  }
  if (input.include_screenshot === false && input.include_text !== true) {
    context.addIssue({ code: 'custom', path: ['include_text'], message: 'Enable include_text when omitting screenshots so the observation contains evidence.' });
  }
  const requireFields = (fields: Array<keyof typeof input>, message: string) => {
    for (const field of fields) {
      if (input[field] == null || input[field] === '') {
        context.addIssue({ code: 'custom', path: [field], message });
      }
    }
  };
  if (input.action === 'click') {
    if (input.element_index == null) {
      requireFields(['x', 'y'], 'click requires element_index or window-relative x and y.');
    } else {
      if (input.x != null || input.y != null) {
        context.addIssue({
          code: 'custom',
          path: ['element_index'],
          message: 'click accepts either element_index or coordinates, not both.',
        });
      }
      if ((input.button && input.button !== 'left') || (input.clicks != null && input.clicks !== 1)) {
        context.addIssue({
          code: 'custom',
          path: ['button'],
          message: 'Semantic element clicks perform the default action once. Use coordinates for another button or click count.',
        });
      }
    }
  }
  if (input.action === 'drag') {
    requireFields(['x', 'y', 'to_x', 'to_y'], 'drag requires x, y, to_x, and to_y.');
  }
  if (input.action === 'type' && input.text == null) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'type requires text.' });
  }
  if (input.action === 'invoke' && input.element_index == null) {
    context.addIssue({ code: 'custom', path: ['element_index'], message: 'invoke requires element_index.' });
  }
  if (input.action === 'set_value') {
    if (input.element_index == null) {
      context.addIssue({ code: 'custom', path: ['element_index'], message: 'set_value requires element_index.' });
    }
    if (input.value == null) {
      context.addIssue({ code: 'custom', path: ['value'], message: 'set_value requires value.' });
    }
  }
  if (input.action === 'key' && !input.key?.trim() && !input.keys?.length) {
    context.addIssue({ code: 'custom', path: ['key'], message: 'key requires key or keys.' });
  }
  if (input.action === 'scroll') {
    requireFields(['x', 'y', 'delta'], 'scroll requires window-relative x, y, and delta.');
  }
  if (input.action === 'open_app' && !input.app?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['app'],
      message: 'open_app requires app.',
    });
  }
  if (
    input.action === 'window' &&
    input.hwnd == null &&
    !input.title_pattern?.trim() &&
    !input.app?.trim()
  ) {
    context.addIssue({
      code: 'custom',
      path: ['app'],
      message: 'window requires app, title_pattern, or hwnd.',
    });
  }
  if (
    ['click', 'invoke', 'set_value', 'type', 'clipboard', 'key', 'scroll', 'drag', 'window'].includes(input.action)
  ) {
    if (!input.state_id?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['state_id'],
        message: `${input.action} requires state_id from a target-specific observe call.`,
      });
    }
    if (input.hwnd == null) {
      context.addIssue({
        code: 'custom',
        path: ['hwnd'],
        message: `${input.action} requires the exact hwnd returned with state_id.`,
      });
    }
  }
  if (input.action === 'window' && input.operation === 'move') {
    requireFields(['x', 'y'], 'window move requires x and y.');
  }
  if (input.action === 'window' && input.operation === 'resize') {
    requireFields(['width', 'height'], 'window resize requires width and height.');
  }
});

export function registerComputerUsePlugin(
  server: McpServer,
  config: ComputerUsePluginConfig,
): void {
  server.registerTool('computer_use', {
    title: 'Computer use',
    description: [
      "Observe and interact with the user's current desktop through visible application UI.",
      "Input shares the user's mouse and keyboard, yields while the user is active, and restores the pointer after mouse actions by default.",
      'Call observe once to discover windows, then observe an exact hwnd to receive a one-use state_id and a screenshot directly as an image. Set include_text=true to also receive accessibility elements.',
      'Every action against an existing window must include that state_id and hwnd. The state is consumed after one action and becomes stale if another turn changes the desktop.',
      'Observation does not activate a window. actionable describes foreground input readiness; window_action_available allows window operations even in the background. If is_foreground is false, use window/activate with the observed state_id and hwnd, then check the returned observation. Do not retry activation blindly if Windows refuses it.',
      'For a desktop-control demo, discover existing windows first, use a verified empty editor window or new empty tab, and verify the displayed text; do not type demo commands into an existing terminal or existing user document.',
      'open_app reports launch dispatch and a bounded window_check, not application readiness. An existing_window_candidate may be a reused window; unconfirmed does not mean launch failed. Observe the exact candidate hwnd, or discover windows, before input or another launch.',
      'Click with element_index, invoke, and set_value use UI Automation without moving the pointer. Coordinates are window-relative and remain available when an element has no semantic action.',
      'If UIA output is truncated, query the control with element_query (name substring, exact automation_id/control_type, or focused). For broader inspection pass accessibility.next_offset as element_offset with the same query. Always use the newest state and indexes.',
      'Use element supported_actions: click/invoke require Invoke, Toggle, SelectionItem, or ExpandCollapse; set_value requires writable Value or RangeValue. Text alone is not clickable. To focus an editor, use an observed coordinate; set_value replaces its entire value.',
      'type converts LF, CRLF, and CR to Enter, including blank lines. Enter may execute a command or submit a form; use multiline text only when that effect is intended. Observe after input to verify the result.',
      'clipboard copies text or an existing host-side file list using a fresh state_id and hwnd. It does not paste or send; inspect the target before a separate Ctrl+V or submit action. File lists use copy, never cut.',
      'For dense controls, observe with region and scale (for example 2). Image origin and scale are returned; map image pixels back to window coordinates: window_x=origin.x+image_x/scale, likewise y. Optional grid labels already use window coordinates. Cropping never changes UIA coordinates or the progress baseline.',
      'Input and window actions default to observe_after=true: a bounded settle, then observation containing the new state_id, exact hwnd and screenshot. Use that observation for the next action; do not call observe again unless it is missing, stale or still transitional.',
      'A foreground change is window_changed, not evidence of user activity. Post-action observation follows only a verified owned popup or its observed owner in the same process; inspect target_relation and the new hwnd. An unrelated foreground never receives automatic input.',
      'execution=dispatched acknowledges input, not application success. execution=unknown may mean partial input; inspect the returned observation before deciding what to do. Never replay a send/upload/click merely to recover a missing screenshot. user_takeover requires letting the user finish; user_stopped ends control for this turn.',
      'observation_required needs a fresh target observation. progress_unverified allows one explicit same-target review and one different corrective action. policy_blocked is terminal for this turn; observing, changing APIs or calling finish does not reset it.',
      'Call finish when desktop work is complete or abandoned to release the window border and stop control. Keep the control session during temporary user takeover, reasoning and recoverable errors; do not finish between actions. Paused input keeps the border visible. A user stop ends desktop control for this turn.',
    ].join(' '),
    annotations: {
      title: 'Computer Use',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema,
    _meta: {
      'cardbush/plugin_id': 'computer_use',
    },
  }, async (input, context) => {
    try {
      const result = await executeComputerUse(
        input,
        config,
        context.mcpReq.signal,
        safetyScope(context.mcpReq._meta),
      );
      return computerUseMcpResult(result, input.action);
    } catch (error) {
      if (context.mcpReq.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      return computerUseMcpResult({ output: {}, paths: [], artifacts: [], error: computerUseFailure(error).info, timings: failedComputerUseTimings(error) }, input.action);
    }
  });
}

export async function computerUseMcpResult(native: ComputerUseResult, action: string) {
  const images: Array<{ type: 'image'; data: string; mimeType: string; _meta: Record<string, string> }> = [];
  const failures: string[] = [];
  for (const artifact of native.artifacts.filter(item => item.type === 'image').slice(0, 2)) {
    try {
      if ((await stat(artifact.path)).size > 8 * 1024 * 1024) throw new Error('Screenshot exceeds the 8 MiB image delivery limit.');
      const bytes = await readFile(artifact.path);
      if (bytes.length > 8 * 1024 * 1024) throw new Error('Screenshot exceeds the 8 MiB image delivery limit.');
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType: artifact.media_type, _meta: { 'codex/imageDetail': 'original' } });
    } catch (error) { failures.push(formatComputerUseError(error)); }
  }
  const result = {
    action,
    ...(native.error ? { error: native.error } : {}),
    output: native.output,
    ...(native.timings ? { timings: native.timings } : {}),
    ...(images.length || failures.length ? { image_delivery: {
      status: failures.length ? 'unavailable' : 'attached', count: images.length,
      ...(failures.length ? { errors: failures, next_step: 'The screenshot was not delivered. Do not infer pixels from its path; observe again without repeating input.' } : {}),
    } } : {}),
    paths: native.paths,
    // Standard MCP images are the sole model-input route. Preserve file artifacts
    // for the app without delivering them a second time through native adapters.
    artifacts: native.artifacts.map(item => ({ ...item, metadata: { ...item.metadata, model_input: false } })),
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }, ...images],
    structuredContent: result,
    isError: Boolean(native.error),
  };
}

function safetyScope(metadata: Record<string, unknown> | undefined): string {
  const sessionId = typeof metadata?.cardbush_session_id === 'string'
    ? metadata.cardbush_session_id.trim().slice(0, 160)
    : '';
  const turnId = typeof metadata?.cardbush_turn_id === 'string'
    ? metadata.cardbush_turn_id.trim().slice(0, 160)
    : '';
  return sessionId && turnId ? JSON.stringify([sessionId, turnId]) : sessionId || 'unscoped';
}
