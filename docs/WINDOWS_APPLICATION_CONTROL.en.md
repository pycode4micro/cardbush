# Windows application control and release acceptance

[English](WINDOWS_APPLICATION_CONTROL.en.md) · [简体中文](WINDOWS_APPLICATION_CONTROL.md)

The [2026-09-28 investigation](WINDOWS_BLOCKING_INVESTIGATION_2026-09-28.md) and dated certificate-provider research remain historical records. This page documents the current handling and release obligations; it does not claim that a certificate has been obtained or that all Windows policies allow the binaries.

## Development and runtime behavior

The 2026-09-21 failures involved ten tests sharing one unsigned `resource worker.exe` fixture, blocked with Win32 4551 and Code Integrity 3077/3033. They were not ten proven product defects, nor passing tests. Unsigned native helpers also need release attention. Do not ask users to disable Smart App Control, add exclusions or run as administrator to bypass it.

Local `npm run gui` / `npm run dev` may continue building UI when the native process host cannot start, with the original error and Code Integrity log location. A failed candidate never replaces `current.json`; command execution still requires a working protection helper. Failed-candidate source/binary fingerprints avoid rebuilding on every GUI launch and invalidate when source, script or candidate changes. After repair, use `npm run gui:rebuild`. Normal build, CI and release checks remain strict; compilation/protocol mismatch also fails development startup.

Process protection classifies 4551/1260 as `process_application_control_blocked` and 577 as `process_signature_rejected`, preserving code and target path. Missing files, ordinary permission errors and unknown starts are not mislabeled. DLL blocking after process creation still requires Code Integrity logs. There is no fallback to an unprotected process, disabling security, or full-disk signature scan before every command.

Computer Use stops retrying an explicit application-control/signature denial for that turn. Reobserving, changing windows or compiling another DLL does not fix it; after repair a new turn may check again. Browser connection recovery pauses after three failures and survives extension worker restart until manual retry.

## Signing and packaging

- `npm run package:win` uses mandatory signing in `electron-builder.release.yml`, covering EXE, DLL and Windows native Node modules. Recursively verify unpacked output after signing and the installer after packaging; missing/invalid signatures fail the build. `v*` release tags use the same policy. Branch/PR packages and `package:dir` are internal development artifacts, not automatic public releases.
- Configure a publicly trusted RSA/ECC code-signing identity using `win.signtoolOptions` or `win.azureSignOptions`. Current tag workflow reserves `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for compatible certificate delivery; managed signing needs its own configuration. Never commit private keys/passwords. Missing identity must fail a public Windows build.
- A local trust-chain result is not proof of public CA eligibility; local self-signed trust can appear valid. Acceptance also requires the supported algorithm, trusted public publisher and timestamp. Corporate application-control policy can still impose further restrictions.
- Computer Use operation libraries/overlays are compiled at build time. Missing release libraries fail explicitly; users do not compile unsigned replacement DLLs. EXE/DLL/native modules live outside ASAR and enter signature checks.
- `npm run release:check:win` checks signing prerequisites early, not completed signing. `npm run release:check:msix` checks Store identity format; Partner Center identity is not an EXE certificate/private key.
- `npm run package:msix:stage` creates an unsigned Store upload staging package and validates build, manifest, resources and packaged privacy. Its report retains `signed:false`, `releaseReady:false` and unfinished checks. Ordinary `package:msix` still requires runtime verification. Validate Partner Center identity/version and the actual Store-installed package; staging output is not a general-user signed release.
- Scan ASAR and external assets for private keys, signing configuration and local session/credential directories. This catches common packaging mistakes, not every privacy issue.
- SSH uses upstream JavaScript/Node crypto without optional `cpu-features` or `sshcrypto.node` acceleration. Other production native dependencies still use Electron rebuild.

## Acceptance

Use a clean Windows environment with Smart App Control enabled. Test installation, first start, process protection, terminal commands, search and browser connection, including dynamically loaded DLL/native modules. Sign temporary test fixtures through the test release process; skipping blocked tests is not passing.

Plugins own the trust of downloaded/bundled Python, DLL and native dependencies; host signing does not cover later installations. Source development remains possible, but executable dependencies need trusted, pinned versions and their own acceptance. An outer EXE does not make an internal `llvmlite.dll` trusted.

Historical SignPath/Certum/Artifact Signing eligibility and pricing research is retained in the [original dated section](WINDOWS_APPLICATION_CONTROL.en.md), not presented as current purchasing advice. Recheck official eligibility before purchase.

See Microsoft's [Smart App Control FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions), [code-signing requirements](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control), and [application/driver control](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control).
