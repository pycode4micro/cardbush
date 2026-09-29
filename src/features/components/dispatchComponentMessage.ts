/** A component receives a dispatch receipt, never waits for the entire model turn. */
export async function dispatchComponentMessage(text: string, host: {
  ready: boolean;
  model: string;
  send: (text: string) => Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  if (!host.ready) throw new Error('RUNTIME_NOT_READY');
  if (!host.model.trim()) throw new Error('MODEL_REQUIRED');
  void host.send(text).catch(host.onError);
}
