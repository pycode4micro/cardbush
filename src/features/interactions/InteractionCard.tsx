import { useState } from 'react';
import { permissionQuestion, PermissionRequestCard } from './PermissionRequestCard';
import type { AppLanguage, PendingInteraction, InteractionReplyAnswer } from '../../types';

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

  async function submitPermission(optionId: string) {
    const question = permissionQuestion(questions);
    if (!question || busy) {
      return;
    }
    setBusy(true);
    try {
      await onReply([{ questionId: question.id, selectedOptionId: optionId }]);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onCancel();
    } finally {
      setBusy(false);
    }
  }

  return (
    <PermissionRequestCard
      language={language}
      interaction={interaction}
      busy={busy}
      onChoose={(optionId) => void submitPermission(optionId)}
      onCancel={() => void cancel()}
    />
  );
}
