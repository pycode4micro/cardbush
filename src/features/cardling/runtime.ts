import type { CSSProperties } from 'react';

import { sendSceneEvent } from '../../backend/api';
import type { AppLanguage } from '../../types';
import {
  sceneBoolean,
  sceneString,
  type CardlingScene,
  type CardlingSceneAnchor,
  type CardlingSceneFeedback,
} from './scene';

export type SceneRuntimeEventType =
  | 'scene_ready'
  | 'scene_health'
  | 'scene_error'
  | 'node_click'
  | 'node_drag_start'
  | 'node_drag_end'
  | 'node_reorder'
  | 'selection_change'
  | 'state_change'
  | 'route_update'
  | 'request_llm_action'
  | 'scene_toast'
  | 'form_submit'
  | 'external_url'
  | 'confirm'
  | 'cancel';

export type SceneOpenTarget = {
  kind: 'url' | 'path';
  target: string;
  label?: string;
};

export type SceneRuntimeNodeState = {
  nodeId: string;
  label?: string;
  status?: string;
  order: number;
  values: Record<string, string>;
};

export type SceneRuntimeEdgeState = {
  from: string;
  to: string;
  status?: string;
};

export type SceneRuntimeUserEvent = {
  id: string;
  type: SceneRuntimeEventType | string;
  nodeId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type SceneRuntimeState = {
  selectedNodeId: string;
  nodes: SceneRuntimeNodeState[];
  edges: SceneRuntimeEdgeState[];
  userEvents: SceneRuntimeUserEvent[];
  updatedAt: string;
};

export type SceneHealthIssue = {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
};

export type SceneHealthReport = {
  ok: boolean;
  checkedAt: string;
  renderedNodeCount: number;
  declaredNodeCount: number;
  missingNodeIds: string[];
  placeholderCount: number;
  blank: boolean;
  scriptErrors: string[];
  issues: SceneHealthIssue[];
};

export type SceneEventStatus = 'idle' | 'sending' | 'continuing' | 'recorded' | 'failed';
export type SceneEventDelivery = 'guidance' | 'recorded' | '';

export type SceneAnchorRect = {
  nodeId: string;
  rect: { left: number; top: number; width: number; height: number };
  tone?: 'dark' | 'light';
};

export const sceneRuntimeEventTypes = new Set<string>([
  'node_drag_start',
  'node_drag_end',
  'node_reorder',
  'selection_change',
  'state_change',
  'route_update',
  'request_llm_action',
  'scene_toast',
]);

export async function sendSceneUserEvent(
  scene: CardlingScene,
  payload: {
    event: string;
    nodeId?: string;
    text?: string;
    values?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  if (!scene.sessionId?.trim()) {
    throw new Error('Scene 暂无 session_id，无法回传后端');
  }
  return sendSceneEvent({
    sessionId: scene.sessionId,
    sceneId: scene.sceneId,
    turnId: scene.turnId,
    event: payload.event,
    nodeId: payload.nodeId,
    text: payload.text,
    values: payload.values,
    metadata: payload.metadata,
  });
}

export function sceneOpenTargetFromPayload(
  payload: Record<string, unknown>,
): SceneOpenTarget | null {
  const rawTarget =
    sceneString(
      payload.target ??
        payload.path ??
        payload.file_path ??
        payload.filePath ??
        payload.url ??
        payload.href,
    ) ||
    sceneString(asRecord(payload.metadata).target) ||
    sceneString(asRecord(payload.metadata).path) ||
    sceneString(asRecord(payload.metadata).url) ||
    '';
  const target = rawTarget.trim();
  if (!target || target === '#' || /^javascript:/i.test(target)) {
    return null;
  }
  const requestedKind = (sceneString(payload.kind) ?? '').toLowerCase();
  const kind =
    requestedKind === 'path' || requestedKind === 'file'
      ? 'path'
      : requestedKind === 'url' || requestedKind === 'link'
        ? 'url'
        : sceneTargetLooksLikePath(target)
          ? 'path'
          : 'url';
  const normalizedTarget =
    kind === 'path' ? normalizeSceneOpenPath(target) : normalizeSceneOpenUrl(target);
  if (!normalizedTarget) {
    return null;
  }
  return {
    kind,
    target: normalizedTarget,
    label: sceneString(payload.label),
  };
}

export function sceneEventError(error: unknown, language: AppLanguage) {
  const message = errorMessage(error);
  if (/404|not found/i.test(message)) {
    return language === 'zh'
      ? '后端 Scene 事件接口尚未接入，暂时无法回传这条反馈。'
      : 'The backend Scene event endpoint is not available yet.';
  }
  return message;
}

export function sceneEventContinuesTurn(payload: Record<string, unknown>) {
  return (
    sceneBoolean(payload.continue_turn) === true ||
    sceneBoolean(payload.continueTurn) === true ||
    sceneBoolean(asRecord(payload.result).continue_turn) === true ||
    sceneBoolean(asRecord(payload.result).continueTurn) === true
  );
}

export function sceneEventDelivery(payload: Record<string, unknown>): SceneEventDelivery {
  const result = asRecord(payload.result);
  const metadata = asRecord(payload.metadata);
  const resultMetadata = asRecord(result.metadata);
  const value = String(
    payload.delivery ?? result.delivery ?? metadata.delivery ?? resultMetadata.delivery ?? '',
  ).toLowerCase();
  return value === 'guidance' || value === 'recorded' ? value : '';
}

export function initialSceneRuntimeState(scene: CardlingScene): SceneRuntimeState {
  return {
    selectedNodeId: scene.cardling.anchor?.nodeId || scene.nodes[0]?.nodeId || '',
    nodes: scene.nodes.map((node, index) => ({
      nodeId: node.nodeId,
      label: node.label,
      status: 'idle',
      order: index,
      values: {},
    })),
    edges: parseSceneRuntimeEdges(scene.raw.edges),
    userEvents: [],
    updatedAt: new Date().toISOString(),
  };
}

export function initialSceneHealth(scene: CardlingScene): SceneHealthReport {
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    renderedNodeCount: 0,
    declaredNodeCount: scene.nodes.length,
    missingNodeIds: [],
    placeholderCount: 0,
    blank: false,
    scriptErrors: [],
    issues: [],
  };
}

export function normalizeSceneRuntimeState(
  value: unknown,
  scene: CardlingScene,
  fallback: SceneRuntimeState,
): SceneRuntimeState {
  const record = asRecord(value);
  const nodeRecords = Array.isArray(record.nodes) ? record.nodes.map(asRecord) : [];
  const fallbackById = new Map(fallback.nodes.map((node) => [node.nodeId, node]));
  const nodes: SceneRuntimeNodeState[] =
    nodeRecords.length > 0
      ? nodeRecords.reduce<SceneRuntimeNodeState[]>(
          (items, node, index) => {
            const nodeId = String(node.node_id ?? node.nodeId ?? node.id ?? '').trim();
            if (!nodeId) {
              return items;
            }
            const existing = fallbackById.get(nodeId);
            items.push({
              nodeId,
              label:
                optionalSceneString(node.label) ??
                existing?.label ??
                scene.nodes.find((item) => item.nodeId === nodeId)?.label,
              status: optionalSceneString(node.status) ?? existing?.status,
              order: sceneNumber(node.order, existing?.order ?? index),
              values: stringRecord(node.values ?? existing?.values ?? {}),
            });
            return items;
          },
          [],
        )
      : fallback.nodes;
  const edgeRecords = Array.isArray(record.edges) ? record.edges : undefined;
  return {
    selectedNodeId:
      optionalSceneString(record.selected_node_id ?? record.selectedNodeId) ??
      fallback.selectedNodeId,
    nodes,
    edges: edgeRecords ? parseSceneRuntimeEdges(edgeRecords) : fallback.edges,
    userEvents: fallback.userEvents,
    updatedAt: new Date().toISOString(),
  };
}

export function mergeSceneRuntimeState(
  current: SceneRuntimeState,
  incoming: SceneRuntimeState,
): SceneRuntimeState {
  const incomingById = new Map(incoming.nodes.map((node) => [node.nodeId, node]));
  const mergedNodes = current.nodes.map((node) => ({
    ...node,
    ...incomingById.get(node.nodeId),
    values: {
      ...node.values,
      ...(incomingById.get(node.nodeId)?.values ?? {}),
    },
  }));
  for (const node of incoming.nodes) {
    if (!current.nodes.some((item) => item.nodeId === node.nodeId)) {
      mergedNodes.push(node);
    }
  }
  return {
    ...current,
    ...incoming,
    nodes: mergedNodes.sort((left, right) => left.order - right.order),
    userEvents: current.userEvents,
    updatedAt: new Date().toISOString(),
  };
}

export function appendSceneRuntimeEvent(
  current: SceneRuntimeState,
  event: SceneRuntimeUserEvent,
): SceneRuntimeState {
  let nodes = current.nodes;
  const payload = asRecord(event.payload);
  const nextNodeId = event.nodeId || optionalSceneString(payload.nodeId) || '';
  if (event.type === 'node_reorder') {
    const order = Array.isArray(payload.order) ? payload.order.map(String) : [];
    if (order.length > 0) {
      const orderMap = new Map(order.map((nodeId, index) => [nodeId, index]));
      nodes = current.nodes
        .map((node) => ({
          ...node,
          order: orderMap.get(node.nodeId) ?? node.order,
        }))
        .sort((left, right) => left.order - right.order);
    }
  }
  if (event.type === 'state_change' && nextNodeId) {
    const values = stringRecord(payload.values);
    if (Object.keys(values).length > 0) {
      nodes = nodes.map((node) =>
        node.nodeId === nextNodeId
          ? { ...node, values: { ...node.values, ...values } }
          : node,
      );
    }
  }
  const selectedNodeId =
    event.type === 'node_click' || event.type === 'selection_change'
      ? nextNodeId || current.selectedNodeId
      : current.selectedNodeId;
  return {
    ...current,
    selectedNodeId,
    nodes,
    userEvents: [...current.userEvents, event].slice(-120),
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeSceneHealth(value: unknown, scene: CardlingScene): SceneHealthReport {
  const record = asRecord(value);
  const rawIssues = Array.isArray(record.issues) ? record.issues.map(asRecord) : [];
  const issues: SceneHealthIssue[] = rawIssues.map((issue) => ({
    code: String(issue.code ?? 'scene_issue'),
    message: String(issue.message ?? issue.description ?? issue.code ?? 'Scene issue'),
    severity:
      issue.severity === 'error' || issue.severity === 'info'
        ? issue.severity
        : 'warning',
  }));
  const missingNodeIds = Array.isArray(record.missing_node_ids)
    ? record.missing_node_ids.map(String)
    : Array.isArray(record.missingNodeIds)
      ? record.missingNodeIds.map(String)
      : [];
  const scriptErrors = Array.isArray(record.script_errors)
    ? record.script_errors.map(String)
    : Array.isArray(record.scriptErrors)
      ? record.scriptErrors.map(String)
      : [];
  const renderedNodeCount = sceneNumber(
    record.rendered_node_count ?? record.renderedNodeCount,
    sceneNumber(record.dom_node_count ?? record.domNodeCount, 0),
  );
  const declaredNodeCount = sceneNumber(
    record.declared_node_count ?? record.declaredNodeCount,
    scene.nodes.length,
  );
  const placeholderCount = sceneNumber(
    record.placeholder_count ?? record.placeholderCount,
    0,
  );
  const blank = sceneBoolean(record.blank) === true;
  const derivedIssues = [...issues];
  if (missingNodeIds.length > 0 && !derivedIssues.some((item) => item.code === 'missing_nodes')) {
    derivedIssues.push({
      code: 'missing_nodes',
      message: `Missing scene nodes: ${missingNodeIds.join(', ')}`,
      severity: 'warning',
    });
  }
  if (scriptErrors.length > 0 && !derivedIssues.some((item) => item.code === 'script_error')) {
    derivedIssues.push({
      code: 'script_error',
      message: scriptErrors[0] ?? 'Scene script error',
      severity: 'error',
    });
  }
  if (placeholderCount > 0 && !derivedIssues.some((item) => item.code === 'template_placeholder')) {
    derivedIssues.push({
      code: 'template_placeholder',
      message: `${placeholderCount} template placeholder(s) are visible.`,
      severity: 'warning',
    });
  }
  if (blank && !derivedIssues.some((item) => item.code === 'blank_scene')) {
    derivedIssues.push({
      code: 'blank_scene',
      message: 'Scene appears blank.',
      severity: 'error',
    });
  }
  const explicitOk = sceneBoolean(record.ok);
  const ok = explicitOk ?? (derivedIssues.length === 0);
  return {
    ok,
    checkedAt: String(record.checked_at ?? record.checkedAt ?? new Date().toISOString()),
    renderedNodeCount,
    declaredNodeCount,
    missingNodeIds,
    placeholderCount,
    blank,
    scriptErrors,
    issues: derivedIssues,
  };
}

export function sceneHealthKey(health: SceneHealthReport) {
  return JSON.stringify({
    ok: health.ok,
    missingNodeIds: health.missingNodeIds,
    placeholderCount: health.placeholderCount,
    blank: health.blank,
    scriptErrors: health.scriptErrors,
    issues: health.issues.map((item) => [item.code, item.message, item.severity]),
  });
}

export function formatSceneFeedbackRunPrompt(
  scene: CardlingScene,
  feedback: CardlingSceneFeedback[],
  language: AppLanguage,
) {
  const lines = feedback.map((item, index) => {
    const target = item.nodeId
      ? `${item.nodeLabel} (${item.nodeId})`
      : `${item.nodeLabel} (${item.stepId ?? 'overview'})`;
    return `${index + 1}. ${target}\n${item.text}`;
  });
  if (language === 'zh') {
    return [
      `请根据我在 Kabu Scene「${scene.title}」里提交的反馈继续处理这个 HTML 场景。`,
      '反馈如下：',
      ...lines,
      '请优先理解这些反馈对应的节点/步骤，给出修改方案并在需要时继续更新场景。',
    ].join('\n\n');
  }
  return [
    `Please continue the HTML scene "${scene.title}" based on the feedback I submitted in Kabu Scene.`,
    'Feedback:',
    ...lines,
    'Please map each item to its node/step, propose the update, and continue updating the scene when needed.',
  ].join('\n\n');
}

export function formatSceneActionRunPrompt(
  scene: CardlingScene,
  payload: Record<string, unknown>,
  language: AppLanguage,
) {
  const action = String(payload.action ?? payload.intent ?? payload.text ?? '').trim();
  const nodeId = String(payload.nodeId ?? payload.node_id ?? '').trim();
  const context = JSON.stringify(
    {
      node_id: nodeId,
      values: payload.values ?? undefined,
      state: payload.state ?? undefined,
    },
    null,
    2,
  );
  if (!action && !nodeId) {
    return '';
  }
  if (language === 'zh') {
    return [
      `请继续处理 Kabu Scene「${scene.title}」里的交互请求。`,
      action ? `用户请求：${action}` : '',
      nodeId ? `关联节点：${nodeId}` : '',
      `场景上下文：\n${context}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return [
    `Please continue handling the interaction request in Kabu Scene "${scene.title}".`,
    action ? `User request: ${action}` : '',
    nodeId ? `Related node: ${nodeId}` : '',
    `Scene context:\n${context}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function formatSceneKabuChatPrompt(
  scene: CardlingScene,
  {
    text,
    nodeId,
    nodeLabel,
    stepId,
    language,
  }: {
    text: string;
    nodeId: string;
    nodeLabel: string;
    stepId?: string;
    language: AppLanguage;
  },
) {
  const freeChat = !nodeId && stepId === 'free_chat';
  const target = nodeId
    ? `${nodeLabel} (${nodeId})`
    : freeChat
      ? nodeLabel
      : `${nodeLabel} (${stepId ?? 'overview'})`;
  if (language === 'zh') {
    return [
      `我正在 Kabu Scene「${scene.title}」里和卡布对话。`,
      `当前目标：${target}`,
      `我对卡布说：${text}`,
      freeChat
        ? '请把这句话作为对整个 HTML 场景的自由对话来处理，不要假定它绑定到某个节点。必要时解释、提出方案或更新场景。'
        : '请把这句话作为对当前场景节点/步骤的直接对话来处理，必要时继续解释、提出方案或更新场景。',
    ].join('\n\n');
  }
  return [
    `I am talking to Kabu inside Kabu Scene "${scene.title}".`,
    `Current target: ${target}`,
    `My message to Kabu: ${text}`,
    freeChat
      ? 'Treat this as a free conversation about the whole HTML scene, not bound to a specific node. Explain, propose changes, or update the scene when appropriate.'
      : 'Treat this as a direct conversation about the current scene node/step. Explain, propose changes, or update the scene when appropriate.',
  ].join('\n\n');
}

export function sceneCardlingStyle(
  anchorRect: SceneAnchorRect | null,
  anchor?: CardlingSceneAnchor,
): CSSProperties {
  if (!anchorRect) {
    return {};
  }
  const placement = anchor?.placement ?? 'right';
  const offset = anchor?.offset ?? { x: 0, y: 0 };
  const rect = anchorRect.rect;
  const gap = 12;
  let left = rect.left + rect.width + gap;
  let top = rect.top + rect.height / 2 - 34;
  if (placement === 'left') {
    left = rect.left - 318 - gap;
  } else if (placement === 'top') {
    left = rect.left + rect.width / 2 - 110;
    top = rect.top - 92 - gap;
  } else if (placement === 'bottom') {
    left = rect.left + rect.width / 2 - 110;
    top = rect.top + rect.height + gap;
  }
  return {
    left: `clamp(12px, ${Math.round(left + offset.x)}px, calc(100% - 342px))`,
    top: `clamp(12px, ${Math.round(top + offset.y)}px, calc(100% - 232px))`,
  };
}

export function sceneKabuDialogStyle(
  anchorRect: SceneAnchorRect | null,
  anchor?: CardlingSceneAnchor,
): CSSProperties {
  if (!anchorRect) {
    return { right: 18, bottom: 18 };
  }
  const placement = anchor?.placement ?? 'right';
  const rect = anchorRect.rect;
  const gap = 14;
  let left = rect.left + rect.width + gap;
  let top = rect.top + rect.height + gap;
  if (placement === 'left') {
    left = rect.left - 312 - gap;
    top = rect.top + rect.height + gap;
  } else if (placement === 'top') {
    left = rect.left + rect.width / 2 - 156;
    top = rect.top - 216 - gap;
  } else if (placement === 'bottom') {
    left = rect.left + rect.width / 2 - 156;
    top = rect.top + rect.height + gap;
  }
  return {
    left: `clamp(12px, ${Math.round(left)}px, calc(100% - 324px))`,
    top: `clamp(12px, ${Math.round(top)}px, calc(100% - 226px))`,
  };
}

export function sceneFloatingCardlingStyle(
  position: CardlingScene['cardling']['position'],
): CSSProperties {
  if (typeof position === 'object' && position != null) {
    return {
      left: `clamp(12px, ${Math.round(Number(position.x) || 0)}px, calc(100% - 342px))`,
      top: `clamp(12px, ${Math.round(Number(position.y) || 0)}px, calc(100% - 232px))`,
    };
  }
  const value = typeof position === 'string' ? position : 'bottom-right';
  if (value === 'top-left') {
    return { left: 18, top: 18 };
  }
  if (value === 'top-right') {
    return { right: 18, top: 18 };
  }
  if (value === 'bottom-left') {
    return { left: 18, bottom: 18 };
  }
  return { right: 18, bottom: 18 };
}

export function buildSceneSrcDoc(scene: CardlingScene) {
  const bridge = sceneBridgeScript(scene);
  const baseStyle = `
<style>
  :root { color-scheme: dark light; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
  html, body { min-height: 100%; margin: 0; }
  body { background: #111; color: #f3f3f3; }
  [data-node-id] { scroll-margin: 72px; }
  [data-cardbush-active-node="true"] { outline: 2px solid rgba(134, 231, 178, 0.9); outline-offset: 3px; }
</style>`;
  const html = scene.html;
  if (/<html[\s>]/i.test(html)) {
    const withStyle = /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, `${baseStyle}</head>`)
      : `${baseStyle}${html}`;
    return /<\/body>/i.test(withStyle)
      ? withStyle.replace(/<\/body>/i, `${bridge}</body>`)
      : `${withStyle}${bridge}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${baseStyle}</head><body>${html}${bridge}</body></html>`;
}

function sceneTargetLooksLikePath(value: string) {
  return (
    /^file:/i.test(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\\\\/.test(value)
  );
}

function normalizeSceneOpenPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^file:/i.test(trimmed)) {
    try {
      const fileUrl = new URL(trimmed);
      const decodedPath = decodeURIComponent(fileUrl.pathname);
      if (fileUrl.hostname) {
        return `\\\\${fileUrl.hostname}${decodedPath.replace(/\//g, '\\')}`;
      }
      return decodedPath.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\');
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function normalizeSceneOpenUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^javascript:/i.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function parseSceneRuntimeEdges(value: unknown): SceneRuntimeEdgeState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(asRecord).reduce<SceneRuntimeEdgeState[]>((items, edge) => {
    const from = String(edge.from ?? edge.source ?? '').trim();
    const to = String(edge.to ?? edge.target ?? '').trim();
    if (!from || !to) {
      return items;
    }
    items.push({
      from,
      to,
      status: optionalSceneString(edge.status),
    });
    return items;
  }, []);
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, String(item ?? '')]),
  );
}

function optionalSceneString(value: unknown) {
  if (value == null) {
    return undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}

function sceneNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sceneBridgeScript(scene: CardlingScene) {
  const anchor = {
    nodeId: scene.cardling.anchor?.nodeId ?? '',
    selector: scene.cardling.anchor?.selector ?? '',
  };
  const declaredNodeIds = scene.nodes.map((node) => node.nodeId);
  return `<script>
(function () {
  var sceneId = ${JSON.stringify(scene.sceneId)};
  var anchor = ${JSON.stringify(anchor)};
  var declaredNodeIds = ${JSON.stringify(declaredNodeIds)};
  var scriptErrors = [];
  var lastHealthKey = '';
  var lastOrder = [];
  var inputTimer = 0;
  var healthTimer = 0;
  var drag = null;
  var interactionMode = 'node';
  function esc(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\\\]/g, '\\\\$&');
  }
  function post(type, payload, options) {
    var message = Object.assign({ source: 'cardbush-scene', sceneId: sceneId, type: type }, payload || {});
    if (options && options.state) message.state = collectState();
    if (options && options.health) message.health = computeHealth();
    parent.postMessage(message, '*');
  }
  function readOpenTarget(target) {
    var selector = [
      'a[href]',
      'button',
      '[role="button"]',
      '[data-cardbush-open]',
      '[data-open]',
      '[data-open-path]',
      '[data-file-path]',
      '[data-file]',
      '[data-path]',
      '[data-url]',
      '[data-href]',
      '[data-cardbush-url]',
      '[data-cardbush-path]'
    ].join(',');
    var element = target && target.closest ? target.closest(selector) : null;
    if (!element) return null;
    var names = [
      'data-cardbush-open',
      'data-open',
      'data-open-path',
      'data-file-path',
      'data-file',
      'data-path',
      'data-url',
      'data-href',
      'data-cardbush-url',
      'data-cardbush-path'
    ];
    var raw = '';
    var attr = '';
    for (var index = 0; index < names.length; index += 1) {
      raw = element.getAttribute(names[index]) || '';
      if (raw.trim()) {
        attr = names[index];
        break;
      }
    }
    if (!raw && element.tagName && element.tagName.toLowerCase() === 'a') {
      raw = element.getAttribute('href') || element.href || '';
      attr = 'href';
    }
    raw = String(raw || '').trim();
    if (!raw || raw === '#' || /^javascript:/i.test(raw)) return null;
    if (attr === 'href' && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-zA-Z]:[\\\\/]/.test(raw) && !/^\\\\\\\\/.test(raw)) {
      return null;
    }
    var kind = /url|href/i.test(attr) || /^https?:/i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw) ? 'url' : 'path';
    if (/^file:/i.test(raw) || /^[a-zA-Z]:[\\\\/]/.test(raw) || /^\\\\\\\\/.test(raw)) {
      kind = 'path';
    }
    return {
      target: raw,
      url: kind === 'url' ? raw : '',
      path: kind === 'path' ? raw : '',
      kind: kind,
      nodeId: nodeIdFor(element),
      label: (element.textContent || '').trim().slice(0, 160)
    };
  }
  function nodeFor(nextAnchor) {
    var active = nextAnchor || anchor || {};
    if (active.nodeId) {
      var byId = document.querySelector('[data-node-id="' + esc(active.nodeId) + '"]');
      if (byId) return byId;
    }
    if (active.selector) {
      try { return document.querySelector(active.selector); } catch (_) {}
    }
    return document.querySelector('[data-node-id]');
  }
  function nodeIdFor(node) {
    var target = node && node.closest ? node.closest('[data-node-id]') : null;
    return target ? target.getAttribute('data-node-id') || '' : '';
  }
  function allNodeElements() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-node-id]'));
  }
  function currentOrder() {
    return allNodeElements().map(function (node) { return node.getAttribute('data-node-id') || ''; }).filter(Boolean);
  }
  function sameOrder(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  function valuesFor(node) {
    var values = {};
    if (!node || !node.querySelectorAll) return values;
    node.querySelectorAll('input, textarea, select').forEach(function (field) {
      var key = field.name || field.id || field.getAttribute('data-key') || '';
      if (!key) return;
      if (field.type === 'checkbox') values[key] = field.checked ? 'true' : 'false';
      else if (field.type === 'radio') {
        if (field.checked) values[key] = field.value || 'on';
      } else values[key] = String(field.value || '');
    });
    return values;
  }
  function collectState() {
    var nodes = allNodeElements().map(function (node, index) {
      return {
        node_id: node.getAttribute('data-node-id') || '',
        label: node.getAttribute('data-label') || node.getAttribute('aria-label') || (node.textContent || '').trim().slice(0, 80),
        status: node.getAttribute('data-status') || '',
        order: index,
        values: valuesFor(node)
      };
    }).filter(function (node) { return !!node.node_id; });
    var edges = Array.prototype.slice.call(document.querySelectorAll('[data-edge-from][data-edge-to]')).map(function (edge) {
      return {
        from: edge.getAttribute('data-edge-from') || '',
        to: edge.getAttribute('data-edge-to') || '',
        status: edge.getAttribute('data-status') || ''
      };
    }).filter(function (edge) { return edge.from && edge.to; });
    return {
      selected_node_id: anchor.nodeId || '',
      nodes: nodes,
      edges: edges
    };
  }
  function countPlaceholders(text) {
    var count = 0;
    var index = text.indexOf('\${');
    while (index >= 0) {
      count += 1;
      index = text.indexOf('\${', index + 2);
    }
    return count;
  }
  function computeHealth() {
    var domIds = currentOrder();
    var missing = declaredNodeIds.filter(function (id) { return domIds.indexOf(id) < 0; });
    var text = (document.body && document.body.innerText ? document.body.innerText : '').trim();
    var interactiveCount = document.querySelectorAll('svg, canvas, img, button, input, textarea, select, [data-node-id]').length;
    var blank = text.length < 2 && interactiveCount === 0;
    var placeholderCount = countPlaceholders(text);
    var issues = [];
    if (missing.length > 0) issues.push({ code: 'missing_nodes', severity: 'warning', message: 'Missing scene nodes: ' + missing.join(', ') });
    if (scriptErrors.length > 0) issues.push({ code: 'script_error', severity: 'error', message: scriptErrors[scriptErrors.length - 1] });
    if (placeholderCount > 0) issues.push({ code: 'template_placeholder', severity: 'warning', message: placeholderCount + ' template placeholder(s) are visible.' });
    if (blank) issues.push({ code: 'blank_scene', severity: 'error', message: 'Scene appears blank.' });
    return {
      ok: issues.length === 0,
      checked_at: new Date().toISOString(),
      rendered_node_count: domIds.length,
      declared_node_count: declaredNodeIds.length,
      missing_node_ids: missing,
      placeholder_count: placeholderCount,
      blank: blank,
      script_errors: scriptErrors.slice(-5),
      issues: issues
    };
  }
  function postHealthIfChanged() {
    var health = computeHealth();
    var key = JSON.stringify({
      ok: health.ok,
      missing: health.missing_node_ids,
      placeholders: health.placeholder_count,
      blank: health.blank,
      errors: health.script_errors
    });
    if (key === lastHealthKey) return;
    lastHealthKey = key;
    post('scene_health', {}, { state: true, health: true });
  }
  function scheduleHealth() {
    clearTimeout(healthTimer);
    healthTimer = setTimeout(postHealthIfChanged, 180);
  }
  function postStateChange(nodeId, values) {
    post('state_change', { nodeId: nodeId || anchor.nodeId || '', values: values || {} }, { state: true, health: true });
    scheduleHealth();
  }
  function parseColor(value) {
    if (!value || value === 'transparent') return null;
    var match = String(value).match(/rgba?\\(([^)]+)\\)/i);
    if (!match) return null;
    var parts = match[1].split(',').map(function (part) { return Number(String(part).trim().replace('%', '')); });
    if (parts.length < 3 || !isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2])) return null;
    var alpha = parts.length > 3 && isFinite(parts[3]) ? parts[3] : 1;
    if (alpha <= 0.04) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
  }
  function backgroundToneFor(node) {
    var current = node;
    while (current && current.nodeType === 1) {
      var color = parseColor(getComputedStyle(current).backgroundColor);
      if (color) {
        var luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
        return luminance > 0.56 ? 'light' : 'dark';
      }
      current = current.parentElement;
    }
    var bodyColor = parseColor(getComputedStyle(document.body).backgroundColor) || parseColor(getComputedStyle(document.documentElement).backgroundColor);
    if (!bodyColor) return 'dark';
    var bodyLuminance = (0.2126 * bodyColor.r + 0.7152 * bodyColor.g + 0.0722 * bodyColor.b) / 255;
    return bodyLuminance > 0.56 ? 'light' : 'dark';
  }
  function reportAnchor(nextAnchor) {
    if (nextAnchor) anchor = Object.assign({}, anchor, nextAnchor);
    var node = nodeFor(anchor);
    document.querySelectorAll('[data-cardbush-active-node="true"]').forEach(function (item) {
      item.removeAttribute('data-cardbush-active-node');
    });
    if (!node) {
      post('anchor_missing', { nodeId: anchor.nodeId || '' });
      return;
    }
    node.setAttribute('data-cardbush-active-node', 'true');
    var rect = node.getBoundingClientRect();
    post('anchor_rect', {
      nodeId: node.getAttribute('data-node-id') || anchor.nodeId || '',
      tone: backgroundToneFor(node),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    });
  }
  function revealAnchor(nextAnchor) {
    if (nextAnchor) anchor = Object.assign({}, anchor, nextAnchor);
    var node = nodeFor(anchor);
    if (!node) {
      reportAnchor(anchor);
      return;
    }
    try {
      node.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'smooth'
      });
    } catch (_) {
      try { node.scrollIntoView(true); } catch (__) {}
    }
    reportAnchor(anchor);
    [80, 180, 360, 620].forEach(function (delay) {
      setTimeout(function () { reportAnchor(anchor); }, delay);
    });
  }
  window.cardbushScene = {
    emit: function (type, payload) {
      var nextPayload = Object.assign({}, payload || {});
      if (!nextPayload.nodeId) nextPayload.nodeId = nodeIdFor(document.activeElement) || anchor.nodeId || '';
      post(String(type || 'state_change'), nextPayload, { state: true, health: true });
    },
    setState: function (nextState) {
      post('state_change', { state: nextState || {} }, { state: true, health: true });
    },
    requestLLM: function (payload) {
      post('request_llm_action', payload || {}, { state: true, health: true });
    },
    toast: function (message) {
      post('scene_toast', { message: String(message || '') });
    },
    open: function (target, options) {
      var payload = Object.assign({}, options || {}, { target: String(target || '') });
      post('external_url', payload);
    },
    getState: collectState,
    checkHealth: function () {
      var health = computeHealth();
      post('scene_health', {}, { state: true, health: true });
      return health;
    }
  };
  window.onerror = function (message, source, lineno, colno, error) {
    var text = String(message || 'Script error');
    scriptErrors.push(text);
    post('scene_error', { message: text, source: source || '', line: lineno || 0, column: colno || 0, stack: error && error.stack ? String(error.stack) : '' }, { state: true, health: true });
    scheduleHealth();
  };
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason && event.reason.message ? event.reason.message : event.reason;
    var text = String(reason || 'Unhandled promise rejection');
    scriptErrors.push(text);
    post('scene_error', { message: text }, { state: true, health: true });
    scheduleHealth();
  });
  document.addEventListener('click', function (event) {
    var openTarget = readOpenTarget(event.target);
    if (openTarget) {
      event.preventDefault();
      post('external_url', openTarget);
      return;
    }
    if (interactionMode === 'free_chat') return;
    var nodeId = nodeIdFor(event.target);
    if (nodeId) {
      anchor.nodeId = nodeId;
      reportAnchor(anchor);
      var label = event.target && event.target.textContent ? event.target.textContent.trim().slice(0, 160) : '';
      post('node_click', { nodeId: nodeId, label: label }, { state: true, health: true });
      post('selection_change', { nodeId: nodeId, label: label }, { state: true, health: false });
    }
  }, true);
  document.addEventListener('pointerdown', function (event) {
    if (interactionMode === 'free_chat') return;
    var nodeId = nodeIdFor(event.target);
    if (!nodeId) return;
    drag = {
      nodeId: nodeId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      order: currentOrder()
    };
  }, true);
  document.addEventListener('pointermove', function (event) {
    if (!drag || drag.started) return;
    var distance = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
    if (distance <= 8) return;
    drag.started = true;
    post('node_drag_start', { nodeId: drag.nodeId, order: drag.order }, { state: true, health: false });
  }, true);
  document.addEventListener('pointerup', function () {
    if (!drag) return;
    var current = currentOrder();
    if (drag.started) {
      post('node_drag_end', { nodeId: drag.nodeId, order: current }, { state: true, health: true });
      if (!sameOrder(drag.order, current)) {
        post('node_reorder', { nodeId: drag.nodeId, previousOrder: drag.order, order: current }, { state: true, health: true });
      }
    }
    drag = null;
  }, true);
  document.addEventListener('change', function (event) {
    var node = event.target && event.target.closest ? event.target.closest('[data-node-id]') : null;
    if (!node) return;
    postStateChange(node.getAttribute('data-node-id') || '', valuesFor(node));
  }, true);
  document.addEventListener('input', function (event) {
    var node = event.target && event.target.closest ? event.target.closest('[data-node-id]') : null;
    if (!node) return;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      postStateChange(node.getAttribute('data-node-id') || '', valuesFor(node));
    }, 280);
  }, true);
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    var values = {};
    new FormData(form).forEach(function (value, key) {
      values[key] = String(value);
    });
    post('form_submit', { nodeId: nodeIdFor(form) || anchor.nodeId || '', values: values }, { state: true, health: true });
  }, true);
  window.addEventListener('hashchange', function () {
    post('route_update', { route: location.hash || location.pathname || '' }, { state: true, health: true });
  });
  window.addEventListener('popstate', function () {
    post('route_update', { route: location.hash || location.pathname || '' }, { state: true, health: true });
  });
  if (window.MutationObserver) {
    new MutationObserver(function () {
      var current = currentOrder();
      if (lastOrder.length > 0 && !sameOrder(lastOrder, current)) {
        post('node_reorder', { previousOrder: lastOrder, order: current }, { state: true, health: true });
      }
      lastOrder = current;
      scheduleHealth();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-node-id', 'data-status'] });
  }
  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.source !== 'cardbush-scene-host' || data.sceneId !== sceneId) return;
    if (data.type === 'set_interaction_mode') {
      interactionMode = data.mode === 'free_chat' ? 'free_chat' : 'node';
      if (interactionMode === 'free_chat') {
        drag = null;
        document.querySelectorAll('[data-cardbush-active-node="true"]').forEach(function (item) {
          item.removeAttribute('data-cardbush-active-node');
        });
      }
      return;
    }
    if (data.type === 'set_anchor') {
      if (data.reveal) revealAnchor(data.anchor || {});
      else reportAnchor(data.anchor || {});
    }
  });
  window.addEventListener('resize', function () { reportAnchor(anchor); });
  window.addEventListener('scroll', function () { reportAnchor(anchor); }, true);
  setTimeout(function () {
    lastOrder = currentOrder();
    reportAnchor(anchor);
    post('scene_ready', {}, { state: true, health: true });
    postHealthIfChanged();
  }, 30);
})();
</script>`;
}
