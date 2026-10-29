# CardBush multi-account conversation website

[English](README.en.md) · [简体中文](README.md)

The website uses CardBush's persistent Agent service, replacing the old SOP UI/execution path. Its product assistant is “兆君服饰的招财”, with server-restricted personal-file reading, image observation and per-account approved image plugins. `--web-restricted` enforces the deployment policy in both model declarations and execution admission. Canonical realpaths are checked before/after Hooks and in native read permission; no arbitrary terminal/writes/browser/other users' files/config secrets/video/local automation are exposed. Remote video work uses the separate [registered-worker gateway](REMOTE_AGENTS.en.md), not a local bypass.

Administrators install/disable/remove the reviewed Volcengine image plugin and grant it per account. No arbitrary plugin-code upload is provided. Revocation applies at each image dispatch; already-dispatched calls may finish, and native lifecycle removes the plugin when idle while retaining receipts/results.

## Uploads and personal data

Uploads accept static PNG/JPEG/WebP, UTF-8 text, PDF and DOCX/XLSX/PPTX without video/embedded objects/macros. Limits: 16 MiB/file, eight attachments/four images/24 MiB per message. Chunk staging is outside readable directories, publication follows validation. Images are decoded/re-encoded; documents use the existing read-only parser in an isolated 128 MiB/12-second child with explicit truncation. PDF has no OCR; spreadsheet preview currently uses the first sheet.

Paste/drop/picker share browser preprocessing. Originals may be ≤64 MiB/64 million pixels; suitable images under 4 MiB stay unchanged, larger ones target 4 MiB proportionally. Screenshots prefer lossless PNG (8192 longest side/12MP); lossy fallback uses transparency-preserving WebP (4MP), also bounding NAS PNG re-encoding size. Format sniffing rejects animation/video/disguised input, independently of server 16 MiB/16MP checks. UI reports before/after size, upload progress/cancel; interrupted chunks reuse upload ID and one failed attachment does not cancel siblings.

Tests: `node --test scripts/test-web-uploads.mjs scripts/test-web-files-ui.mjs scripts/test-web-cache.mjs`. Browser fixture: `node scripts/fixtures/web-upload-browser.mjs dist-web` on loopback 5209 with synthetic alice/bob and any test password. Its generated 24MP/23.4 MiB images use the real personal-file handler, not real accounts/models.

## Account isolation

- Existing user_accounts/departments/auth_sessions retain IDs, scrypt passwords, departments and approval status. New users still need enablement; the first account in a fresh installation is administrator.
- cardbush_web_conversations owns conversations; read/write/stop/event streams always check current user. Administrators cannot use that role to read another person's chat.
- Each account has a non-root container, named volume, Agent instance, database, context and personal data. Browser input cannot choose conversation IDs or execution directories.
- Runtime containers only join an internal network, without public Internet, NAS roots, Docker socket, shared writable folders or other users' volumes. A separate model proxy holds provider secrets outside both user containers and browser.
- Only the trusted private broker holds Docker socket. Its API accepts hashed account identities and fixed image/arguments/mounts; no host ports are published.
- HttpOnly/SameSite=Strict cookies, origin/CSRF checks; HTTPS adds Secure. Sign-out/disable closes streams; persistent connections revalidate every 15 seconds. Private HTTP deployments must remain on trusted LANs.
- The browser uses restricted `/api/web/v1`, not owner Agent API or arbitrary Runtime/Product commands. Existing Agent Origin/Bearer checks remain unchanged.

## Organization administration

System administrators manage company/department trees and people, search by name/account/company/department and filter enabled state. Add/edit companies; add/rename/describe/move departments, unique within a company. Edit people/name/username/company/department/role/enabled/password. Moving departments does not change account IDs, files, conversation ownership or logins.

Companies with departments and departments with members cannot be deleted until reassigned. Deleting people revokes login/plugin grants and moves them to deleted while retaining username/ID/chats/files; restore returns pending/unaligned, requiring enablement and fresh plugin grants. The current administrator cannot delete/disable/demote itself. Department admins/members cannot bypass system-admin checks; organization membership never grants others' content access.

