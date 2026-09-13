# Renderer resources and running windows

A running window keeps the JavaScript module URLs from the build it opened. Opening review, source preview, Markdown or settings later can request a chunk for the first time. Deleting an older hashed chunk while that window is alive breaks this request even if a newer file implements the same component.

The local Vite build therefore uses `emptyOutDir: false`. Builds replace the entry documents and retain older content-addressed resources. Do not clear `dist/assets` during a live application session. This policy retains all earlier resources; it does not currently implement automatic garbage collection. Produce release packages from a fresh build directory/checkout so development history is not included in the package.

Optional React modules use `recoverableLazy`. Its local boundary handles loader rejection, records a diagnostic and retains the surrounding workspace. Diff fallback keeps source text, additions/deletions and line numbers. Source and Markdown fallback keep the document readable. Settings and other panels have a local unavailable state. Unrelated render errors still reach the owning error boundary.

Chromium can cache a failed native module URL for the lifetime of the document. Recreating `React.lazy` alone cannot reliably clear this cache. Syntax/Markdown fallbacks therefore stay usable without offering a misleading retry of decoration or automatically reloading a running conversation. The generic panel retry creates a new lazy component and clears any application-level rejected promise, but cannot promise recovery of a URL cached by Chromium. A subsequently opened window can use the available resources normally.

When adding an online updater, preserve the same lifecycle:

1. Download and validate a complete version into its own staging/version directory.
2. Publish the new entry/version pointer only after all referenced resources are available. Keep old windows bound to their original version.
3. Retire an older version only after all windows using it have closed. Downloads and update readiness must not force a reload of a running conversation.
4. Keep local fallback handling for interrupted downloads, damaged installations and missing resources; resource retention alone is not sufficient.

There is no online-updater installation flow implemented by this change. The existing NSIS packaging flow is separate from the local build policy above.

`npm run test:deferred-modules` builds twice while an isolated Electron window remains open and checks that every previous JavaScript chunk is preserved byte-for-byte. It then rejects actual module requests for review/source/Markdown, verifies their basic previews and retained draft/live workspace state, checks recovery in a fresh document, and exercises local panel retry. All builds and browser profiles are isolated under `tmp`.
