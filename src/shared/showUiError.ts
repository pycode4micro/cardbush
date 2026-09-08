let pendingError: Promise<void> | null = null;

/** Error presentation never reloads the renderer or resets a conversation. */
export function showUiError(title: string, message: string): Promise<void> {
  if (pendingError) return pendingError;
  pendingError = Promise.resolve().then(async () => {
    try {
      const showDialog = window.cardbushDesktop?.showErrorDialog;
      if (showDialog) {
        await showDialog({ title, message });
        return;
      }
    } catch (error) {
      console.error('Unable to show native error dialog', error);
    }
    window.alert(`${title}\n\n${message}`);
  }).finally(() => { pendingError = null; });
  return pendingError;
}
