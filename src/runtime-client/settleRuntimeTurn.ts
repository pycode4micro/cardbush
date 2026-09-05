/** Wait for both IPC paths, but never leave a failed command waiting forever
 * for a Turn that may not have been admitted. A short drain preserves terminal
 * frames already in transit (notably Stop). No terminal fact is synthesized.
 */
export async function settleRuntimeTurn<T>(
  stream: Promise<void>,
  command: Promise<T>,
  cancelStream: () => void,
): Promise<[void, T]> {
  const guardedCommand = command.catch(async (error: unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stream.catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    throw error;
  });
  try {
    return await Promise.all([stream, guardedCommand]);
  } finally {
    cancelStream();
  }
}
