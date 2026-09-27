# Platform boundaries and releases

For the shared Runtime, Product Host, desktop/Agent adapters and data ownership,
see [current architecture](ARCHITECTURE.md). Desktop installation and an independent
Agent service are separate deployment targets; updating one does not update the other.

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
3. Build signed NSIS on Windows x64 and AppImage on Linux x64. Tagged Windows
   builds use `electron-builder.release.yml`, require a publisher certificate,
   and audit the installer and packaged EXE/DLL/Node binaries. A missing signing
   identity is a release failure, not a reason to fall back to the development build.
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

## Preparing and publishing a version

1. Start from the intended, reviewed commit and preserve unrelated working changes.
   Update the root `package.json` and both root version entries in `package-lock.json`
   together (`npm version VERSION --no-git-tag-version --ignore-scripts`). Workspace
   package versions are independent and do not need a blanket bump.
2. Update both READMEs, installer filenames/links and `docs/releases/VERSION.md`.
   Record changes since the previous public tag and upgrade requirements. Synchronize
   current architecture, Agent, permission or plugin documentation when behavior has
   changed; retain historical release notes as historical records.
3. Configure repository Actions secrets `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`
   for Windows publisher signing. Keep certificate contents and passwords out of
   source files, commands, logs and release notes. The workflow does not reference
   a GitHub Environment, so environment-only secrets are not sufficient.
4. Run the relevant local checks, including `npm run test:release-cleanup`, and
   review the final diff. Commit the release preparation and push an annotated
   `vVERSION` tag whose version exactly matches the root package.
5. Wait for **both** build jobs and the publish job in **Desktop builds**. A green
   main-branch build only uploads Actions artifacts, including an unsigned Windows
   development installer; it does not create or refresh a public Release. The
   `publish` job runs only for `v*` tags, checks the version and both checksums,
   uploads to a draft, then publishes it as a prerelease.
6. Verify the public tag, both versioned installers, per-platform checksum files
   and startup reports. Report the release URL only as published once that state
   is confirmed. If publication fails, keep the previous public release available
   and identify the failed gate rather than uploading unvalidated replacements.

An existing public release is immutable in this workflow: the publish step refuses
to replace its files. Fixes to an already published version need a new version and
tag. MSIX Store staging is a separate path described in [MSIX packaging](MSIX_STORE_RELEASE.md);
its configuration belongs in source control, generated packages do not.

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
