import type {
  RuntimeEvent,
  RuntimePermissionScope,
  RuntimePermissionTarget,
} from '@cardbush/bush-protocol';

export type RuntimeTurnPhase =
  | 'idle'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'awaiting_user_action';

export interface RuntimeSegmentView {
  messageId: string;
  segmentId: string;
  ordinal: number;
  content: string;
  completed: boolean;
}

export interface RuntimeTerminalView {
  status: Extract<
    RuntimeTurnPhase,
    'completed' | 'failed' | 'stopped' | 'awaiting_user_action'
  >;
  reason: string;
  finalMessageId?: string;
  details: Record<string, unknown>;
}

export type RuntimeToolPhase =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RuntimeToolView {
  toolCallId: string;
  toolName: string;
  ordinal: number;
  assistantMessageId?: string;
  display?: { title: string; summary?: string };
  phase: RuntimeToolPhase;
  error?: { code: string; message: string; details: Record<string, unknown> };
  reason?: string;
}

export type RuntimePermissionPhase =
  | 'pending'
  | 'answered'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export interface RuntimePermissionView {
  permissionId: string;
  toolCallId?: string;
  phase: RuntimePermissionPhase;
  reason?: string;
  actions: string[];
  targets: RuntimePermissionTarget[];
  scope?: RuntimePermissionScope;
  answerId?: string;
  grantedCapabilityIds: string[];
  requestedCapabilityIds: string[];
}

export interface RuntimeTurnView {
  sessionId?: string;
  turnId?: string;
  requestId?: string;
  phase: RuntimeTurnPhase;
  lastSequence: number;
  reasoningSegments: RuntimeSegmentView[];
  assistantSegments: RuntimeSegmentView[];
  tools: RuntimeToolView[];
  permissions: RuntimePermissionView[];
  terminal?: RuntimeTerminalView;
}

/**
 * Projects validated Runtime facts into renderable state. It does not infer
 * lifecycle from prose, transport closure or segment presence.
 */
export class RuntimeTurnProjection {
  readonly #seenEventIds = new Set<string>();
  readonly #reasoningSegments = new Map<string, RuntimeSegmentView>();
  readonly #assistantSegments = new Map<string, RuntimeSegmentView>();
  readonly #tools = new Map<string, RuntimeToolView>();
  readonly #permissions = new Map<string, RuntimePermissionView>();
  #sessionId?: string;
  #turnId?: string;
  #requestId?: string;
  #phase: RuntimeTurnPhase = 'idle';
  #lastSequence = -1;
  #terminal?: RuntimeTerminalView;