Legacy unassigned users stay unassigned; old departments move to a legacy company for explicit administrator adjustment. Registration supports company then department and retains approval. Migration handles old tables without defaults; inserts write flags/roles/timestamps explicitly. Transactions recheck administrator authority to prevent stale privileges.

For isolated PostgreSQL regression set CARDBUSH_TEST_DATABASE_URL to a fresh empty `cardbush_web_organization_test`, then `node --test scripts/test-web-organization.mjs`. Never point it at production. It covers migration, hierarchy CRUD/moves, deletion/restore, session invalidation and permissions.

## Configure and run

1. Back up PostgreSQL and the original website entry, and check old active tasks.
2. Build `docker build -f deploy/web/Dockerfile -t cardbush-web:RELEASE .`.
3. In a dedicated deployment directory, copy the example JSON files to config/web.json and config/broker.json. Generate two distinct strong random secrets and set database/model/domain. Restrict access to runtime UID 1100 and administrators; never commit them.
4. Set CARDBUSH_WEB_IMAGE, CARDBUSH_IDENTITY_NETWORK (existing DB network) and CARDBUSH_WEB_BIND. Initially retain `127.0.0.1:5198`; use permitted SSH forwarding, otherwise check locally without changing SSH policy. Configured origin must equal the browser's actual origin.
5. `docker compose up -d`. First account chat creates its container. At most three active account containers, never evict busy work; idle after ten minutes stops the container while preserving volume/history.
6. With two test users verify registration/approval, history, streaming, cross-account rejection, upload validation, questions, plugin revocation and tool boundaries.

Model management permits system administrators to edit/enable/delete/select defaults, protocol, model ID, endpoint, context/output and reasoning, plus image model/key. Keep a default enabled; switch before disabling/deleting it. Default max output is 128000 and reasoning medium, output must be smaller than context. New requests apply edits without container rebuild. Normal users choose models but cannot see keys/settings.

First start imports protected web.json; afterward cardbush_web_model_settings in PostgreSQL is authoritative. AES-256-GCM derives its key from modelSecret, responses only say whether a key is configured, blank preserves it and changing service origin requires re-entry. Revision checks reject racing edits. Back up both database and original modelSecret. Image gateway targets fixed Ark endpoints; models cannot choose URLs and account containers never hold provider keys. Tests: `test-web-model-admin.mjs/test-web-model-defaults.mjs`.

## Rendering, requests and artifacts

Queue/stop/SSE replay/compaction/resource management reuse native CardBush. Frontend shares MessageBubble, grouping/projection, execution folding, ToolExecutionBlock, Markdown and image preview. web/transcript.ts only adapts wire fields; NativeTranscript via ConversationHost provides protected files/tool records, nativeTranscript.css themes them. Commentary/tools stay within the same turn and final text appears once. Tool summaries load first, details on demand; both check ownership. Account image Blob cache survives conversation switches and releases on logout.

Model-proxy JSON limit is 40,000,000 bytes, including image Base64/history, independent of context/output tokens. Bounded queues cover read/parse/upload; the processing slot releases at provider response headers while SSE streams continue concurrently. Cancellation, disable and tool allowlists remain. `test-web-model-request-size.mjs` covers prior 16 MiB boundary, 40 MB, chunks, streams and isolation.

Image jobs reuse the plugin's SQLite receipts, idempotent submit, concurrency and generation_wait, not a new engine or automatic paid/unknown-outcome retry. Broker idle checks include both chat and image work. `test-web-transcript.mjs` and loopback 5210 `web-transcript-browser.mjs` (`/__test`, synthetic accounts) validate rendering without models. `build-web-release.mjs` records frontend dependency provenance without rebuilding Runtime.

Completed image replies show Artifacts beside copy/time, reusing TurnArtifactsMenu with download only. On opening, the server derives a list from actual owned image receipts and validates cited files; collages include source originals, including earlier generated images used this turn. Missing/invalid paths, uploads, video, external URLs and other users' files are excluded. Deduplicate by generated path, check only metadata and reuse original image Blob cache; never regenerate. Network failure permits retry.

