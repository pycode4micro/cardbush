import { webContents, type BrowserWindow, type WebContents } from 'electron';
import { matchHistoryInput, type HistoryBinding, type HistoryDirection, type HistoryInput } from './shortcutBinding';

export function installWindowHistoryInput(window: BrowserWindow) {
  const owner = window.webContents;
  let bindings: HistoryBinding[] = [];
  owner.ipc.on('window:history-bindings', (event, entries: HistoryBinding[]) => {
    if (event.senderFrame !== owner.mainFrame || !Array.isArray(entries) || entries.length > 4) return;
    bindings = entries.filter(entry => (entry?.direction === 'back' || entry?.direction === 'forward')
      && typeof entry.binding?.key === 'string');
  });
  const send = (direction: HistoryDirection, source?: WebContents) => {
    if (owner.isDestroyed() || source?.isDestroyed() || (source && source !== owner && source.hostWebContents !== owner)) return;
    const input: HistoryInput = { direction, guestId: source && source !== owner ? source.id : undefined };
    owner.send('window:history-input', input);
  };
  // Some drivers also emit an OS app-command for the same X-button click.
  // Pair only opposite sources; consecutive clicks from one source are independent.
  let lastMouse: { direction: HistoryDirection; source: 'button' | 'command'; time: number } | undefined;
  const mouse = (direction: HistoryDirection, source: 'button' | 'command') => {
    const time = performance.now();
    if (lastMouse?.direction === direction && lastMouse.source !== source && time - lastMouse.time < 160) {
      lastMouse = undefined;
      return;
    }
    lastMouse = { direction, source, time };
    send(direction, webContents.getFocusedWebContents() ?? undefined);
  };
  window.on('app-command', (event, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') return;
    event.preventDefault();
    mouse(command === 'browser-backward' ? 'back' : 'forward', 'command');
  });
  const attach = (contents: WebContents) => {
    contents.on('before-mouse-event', (event, input) => {
      // Electron reports these two additional Chromium button names at runtime.
      const button: string | undefined = input.button;
      if (button !== 'back' && button !== 'forward') return;
      if (input.type !== 'mouseDown' && input.type !== 'mouseUp') return;
      event.preventDefault();
      if (input.type === 'mouseUp') mouse(button, 'button');
    });
    contents.on('before-input-event', (event, input) => {
      // Host DOM key events are handled in the renderer, including shortcut recording.
      if (contents === owner && (!owner.focusedFrame || owner.focusedFrame === owner.mainFrame)) return;
      const direction = matchHistoryInput(bindings, { key: input.key, code: input.code, ctrlKey: input.control,
        metaKey: input.meta, shiftKey: input.shift, altKey: input.alt, isComposing: input.isComposing });
      if (!direction) return;
      event.preventDefault();
      if (input.type === 'keyDown' && !input.isAutoRepeat) send(direction, contents);
    });
  };
  attach(owner);
  owner.on('did-attach-webview', (_event, guest) => attach(guest));
}
