# Platform boundaries and releases

`@cardbush/platform/contracts` contains browser-safe types and pure capability
decisions. `@cardbush/platform` contains Node filesystem and process adapters.
Electron main uses the CommonJS export; Runtime uses ESM. Both are built from
the same sources. Do not import the Node entry into renderer code.

## Adding or changing a platform

- Add capability decisions and default Shell selection in `contracts.ts`.
- Resolve executables in `index.ts`, passing an injectable `PlatformContext` in tests.
- Keep executable paths, argument arrays and working directories separate. Never
  interpolate a working directory into Shell command text.
- Explicit unavailable command languages fail; an unavailable saved interactive
  terminal preference may fall back to the host's native Shell.
- `CARDBUSH_TERMINAL_SHELL` selects a single installed executable for the default
  embedded terminal, not an arbitrary command with arguments.
- IPC host capabilities drive the settings UI. Do not advertise Windows-only
  native services on Linux. A new supported platform needs native binaries,
  packaging rules and a real runner, not only a capability flag.

The Agent loop, provider configuration, user paths, application identity and
persisted settings remain owned by their existing modules. Refactoring does not
rename user-data directories or reset preferences. OS-specific native APIs remain
in their own adapters; consolidating every `process.platform` branch would hide
meaningful differences rather than improve portability.

## Release gate

1. `npm ci`, `npm run runtime-tools:install`, `npm run build`, type checking.
2. `npm run test:release`: Runtime, permissions, cancellation, malformed provider
   events, request-size recovery, process ownership, file boundaries, plugin/MCP
   behavior, platform contracts and Electron UI regression tests.
3. Build NSIS on Windows x64 and AppImage on Linux x64.
4. Launch packaged binaries with isolated user data and no provider credentials.
   Verify renderer readiness, Runtime and Product Host IPC, Unicode terminal
   output, bundled search and clean shutdown.
5. On an isolated Windows CI profile, install into a path containing spaces,
   launch the installed executable, then uninstall. Never run this check against
   a user's regular installation.
6. Launch the actual AppImage with extraction fallback under Xvfb; do not disable
   the Chromium sandbox in production or in the release launcher.
7. Generate SHA-256 checksums. Publish only the artifacts from the validated commit.

The workflow is `.github/workflows/desktop.yml`. Mock providers exercise the real
HTTP transport and allow deterministic adversarial tests without live credentials
or charges. A live provider check is only needed for a provider-specific behavior
that those fixtures cannot reproduce.

## Native assets and licenses

The ripgrep manifest pins archive and executable SHA-256 values for each target.
The installer reads only the expected regular files from a verified archive and
preserves its license notices. Cross-target verification checks bytes without
attempting to execute a foreign binary.

Windows process and Chrome hosts are included only in Windows packages. Linux
does not currently provide Windows-equivalent CPU/memory limits, computer use or
the Chrome native connector. Core terminal, search and integrated browser support
do not depend on those services.

Apache-2.0 applies to original CardBush code. Do not replace third-party licenses
when updating bundled assets. Preserve Electron/Chromium and dependency notices.