Download all streams ZIP64 from 512 KiB per-account image reads directly to browser downloads, bypassing the old 128 MiB browser whole-archive limit. STORE avoids recompression; backpressure and cancellation/sign-out/revocation stop reads. Metadata/transfer share two global slots and one per account, with bounded queue. Short-lived tickets bind account/login and retain manifest/progress, not copied images or whole ZIP. Single downloads/previews keep their cache.

Artifact tests: `test-web-artifact-manifest.mjs/test-web-artifacts.mjs/test-web-transcript.mjs/test-web-files-ui.mjs/test-web-cache.mjs`; archive tests: `node --test scripts/test-web-archives.mjs`. Browser: start `node scripts/fixtures/web-progressive-browser.mjs dist-web`, then `python scripts/test-web-download-browser.py` (Python Playwright/Chrome); large tests add --large-archive and --large respectively. Production CSP, duplicate names, 32-image/160 MiB CRC, retry, caches and account switching are covered.

ScrollBottomButton/useScrollBottomPresence match desktop: show while reading upward, click follows latest immediately, hide when settled, no history/tool fetch, narrow/keyboard accessible. `image_convert` supports exact PNG/JPG/WebP dimensions; default proportional fit/padding preserves source, explicit center crop/stretch available. It runs per-account serially in a constrained process after grant recheck, uses normal artifacts/downloads and makes no image-generation request.

## Release and rollback

Use immutable image tags. Before replacing active containers check chat.jobs, never stop replying/queued sessions. Recreate idle owned containers with volumes retained; broker acts only on its labeled containers. Never `compose down -v` or delete user volumes.

Rollback stops the new web container and restarts the original frontend/backend, preserving new volumes/data. With a separate migrated database, later registrations/password/approval changes do not automatically flow back; reconcile before rollback. Do not delete old SOP data/materials or disguise them as Agent chats.

Run `npm run test:web` (real Runtime/two-user ACL) and `npm run build:web:ui`. In Linux image with writable test tmpfs: `node --test scripts/test-web-plugin.mjs scripts/test-web.mjs scripts/test-web-files-ui.mjs` verifies native plugin install, async images, revocation/removal and paths. Real PostgreSQL/Docker/browser acceptance remains necessary.

Dated NAS rollout records stay in their original language: [base](NAS-20261009.md), [uploads](NAS-20261010.md), [rendering](NAS-20261010-rendering.md), [artifact menu](NAS-20261011-artifacts.md), [progressive loading](NAS-20261016-progressive.md), [stream ZIP](NAS-20261016-stream-archive.md), [CSP fetch](NAS-20261016-artifact-fetch.md), [scroll](NAS-20261016-scroll-bottom.md), [conversion](NAS-20261016-image-convert.md). They are not certification of this source revision.

## Browser cache

After server-authenticated login, per-account memory/IndexedDB caches list/history/images, display cached content first and revalidate in background; refresh restores the recent conversation. Native event cursors/buffers preserve visible generation across the latest eight conversations. Memoized history avoids whole Markdown re-render per token; pending tasks include attachment metadata for immediate display.

IndexedDB limits: 40 conversations, 160 images, 128 MiB total, 12 MiB text, seven days; per conversation 2 MiB, image 16 MiB. Oversize reads still work from server. Memory data and unused object-URL pool each cap 24 MiB, active image references release on unmount. Unsupported/quota failures fall back. No credentials, CSRF or admin authority is cached. Logout/account switch/invalidation clears state/Blobs, cross-tab fences reject stale writes. Private API/files remain no-store; account cache avoids shared HTTP cross-user reuse.

Tests: `node --test scripts/test-web-cache.mjs scripts/test-web-files-ui.mjs`; loopback 5208 `web-cache-browser.mjs dist-web` can pause reads for slow-network switching/reload/logout checks with synthetic users, no production accounts/models.
