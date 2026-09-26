import { useLayoutEffect, useRef } from 'react';
import type { ChatToolExecution } from '../../types';
import { isToolRunning, selectToolActivityExecution } from './toolExecutionState';

export function useToolActivity(executions: ChatToolExecution[], scope: string) {
  const selected = useRef<{ scope: string; id?: string; lastId?: string }>({ scope });
  const lastId = executions[executions.length - 1]?.id;
  const sameScope = selected.current.scope === scope;
  // A batched frame may contain a brand new call that already finished. Advance
  // to it, but keep the current title when the same parallel batch settles.
  const newlyCompleted = lastId !== selected.current.lastId && !executions.some(isToolRunning);
  const execution = selectToolActivityExecution(executions, sameScope && !newlyCompleted ? selected.current.id : undefined);
  useLayoutEffect(() => { selected.current = { scope, id: execution?.id, lastId }; }, [scope, execution?.id, lastId]);
  return execution;
}
