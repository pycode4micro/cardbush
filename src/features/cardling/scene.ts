import type { SessionSceneRecord } from '../../backend/api';
import type { AppLanguage, ChatMessage, ChatToolExecution } from '../../types';

export type CardlingScenePlacement = 'top' | 'right' | 'bottom' | 'left';
export type CardlingSceneMood = 'explain' | 'ask' | 'confirm' | 'warn' | 'celebrate';

export type CardlingSceneAnchor = {
  nodeId?: string;
  selector?: string;
  placement: CardlingScenePlacement;
  offset: { x: number; y: number };
};

export type CardlingScene = {
  sceneId: string;
  title: string;
  html: string;
  sourceExecutionId?: string;
  sessionId?: string;
  turnId?: string;
  cardling: {
    mode: 'embedded' | 'floating';
    speech: string;
    mood: CardlingSceneMood;
    anchor?: CardlingSceneAnchor;
    position?: string | { x: number; y: number };
  };
  nodes: Array<{
    nodeId: string;
    label?: string;
    purpose?: string;
  }>;
  expectedUserAction?: {
    type?: string;
    required?: boolean;
  };
  raw: Record<string, unknown>;
};

export type CardlingSceneStep = {
  id: string;
  nodeId?: string;
  title?: string;
  speech: string;
  holdMs: number;
};

export type CardlingSceneFeedback = {
  id: string;
  nodeId: string;
  stepId?: string;
  nodeLabel: string;
  text: string;
  createdAt: string;
};

export function cardlingSceneFromToolExecution(
  execution: ChatToolExecution,
  message: ChatMessage,
): CardlingScene | null {
  const metadata = execution.metadata;
  const kind = String(metadata.kind ?? metadata.type ?? '').trim();
  const name = execution.name.trim();
  if (
    kind !== 'cardling_scene' &&
    name !== 'present_cardling_scene' &&
    name !== 'cardling_scene'
  ) {
    return null;
  }
  const rawScene = asRecord(metadata.scene ?? metadata.cardling_scene ?? metadata);
  return cardlingSceneFromRawScene(rawScene, {
    metadata,
    executionId: execution.id,
    summary: execution.summary,
    sessionId: message.conversationId,
    turnId: message.turnId,
  });
}

export function cardlingSceneFromSessionSceneRecord(
  record: SessionSceneRecord,
  fallbackSessionId?: string,
): CardlingScene | null {
  const raw = asRecord(record.raw);
  const rawScene = scenePayloadFromRecord(raw);
  const metadata = asRecord(
    raw.metadata ?? rawScene.metadata ?? asRecord(rawScene).metadata,
  );
  return cardlingSceneFromRawScene(rawScene, {
    metadata,
    executionId: sceneString(
      raw.source_execution_id ??
        raw.sourceExecutionId ??
        raw.tool_call_id ??
        raw.toolCallId,
    ),
    summary: sceneString(raw.title ?? rawScene.title),
    sessionId:
      record.sessionId ??
      sceneString(raw.session_id ?? raw.sessionId) ??
      fallbackSessionId,
    turnId: record.turnId ?? sceneString(raw.turn_id ?? raw.turnId),
  });
}

export function hasSceneHtml(payload: Record<string, unknown>) {
  const rawScene = scenePayloadFromRecord(payload);
  return String(rawScene.html ?? rawScene.content ?? '').trim().length > 0;
}

export function latestSessionSceneRecord(records: SessionSceneRecord[]) {
  if (records.length === 0) {
    return null;
  }
  return [...records].sort(
    (a, b) => sceneRecordTimestamp(a) - sceneRecordTimestamp(b),
  )[records.length - 1];
}

export function initialSceneSelectedNodeId(
  scene: CardlingScene,
  steps: CardlingSceneStep[],
) {
  if (steps.length > 0) {
    return steps[0]?.nodeId ?? '';
  }
  return scene.cardling.anchor?.nodeId ?? scene.nodes[0]?.nodeId ?? '';
}

