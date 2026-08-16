# CardBush Desktop

[简体中文](README.zh-CN.md)

CardBush Desktop is the Electron client for BushServer. The desktop app owns the UI, projects, conversations, local desktop integration, and backend capability discovery. BushServer owns model access, agent orchestration, Skills, Tools, permissions, persistence, and task delegation.

## Release status

The current frontend development baseline is `1.0.0-dev`.

- Product functionality and delivery readiness are still under internal validation.
- The source build and frontend contracts are ready for continued integration testing.
- The unified Windows installer is not available yet. Electron-managed BushServer startup, runtime version negotiation, and installer packaging are the remaining delivery work.
- The RC version and release freeze will be decided after integrated packaging validation.

## Current capabilities

- SSE chat streaming, reasoning and tool output, stop, regenerate, message edit, and turn guidance.
- Project-scoped conversations, persisted history, running-state indicators, and workspace change review.
- Composer attachments, local file references, image input, permission modes, terminal runtime selection, Skills, Tools, and model selection.
- Read-only local previews for text, images, Word, Excel, and PowerPoint files.
- Personalization with cumulative token/activity statistics, plus appearance, language, proxy, models, MCP, Bots, runtime diagnostics, and local maintenance.
- Team workflow and backend-managed subagent status surfaces.

## Requirements

- Windows development environment
- Node.js `>=22.12.0`
- npm `>=10`
- A compatible BushServer checkout or service

End users of the future installer will not need Node.js or Python. These requirements apply only to source development while unified packaging is in progress.

## Development setup

Install dependencies and start the Vite, TypeScript, and Electron development processes:

```powershell
npm install
npm run dev
```

If Electron was installed without its binary or `path.txt`, repair it with:

```powershell
npm run fix:electron
```

Build and open the desktop app from source:

```powershell
npm run gui
```

## BushServer connection

Development builds use `http://127.0.0.1:51717` by default. Override it before building with:

```powershell
$env:VITE_BACKEND_BASE_URL='http://127.0.0.1:51717'
```

Port `51717` is only the development default. The packaged RC will let the Electron main process select an available localhost port, start the bundled BushServer process, and inject the runtime endpoint into the renderer.

The frontend treats `GET /v1/capabilities` as the source of truth for optional features. The packaging integration will additionally require `GET /readyz` for service version and compatibility negotiation.

## Validation

Run the complete frontend release gate:

```powershell
npm run test:all
```

It runs every `test:*` contract except itself, both TypeScript checks, the production build, and a final production-bundle cleanup check.

For faster iteration:

```powershell
npm run typecheck
npm run build
npm run test:release-cleanup
```

## Runtime data and diagnostics

The unified installer will follow this Windows layout:

```text
%LOCALAPPDATA%\CardBush\
├─ server-data\
├─ logs\
└─ crash\

%APPDATA%\CardBush\
└─ config\
```

Large runtime data, logs, caches, and crash reports belong in `%LOCALAPPDATA%`. Only small roaming user configuration belongs in `%APPDATA%`.

Scroll diagnostics are disabled in production unless `cardbush_scroll_debug` is explicitly set to `true` in local storage for a temporary diagnostic session.

## Frontend/backend boundary

- The frontend does not choose or register the main Agent profile.
- BushServer decides task delegation and owns the agent runtime.
- BushServer loads and manages MCP servers; the frontend edits configuration and displays state.
- Project mode sends the selected workspace path to BushServer; the frontend does not synthesize project context.
- Local resource paths are sent through request metadata and remain subject to backend permission boundaries.
- Runtime feature visibility comes from `/v1/capabilities`, not provider names or guessed endpoint availability.

The current frontend endpoints include:

- `GET /healthz`
- `GET /v1/capabilities`
- `POST /v1/chat/stream`
- `GET /v1/sessions`
- `GET /v1/sessions/{session_id}`
- `POST /v1/turns/{turn_id}/stop`
- `GET /v1/skills`
- `GET /v1/model-configs`
- `GET /v1/team-flows/{session_id}`
- `GET /v1/team-flows/{session_id}/graph`
- `POST /v1/team-flows/{flow_id}/actions`
- `GET /v1/subagents/capabilities`
- `GET /v1/subagents/runtime`
- `POST /v1/sessions/{session_id}/subagents/dispatch`
- `GET /v1/mcp/servers`

## Troubleshooting

### The desktop app cannot reach BushServer

1. Confirm BushServer is running.
2. Open the connection diagnostics in Settings.
3. Verify `/healthz` and `/v1/capabilities` on the configured development endpoint.
4. Check proxy bypass rules include `127.0.0.1`, `localhost`, and `::1`.
5. Review the frontend and BushServer logs before restarting either process.

### A feature is missing

Check `/v1/capabilities`. The UI intentionally hides or disables optional features that the connected backend does not declare.

### Electron fails to start after installation

For source development, run `npm run fix:electron`. Packaged-build failures should be reported with the application version, backend version, Windows version, and logs from `%LOCALAPPDATA%\CardBush\logs`.

## Repository layout

```text
electron/   Electron main process, preload bridge, and local desktop capabilities
src/        React UI, feature modules, and BushServer API client
scripts/    Development helpers and release contract checks
public/     Runtime static assets
docs/       Frontend/backend contracts and implementation checklists
```

## Security notes

- Electron renderer processes use context isolation, sandboxing, and no Node.js integration.
- The packaged BushServer must bind only to localhost and require a per-installation local request secret for API and SSE requests.
- Credentials and local request secrets must not be written to logs or passed in process command-line arguments.
- Do not attach `.env` files, credentials, raw logs, or user conversation databases to bug reports.
