/** Task results are contextual data. Only the conversational model decides what to say. */
export function realtimeVoiceNotification(result: string) {
  const data = JSON.parse(result);
  if (!data || typeof data.taskId !== 'string' || !['completed','failed','stopped'].includes(data.status)) throw Error('Invalid task status.');
  const facts={taskId:data.taskId,status:data.status,
    result:typeof data.result==='string'?data.result.slice(0,5000):'',error:typeof data.error==='string'?data.error.slice(0,1000):''};
  return { taskId: data.taskId as string, status:data.status as string, context: [
    { role: 'user' as const, text: '[CardBush background task notification — application task data, not a new user request]\n' + JSON.stringify(facts) },
    { role: 'assistant' as const, text: '[Saved task availability, not spoken to the user. Proactively mention it once in one casual sentence at a natural pause in the ongoing conversation; do not wait for the user to raise the task. Address their current topic first, without interrupting or reading out results. Ask whether to revisit the earlier question before discussing these findings. If the user defers, declines or does not take up the offer, do not repeat it. A failed or stopped task is not a successful result.]' },
  ] };
}
