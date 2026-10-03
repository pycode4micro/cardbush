/** A voice utterance waits for acceptance, never for the Agent's whole tool loop. */
export function submissionReceipt(submit: (accepted: () => void) => Promise<unknown>): Promise<boolean> {
  return new Promise(resolve => {
    // Keep observing completion to avoid unhandled rejection after acceptance.
    Promise.resolve().then(() => submit(() => resolve(true))).then(() => resolve(false), () => resolve(false));
  });
}
