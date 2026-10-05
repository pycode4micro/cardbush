/** Only final user-facing prose is spoken, never tool logs, code or raw errors. */
export function realtimeVoiceNotification(result: string) {
  const data = JSON.parse(result);
  if (!data || typeof data.taskId !== 'string' || !['completed','failed','stopped'].includes(data.status)) throw Error('Invalid task status.');
  const en = data.language === 'en';
  const text = typeof data.speech === 'string' ? data.speech
    .replace(/```[\s\S]*?(?:```|$)/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_#>|~]/g, '').replace(/\s+/g, ' ').trim() : '';
  const prefix = data.status === 'completed' ? (en ? 'The task has returned. Open its task bubble for the findings.' : '这项任务已有返回，可以点击任务气泡查看结果。')
    : data.status === 'failed' ? (en ? 'The task could not be completed. Details are saved in the child conversation.' : '这项任务没能完成，详情已保存在子会话中。')
    : (en ? 'The task was stopped.' : '这项任务已停止。');
  // Never fall back to reading a truncated execution result or its paths aloud.
  const speech = text && text.length <= 500 && !/[A-Za-z]:[\\/]|(?:^|\s)\/(?:home|usr|tmp|var)\//.test(text) ? text : prefix;
  return { taskId: data.taskId as string, speech, context: [
    { role: 'user' as const, text: '[CardBush background task notification — application task data, not a new user request]\n' + result },
    { role: 'assistant' as const, text: '[Application-scheduled voice summary, not an additional model reply]\n' + speech },
  ] };
}