export function sceneFeedbackId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `scene-feedback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildCardlingSceneSteps(
  scene: CardlingScene,
  language: AppLanguage,
): CardlingSceneStep[] {
  const explicitSteps = parseCardlingPresentationSteps(scene, language);
  if (explicitSteps.length > 0) {
    return explicitSteps;
  }
  const fallbackSpeech = scene.cardling.speech.trim();
  if (scene.nodes.length === 0) {
    return [
      {
        id: 'scene-intro',
        title: scene.title,
        speech:
          fallbackSpeech ||
          (language === 'zh'
            ? '我已打开这个交互场景，可以直接在页面节点上给我反馈。'
            : 'I opened this interactive scene. You can comment on nodes directly.'),
        holdMs: 900,
      },
    ];
  }
  const anchorNodeId = scene.cardling.anchor?.nodeId ?? scene.nodes[0]?.nodeId;
  return scene.nodes.map((node, index) => {
    const title = node.label || node.nodeId;
    const shouldUseSceneSpeech =
      Boolean(fallbackSpeech) && (node.nodeId === anchorNodeId || index === 0);
    return {
      id: `node-${node.nodeId}`,
      nodeId: node.nodeId,
      title,
      speech: shouldUseSceneSpeech
        ? fallbackSpeech
        : nodePurposeSpeech(node, language),
      holdMs: 720,
    };
  });
}

export function nodePurposeSpeech(
  node: CardlingScene['nodes'][number] | undefined,
  language: AppLanguage,
) {
  if (!node) {
    return '';
  }
  const label = node.label || node.nodeId;
  if (node.purpose) {
    return language === 'zh'
      ? `${label}：${node.purpose}`
      : `${label}: ${node.purpose}`;
  }
  return language === 'zh'
    ? `${label}：这里可以作为当前任务场景的反馈节点。`
    : `${label}: This is a feedback node in the current task scene.`;
}

export function latestCardlingSceneFromMessages(messages: ChatMessage[]) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const executions = message.toolExecutions ?? [];
    for (let index = executions.length - 1; index >= 0; index -= 1) {
      const scene = cardlingSceneFromToolExecution(executions[index], message);
      if (scene) {
        return scene;
      }
    }
  }
  return null;
}

export function cardlingSceneKey(scene: CardlingScene) {
  return `${scene.sceneId}:${scene.sourceExecutionId ?? ''}:${scene.turnId ?? ''}`;
}

export function cardlingSceneRevisionKey(scene: CardlingScene) {
  return JSON.stringify({
    key: cardlingSceneKey(scene),
    title: scene.title,
    html: scene.html,
    cardling: scene.cardling,
    nodes: scene.nodes,
    expectedUserAction: scene.expectedUserAction,
  });
}

export function sceneAutoPlayEnabled(scene: CardlingScene) {
  const rawCardling = asRecord(scene.raw.cardling);
  const presentation = asRecord(
    scene.raw.presentation ??
      scene.raw.timeline ??
      scene.raw.playback ??
      rawCardling.presentation ??
      rawCardling.timeline,
  );
  const autoPlay = sceneBoolean(
    presentation.auto_play ??
      presentation.autoPlay ??
      scene.raw.auto_play ??
      scene.raw.autoPlay ??
      rawCardling.auto_play ??
      rawCardling.autoPlay,
  );
  return autoPlay ?? true;
}

export function sceneBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

export function sceneString(value: unknown) {
  const text = value == null ? '' : String(value);
  return text.trim() ? text : undefined;
}

function cardlingSceneFromRawScene(
  rawScene: Record<string, unknown>,
  {
    metadata,
    executionId,
    summary,
    sessionId,
    turnId,
  }: {
    metadata: Record<string, unknown>;
    executionId?: string;
    summary?: string;
    sessionId?: string;
    turnId?: string;
  },
): CardlingScene | null {
  const html = String(rawScene.html ?? rawScene.content ?? '');
  if (!html.trim()) {
    return null;
  }
  const rawCardling = asRecord(rawScene.cardling ?? metadata.cardling);
  const rawAnchor = asRecord(rawCardling.anchor ?? rawScene.anchor);
  const modeText = String(rawCardling.mode ?? rawScene.mode ?? 'embedded').trim();
  const moodText = String(rawCardling.mood ?? rawScene.mood ?? 'explain').trim();
  const placementText = String(rawAnchor.placement ?? 'right').trim();
  const sceneId =
    sceneString(
      rawScene.scene_id ??
        rawScene.sceneId ??
        metadata.scene_id ??
        metadata.sceneId,
    ) || (executionId ? `scene-${executionId}` : '');
  if (!sceneId) {
    return null;
  }
  return {
    sceneId,
    title:
      sceneString(rawScene.title ?? metadata.title ?? summary) ||
      'Kabu Scene',
    html,
    sourceExecutionId: executionId,
    sessionId,
    turnId,
    cardling: {
      mode: modeText === 'floating' ? 'floating' : 'embedded',
      speech: sceneString(rawCardling.speech ?? rawCardling.text ?? rawScene.speech) || '',
      mood: isCardlingSceneMood(moodText) ? moodText : 'explain',
      anchor: {
        nodeId: sceneString(
          rawAnchor.node_id ?? rawAnchor.nodeId ?? rawCardling.node_id,
        ),
        selector: sceneString(rawAnchor.selector ?? rawCardling.selector),
        placement: isCardlingScenePlacement(placementText)
          ? placementText
          : 'right',
        offset: {
          x: metadataInt(asRecord(rawAnchor.offset).x ?? rawAnchor.offset_x),
          y: metadataInt(asRecord(rawAnchor.offset).y ?? rawAnchor.offset_y),
        },
      },
      position:
        rawCardling.position != null
          ? (rawCardling.position as string | { x: number; y: number })
          : undefined,
    },
    nodes: parseCardlingSceneNodes(rawScene.nodes),
    expectedUserAction: parseCardlingExpectedAction(
      rawScene.expected_user_action ?? rawScene.expectedUserAction,
    ),
    raw: rawScene,
  };
}

function scenePayloadFromRecord(payload: Record<string, unknown>) {
  const data = asRecord(payload.data);
  const item = asRecord(payload.item);
  const scene = asRecord(payload.scene);
  const metadata = asRecord(payload.metadata);
  const candidates = [
    scene,
    asRecord(payload.cardling_scene),
    asRecord(metadata.scene),
    asRecord(metadata.cardling_scene),
    item,
    data,
    payload,
  ];
  return (
    candidates.find(
      (candidate) =>
        candidate.html != null ||
        candidate.content != null ||
        candidate.scene_id != null ||
        candidate.sceneId != null,
    ) ?? payload
  );
}

function sceneRecordTimestamp(record: SessionSceneRecord) {
  const raw = asRecord(record.raw);
  const value =
    record.updatedAt ??
    record.createdAt ??
    sceneString(raw.updated_at ?? raw.updatedAt ?? raw.created_at ?? raw.createdAt);
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseCardlingSceneNodes(value: unknown): CardlingScene['nodes'] {
  if (!Array.isArray(value)) {
    return [];
  }
  const nodes: CardlingScene['nodes'] = [];
  for (const item of value) {
    const node = asRecord(item);
    const nodeId = sceneString(node.node_id ?? node.nodeId ?? node.id);
    if (!nodeId) {
      continue;
    }
    nodes.push({
      nodeId,
      label: sceneString(node.label),
      purpose: sceneString(node.purpose),
    });
  }
  return nodes;
}

function parseCardlingExpectedAction(value: unknown): CardlingScene['expectedUserAction'] {
  const action = asRecord(value);
  return {
    type: sceneString(action.type),
    required: Boolean(action.required),
  };
}

function parseCardlingPresentationSteps(
  scene: CardlingScene,
  language: AppLanguage,
): CardlingSceneStep[] {
  const rawCardling = asRecord(scene.raw.cardling);
  const presentation = asRecord(
    scene.raw.presentation ??
      scene.raw.timeline ??
      scene.raw.playback ??
      rawCardling.presentation ??
      rawCardling.timeline,
  );
  const rawSteps = Array.isArray(presentation.steps)
    ? presentation.steps
    : Array.isArray(scene.raw.steps)
      ? scene.raw.steps
      : [];
  const steps: CardlingSceneStep[] = [];
  rawSteps.forEach((item, index) => {
    const step = asRecord(item);
    const nodeId = sceneString(
      step.node_id ??
        step.nodeId ??
        step.target_node_id ??
        step.targetNodeId ??
        step.anchor_node_id ??
        step.anchorNodeId,
    );
    const node = nodeId
      ? scene.nodes.find((candidate) => candidate.nodeId === nodeId)
      : undefined;
    const title =
      sceneString(step.title ?? step.label ?? step.name) ||
      node?.label ||
      nodeId ||
      `Step ${index + 1}`;
    const speech =
      sceneString(
        step.speech ??
          step.text ??
          step.message ??
          step.narration ??
          step.description,
      ) ||
      nodePurposeSpeech(node, language) ||
      scene.cardling.speech;
    if (!speech && !nodeId) {
      return;
    }
    const holdMs =
      metadataInt(step.hold_ms ?? step.holdMs ?? step.duration_ms ?? step.durationMs) ||
      820;
    steps.push({
      id: sceneString(step.id) || `step-${index + 1}`,
      nodeId,
      title,
      speech,
      holdMs: Math.min(Math.max(holdMs, 320), 3000),
    });
  });
  return steps;
}

function metadataInt(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function isCardlingScenePlacement(value: string): value is CardlingScenePlacement {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
}

function isCardlingSceneMood(value: string): value is CardlingSceneMood {
  return (
    value === 'explain' ||
    value === 'ask' ||
    value === 'confirm' ||
    value === 'warn' ||
    value === 'celebrate'
  );
}
