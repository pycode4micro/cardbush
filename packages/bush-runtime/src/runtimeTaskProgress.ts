import type { RuntimeEvent } from '@cardbush/bush-protocol';

export interface RuntimeTaskProgress {
  phase: 'starting' | 'model' | 'tools' | 'waiting_user' | 'compacting' | 'completed' | 'failed' | 'stopped';
  last_activity_at?: string;
  model_requests: number;
  completed_tool_calls: number;
  failed_tool_calls: number;
  active_tool_calls: number;
}

/** Derived from the existing event stream. No second lifecycle or private content. */
export class RuntimeTaskActivity {
  private phase: RuntimeTaskProgress['phase'] = 'starting';
  private lastActivity?: string;
  private models = 0;
  private completed = 0;
  private failed = 0;
  private readonly tools = new Set<string>();
  private readonly finished = new Map<string, boolean>();
  private readonly approvals = new Set<string>();
  private readonly questions = new Set<string>();
  observe(event: RuntimeEvent) {
    this.lastActivity = event.createdAt;
    switch (event.kind) {
      case 'provider_input_observed': this.models++; this.phase = 'model'; break;
      case 'tool_queued': this.tools.add(event.payload.toolCallId); this.phase = 'tools'; break;
      case 'tool_returned':
      case 'tool_failed':
      case 'tool_cancelled':
        this.tools.delete(event.payload.toolCallId);
        if (!this.finished.has(event.payload.toolCallId)) this.completed++;
        if (event.kind === 'tool_failed' || event.kind === 'tool_returned' && event.payload.resultError) {
          if (!this.finished.get(event.payload.toolCallId)) this.failed++;
          this.finished.set(event.payload.toolCallId, true);
        } else if (!this.finished.has(event.payload.toolCallId)) this.finished.set(event.payload.toolCallId, false);
        break;
      case 'permission_requested': this.approvals.add(event.payload.permissionId); break;
      case 'permission_answered':
      case 'permission_rejected':
      case 'permission_expired':
      case 'permission_cancelled': this.approvals.delete(event.payload.permissionId); break;
      case 'solution_selection_requested': this.questions.add(event.payload.selectionId); break;
      case 'solution_selection_answered':
      case 'solution_selection_cancelled': this.questions.delete(event.payload.selectionId); break;
      case 'context_compaction_started': this.phase = 'compacting'; break;
      case 'context_compaction_completed': this.phase = 'model'; break;
      case 'turn_terminal': this.phase = event.payload.status === 'awaiting_user_action' ? 'waiting_user' : event.payload.status; this.tools.clear(); this.approvals.clear(); this.questions.clear(); break;
    }
  }
  snapshot(): RuntimeTaskProgress {
    return { phase: this.approvals.size || this.questions.size ? 'waiting_user' : this.phase,
      ...(this.lastActivity ? { last_activity_at: this.lastActivity } : {}), model_requests: this.models,
      completed_tool_calls: this.completed, failed_tool_calls: this.failed, active_tool_calls: this.tools.size };
  }
}
