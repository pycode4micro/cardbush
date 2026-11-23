let localModelWrite: Promise<void> = Promise.resolve();

/** Use one dispatch order for local catalogue writes and reasoning updates. */
export function enqueueLocalModelWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = localModelWrite.then(write);
  localModelWrite = result.then(() => undefined, () => undefined);
  return result;
}
