/* Task-owned downloads. Never observe, cancel or rename unrelated downloads. */
function createDownloadManager(chrome) {
  const storageKey = 'cardbushDownloadTasks';
  const tasks = new Map();
  const waiters = new Map();
  let persistence = Promise.resolve();
  const terminal = task => ['complete', 'interrupted', 'cancelled'].includes(task.state);
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const ready = chrome.storage.session.get([storageKey]).then(stored => {
    for (const task of Array.isArray(stored[storageKey]) ? stored[storageKey] : []) {
      if (typeof task.taskId === 'string' && typeof task.scopeId === 'string' && typeof task.requestKey === 'string') tasks.set(task.taskId, task);
    }
  });
  void ready.catch(() => {}); // Calls still receive restoration failures when awaiting ready.
  const persist = () => {
    const snapshot = structuredClone([...tasks.values()]);
    persistence = persistence.catch(() => {}).then(() => chrome.storage.session.set({ [storageKey]: snapshot }));
    return persistence;
  };
  const changed = task => {
    task.updatedAt = Date.now();
    for (const resolve of waiters.get(task.taskId) || []) resolve();
    void persist().catch(() => {}); // The durable start record can recover progress via Chrome's download ID/path.
  };
  const publicTask = (task, reused = false) => ({ taskId: task.taskId, state: task.state, reused,
    ...(Number.isInteger(task.downloadId) ? { downloadId: task.downloadId } : {}),
    bytesReceived: task.bytesReceived || 0, totalBytes: task.totalBytes ?? -1,
    ...(task.state === 'complete' ? { filename: task.filename } : {}),
    ...(task.error ? { error: task.error } : {}),
  });
  const requireApi = () => {
    if (!chrome.downloads) throw failure('downloads_permission_required', 'Reload CardBush Browser Connector 1.0.2 or later and enable its downloads permission.');
  };
  const owned = (scope, taskId) => {
    const task = tasks.get(taskId);
    if (!task || task.scopeId !== scope.id) throw failure('download_task_missing', 'No such download task belongs to this session.');
    return task;
  };
  const apply = (task, item) => {
    task.downloadId = item.id;
    task.bytesReceived = item.bytesReceived;
    task.totalBytes = item.totalBytes;
    task.filename = item.filename;
    task.error = item.error;
    task.state = item.state === 'interrupted' && (item.error === 'USER_CANCELED' || task.cancelRequested) ? 'cancelled' : item.state;
    if (task.cancelRequested && !terminal(task)) task.state = 'cancelling';
    changed(task);
  };
  const refresh = async task => {
    let items;
    if (Number.isInteger(task.downloadId)) items = await chrome.downloads.search({ id: task.downloadId });
    else {
      // Recover a start accepted by Chrome just before the service worker stopped.
      items = await chrome.downloads.search({ filenameRegex: task.taskId, limit: 2 });
    }
    let item = items[0];
    if (item && task.cancelRequested && item.state === 'in_progress') {
      // A worker may have stopped before Chrome acknowledged the original start.
      await chrome.downloads.cancel(item.id);
      item = (await chrome.downloads.search({ id: item.id }))[0] || item;
    }
    if (item) apply(task, item);
    return task;
  };
  chrome.downloads?.onChanged.addListener(delta => {
    void ready.then(async () => {
      const task = [...tasks.values()].find(task => task.downloadId === delta.id);
      if (task) await refresh(task);
    }).catch(() => {});
  });
  const safeFilename = name => {
    if (!name) return 'download';
    if (typeof name !== 'string' || name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /^\.+$/.test(name)
      || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
      throw failure('download_filename_invalid', 'Use a filename without directories or reserved characters.');
    }
    return name;
  };
  return {
    async start(scope, params) {
      await ready;
      requireApi();
      if (typeof params.requestKey !== 'string' || !params.requestKey || params.requestKey.length > 160) throw failure('download_key_invalid', 'A request key is required.');
      const existing = [...tasks.values()].find(task => task.scopeId === scope.id && task.requestKey === params.requestKey);
      if (existing) return publicTask(await refresh(existing), true);
      let url;
      try { url = new URL(params.url); } catch { throw failure('download_url_invalid', 'Expected a download URL.'); }
      if (!['https:', 'http:', 'blob:', 'data:'].includes(url.protocol)) throw failure('download_url_invalid', 'Use HTTP(S), blob or data URLs. Use export_image for generated images.');
      if (url.protocol === 'data:' && params.url.length > 512 * 1024) throw failure('download_url_too_large', 'Use export_image for large generated images; do not pass their bytes back through tool arguments.');
      const filename = safeFilename(params.filename || (() => { try { return /^https?:$/.test(url.protocol) ? decodeURIComponent(url.pathname.split('/').pop() || 'download') : 'download'; } catch { return 'download'; } })());
      if ([...tasks.values()].filter(task => task.scopeId === scope.id && !terminal(task)).length >= 20) throw failure('download_limit', 'There are already 20 pending downloads. Check or cancel existing tasks.');
      // Keep active tasks. Retire only old completed records, never restart a pending job.
      for (const [id, task] of tasks) if (terminal(task) && Date.now() - task.updatedAt > 7 * 86400_000) tasks.delete(id);
      const task = { taskId: `download-${crypto.randomUUID()}`, scopeId: scope.id, requestKey: params.requestKey,
        state: 'starting', createdAt: Date.now(), updatedAt: Date.now(), bytesReceived: 0, totalBytes: -1 };
      tasks.set(task.taskId, task);
      try { await persist(); }
      catch { tasks.delete(task.taskId); throw failure('download_state_unavailable', 'Download was not started because its task record could not be saved.'); }
      // Do not await a browser save/policy prompt. The durable task prevents duplicate starts.
      void Promise.resolve().then(() => chrome.downloads.download({ url: url.href, filename: `CardBush/${task.taskId}/${filename}`, saveAs: false, conflictAction: 'uniquify' }))
        .then(async id => {
          task.downloadId = id;
          task.state = task.cancelRequested ? 'cancelling' : 'in_progress';
          changed(task);
          await refresh(task);
        }, error => {
          task.state = task.cancelRequested ? 'cancelled' : 'interrupted';
          task.error = error instanceof Error ? error.message : String(error);
          changed(task);
        }).catch(error => {
          // Failure to query progress is not proof that the browser download failed.
          task.error = `Unable to refresh download status: ${String(error)}`;
          changed(task);
        });
      return publicTask(task);
    },
    async status(scope, params) {
      await ready;
      requireApi();
      const task = await refresh(owned(scope, params.taskId));
      const waitMs = Math.max(0, Math.min(Number(params.waitMs) || 0, 20_000));
      if (!terminal(task) && waitMs) {
        await new Promise(resolve => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            const listeners = waiters.get(task.taskId);
            listeners?.delete(done);
            if (!listeners?.size) waiters.delete(task.taskId);
            resolve();
          };
          const listeners = waiters.get(task.taskId) || new Set();
          waiters.set(task.taskId, listeners); listeners.add(done);
          timer = setTimeout(done, waitMs);
        });
        await refresh(task);
      }
      return publicTask(task);
    },
    async cancel(scope, params) {
      await ready;
      requireApi();
      const task = owned(scope, params.taskId);
      if (!terminal(task)) {
        task.cancelRequested = true;
        task.state = 'cancelling';
        changed(task);
        await refresh(task);
      }
      return publicTask(task);
    },
  };
}