  apply(event: RuntimeEvent): RuntimeTurnView {
    if (this.#seenEventIds.has(event.eventId)) {
      return this.snapshot();
    }
    if (event.sequence <= this.#lastSequence) {
      throw new Error(
        `Runtime event sequence moved backwards: ${event.sequence} <= ${this.#lastSequence}`,
      );
    }
    this.#bindIdentity(event);
    this.#seenEventIds.add(event.eventId);
    this.#lastSequence = event.sequence;

    switch (event.kind) {
      case 'turn_accepted':
        this.#phase = 'accepted';
        break;
      case 'turn_started':
        this.#phase = 'running';
        break;
      case 'reasoning_segment_started':
        startSegment(this.#reasoningSegments, event.payload);
        break;
      case 'reasoning_segment_delta':
        appendSegment(this.#reasoningSegments, event.payload);
        break;
      case 'reasoning_segment_completed':
        completeSegment(this.#reasoningSegments, event.payload);
        break;
      case 'assistant_segment_started':
        startSegment(this.#assistantSegments, event.payload);
        break;
      case 'assistant_segment_delta':
        appendSegment(this.#assistantSegments, event.payload);
        break;
      case 'assistant_segment_completed':
        completeSegment(this.#assistantSegments, event.payload);
        break;
      case 'tool_queued':
        upsertTool(this.#tools, event.payload, 'queued');
        break;
      case 'tool_running':
        upsertTool(this.#tools, event.payload, 'running');
        break;
      case 'tool_returned':
        completeTool(this.#tools, event.payload, 'completed');
        break;
      case 'tool_failed':
        completeTool(this.#tools, event.payload, 'failed');
        break;
      case 'tool_cancelled':
        upsertTool(this.#tools, event.payload, 'cancelled', {
          reason: event.payload.reason,
        });
        break;
      case 'permission_requested':
        this.#permissions.set(event.payload.permissionId, {
          permissionId: event.payload.permissionId,
          toolCallId: event.payload.toolCallId,
          phase: 'pending',
          reason: event.payload.reason,
          actions: [...event.payload.actions],
          targets: event.payload.targets.map((target) => ({ ...target })),
          scope: event.payload.scope
            ? { mode: event.payload.scope.mode, roots: [...event.payload.scope.roots] }
            : undefined,
          grantedCapabilityIds: [],
          requestedCapabilityIds: [...event.payload.requestedCapabilityIds],
        });
        break;
      case 'permission_answered':
        updatePermission(this.#permissions, event.payload, 'answered', {
          answerId: event.payload.answerId,
          grantedCapabilityIds: [...event.payload.grantedCapabilityIds],
        });
        break;
      case 'permission_rejected':
        updatePermission(this.#permissions, event.payload, 'rejected', {
          reason: event.payload.reason,
        });
        break;
      case 'permission_expired':
        updatePermission(this.#permissions, event.payload, 'expired', {
          reason: event.payload.reason,
        });
        break;
      case 'permission_cancelled':
        updatePermission(this.#permissions, event.payload, 'cancelled', {
          reason: event.payload.reason,
        });
        break;
      case 'turn_terminal':
        this.#phase = event.payload.status;
        this.#terminal = {
          status: event.payload.status,
          reason: event.payload.reason,
          finalMessageId: event.payload.finalMessageId,
          details: { ...event.payload.details },
        };
        break;
    }
    return this.snapshot();
  }

  snapshot(): RuntimeTurnView {
    return {
      sessionId: this.#sessionId,
      turnId: this.#turnId,
      requestId: this.#requestId,
      phase: this.#phase,
      lastSequence: this.#lastSequence,
      reasoningSegments: sortedSegments(this.#reasoningSegments),
      assistantSegments: sortedSegments(this.#assistantSegments),
      tools: sortedTools(this.#tools),
      permissions: [...this.#permissions.values()].map(clonePermission),
      terminal: this.#terminal
        ? { ...this.#terminal, details: { ...this.#terminal.details } }
        : undefined,
    };
  }

  #bindIdentity(event: RuntimeEvent) {
    if (this.#sessionId && this.#sessionId !== event.sessionId) {
      throw new Error('RuntimeTurnProjection cannot combine different sessions.');
    }
    if (this.#turnId && this.#turnId !== event.turnId) {
      throw new Error('RuntimeTurnProjection cannot combine different Turns.');
    }
    if (this.#requestId && this.#requestId !== event.requestId) {
      throw new Error('RuntimeTurnProjection cannot combine different requests.');
    }
    this.#sessionId ??= event.sessionId;
    this.#turnId ??= event.turnId;
    this.#requestId ??= event.requestId;
  }
}

interface SegmentIdentity {
  messageId: string;
  segmentId: string;
  ordinal: number;
}

function startSegment(
  segments: Map<string, RuntimeSegmentView>,
  payload: SegmentIdentity,
) {
  const current = segments.get(payload.segmentId);
  segments.set(payload.segmentId, {
    ...payload,
    content: current?.content ?? '',
    completed: current?.completed ?? false,
  });
}

function appendSegment(
  segments: Map<string, RuntimeSegmentView>,
  payload: SegmentIdentity & { delta: string },
) {
  const current = segments.get(payload.segmentId);
  segments.set(payload.segmentId, {
    messageId: payload.messageId,
    segmentId: payload.segmentId,
    ordinal: payload.ordinal,
    content: `${current?.content ?? ''}${payload.delta}`,
    completed: current?.completed ?? false,
  });
}

function completeSegment(
  segments: Map<string, RuntimeSegmentView>,
  payload: SegmentIdentity & { content: string },
) {
  segments.set(payload.segmentId, {
    messageId: payload.messageId,
    segmentId: payload.segmentId,
    ordinal: payload.ordinal,
    content: payload.content,
    completed: true,
  });
}

function sortedSegments(
  segments: Map<string, RuntimeSegmentView>,
): RuntimeSegmentView[] {
  return [...segments.values()]
    .sort((left, right) =>
      left.ordinal === right.ordinal
        ? left.segmentId.localeCompare(right.segmentId)
        : left.ordinal - right.ordinal,
    )
    .map((segment) => ({ ...segment }));
}

type RuntimeToolPayload = Extract<
  RuntimeEvent,
  { kind: 'tool_queued' | 'tool_running' | 'tool_returned' | 'tool_failed' | 'tool_cancelled' }
>['payload'];

function upsertTool(
  tools: Map<string, RuntimeToolView>,
  payload: RuntimeToolPayload,
  phase: RuntimeToolPhase,
  extra: Partial<RuntimeToolView> = {},
) {
  const current = tools.get(payload.toolCallId);
  tools.set(payload.toolCallId, {
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    ordinal: payload.ordinal,
    assistantMessageId: payload.assistantMessageId,
    display: payload.display ? { ...payload.display } : current?.display,
    phase,
    ...extra,
  });
}

function completeTool(
  tools: Map<string, RuntimeToolView>,
  payload: Extract<
    RuntimeEvent,
    { kind: 'tool_returned' | 'tool_failed' }
  >['payload'],
  phase: Extract<RuntimeToolPhase, 'completed' | 'failed'>,
) {
  upsertTool(tools, payload, phase, {
    error: 'error' in payload
      ? { ...payload.error, details: { ...payload.error.details } }
      : undefined,
  });
}

function sortedTools(tools: Map<string, RuntimeToolView>): RuntimeToolView[] {
  return [...tools.values()]
    .sort((left, right) =>
      left.ordinal === right.ordinal
        ? left.toolCallId.localeCompare(right.toolCallId)
        : left.ordinal - right.ordinal,
    )
    .map(cloneTool);
}

function cloneTool(tool: RuntimeToolView): RuntimeToolView {
  return {
    ...tool,
    display: tool.display ? { ...tool.display } : undefined,
    error: tool.error
      ? { ...tool.error, details: { ...tool.error.details } }
      : undefined,
  };
}

type RuntimePermissionPayload = Extract<
  RuntimeEvent,
  {
    kind:
      | 'permission_answered'
      | 'permission_rejected'
      | 'permission_expired'
      | 'permission_cancelled';
  }
>['payload'];

function updatePermission(
  permissions: Map<string, RuntimePermissionView>,
  payload: RuntimePermissionPayload,
  phase: Exclude<RuntimePermissionPhase, 'pending'>,
  extra: Partial<RuntimePermissionView>,
) {
  const current = permissions.get(payload.permissionId);
  permissions.set(payload.permissionId, {
    permissionId: payload.permissionId,
    toolCallId: payload.toolCallId ?? current?.toolCallId,
    phase,
    actions: current?.actions ?? [],
    targets: current?.targets ?? [],
    grantedCapabilityIds: current?.grantedCapabilityIds ?? [],
    requestedCapabilityIds: current?.requestedCapabilityIds ?? [],
    ...extra,
  });
}

function clonePermission(permission: RuntimePermissionView): RuntimePermissionView {
  return {
    ...permission,
    actions: [...permission.actions],
    targets: permission.targets.map((target) => ({ ...target })),
    scope: permission.scope
      ? { mode: permission.scope.mode, roots: [...permission.scope.roots] }
      : undefined,
    grantedCapabilityIds: [...permission.grantedCapabilityIds],
    requestedCapabilityIds: [...permission.requestedCapabilityIds],
  };
}
