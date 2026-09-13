import { useState } from 'react';
import { permissionQuestion, PermissionRequestCard } from './PermissionRequestCard';
import type { AppLanguage, PendingInteraction, InteractionReplyAnswer } from '../../types';
import { SolutionSelectionCard } from './SolutionSelectionCard';

export function InteractionCard({
  language,
  interaction,
  onReply,
  onCancel,
}: {
  language: AppLanguage;
  interaction: PendingInteraction;
  onReply: (reply: InteractionReplyAnswer[]) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const questions = interaction.questions ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submitPermission(optionId: string) {
    const question = permissionQuestion(questions);
    if (!question || busy) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onReply([{ questionId: question.id, selectedOptionId: optionId }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onCancel();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (interaction.type === 'solution_selection') return <SolutionSelectionCard key={interaction.id}
    language={language} interaction={interaction} onReply={onReply} onCancel={onCancel} />;

  return (
    <PermissionRequestCard
      language={language}
      interaction={interaction}
      busy={busy}
      error={error}
      onChoose={(optionId) => void submitPermission(optionId)}
      onCancel={() => void cancel()}
    />
  );
}
