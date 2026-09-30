# Microsoft Store MSIX release

CardBush can be packaged for the **MSIX or PWA app** submission path. This path
uploads a package to Microsoft; the Store hosts, signs and distributes updates.
The existing NSIS/EXE and Linux commands remain separate.

The current submission target is **Windows 11 x64 only** (minimum build 22000),
with Browser Use for Chrome and Edge. This preparation does not build or publish
Linux/macOS packages, an EXE release, or an extension-store listing. A Store MSIX
does not require obtaining an independent public EXE signing certificate first.
See the [current preparation record](MSIX_SUBMISSION_PREPARATION_2026-09-29.md)
for actual artifact and validation status.

## Store identity

An EXE/MSI product's installer-URL form is not an MSIX upload form. First obtain an
MSIX/PWA product in Partner Center. Preserve existing drafts and name reservations;
if the desired name is already reserved by an EXE product, resolve the product type
and name with Partner Center support before deleting or recreating anything.

Open **Product management → Product identity**. Copy
`packaging/msix/identity.example.json` to `packaging/msix/identity.local.json` and
replace these values exactly:

| JSON field | Partner Center field |
| --- | --- |
| `identityName` | `Package/Identity/Name` |
| `publisher` | `Package/Identity/Publisher`, including `CN=` |
| `publisherDisplayName` | `Package/Properties/PublisherDisplayName` |
| `displayName` | The reserved product display name |

`version` is the explicit Store package version, such as `1.0.0.0`. Use four
integers, keep the last component zero, and increase the version for each update.
Do not reuse one version for different beta builds. The npm application version
in the source checkout is unchanged; `1.0.0-beta.5` itself is not a valid MSIX version.
The MSIX build injects its identity version into About and Copy environment, and
sets the packaged Electron version to the corresponding three-part SemVer. For
example, identity `1.0.5.0` displays `1.0.5.0` and packages Electron metadata as
`1.0.5`; EXE/AppImage and development builds retain their own source version.
Rebuild the package to apply this change; an existing MSIX is not modified.
Confirm the highest
version already used in Partner Center, including drafts/flights, before choosing
the next version. A previously generated local version is not evidence of the
highest server-side version. Do not invent a Publisher or derive it from a Store
product ID; restore the private local identity file or copy its public identity
values from Partner Center. Keep that machine-specific file out of Git.

## Build on Windows

```powershell
npm run package:msix -- --check
npm run package:msix
```

The script validates identity before building, verifies bundled tools, builds the
native hosts and app, generates Store logos from the existing CardBush icon, then
packages an x64 full-trust desktop application. It uses electron-builder 26's
AppX target and Microsoft MakeAppx **directly writing `.msix`**. The complete
Microsoft Windows SDK BuildTools 10.0.26100.9169 NuGet package is downloaded into
`tmp/msix-sdk/` and verified against its pinned SHA-256 before extracting tools.
This avoids the side-by-side dependency failure in electron-builder's SDK bundle.
The script probes MakeAppx before compiling and supplies its directory through
`ELECTRON_BUILDER_WINDOWS_KITS_PATH` for this process only. No system SDK installation
is needed. MakeAppx schema and semantic validation remain enabled.

Outputs use a fresh directory under `release-msix/`. Upload the `.msix` file after
validation. `SHA256SUMS.txt` and `msix-build-report.json` accompany it. The script
does not install certificates or packages, upload, save Partner Center forms, or
submit for certification. Local signing is disabled for this Store-only artifact.
An unsigned Store package is not an ordinary double-click sideload installer.

To check packaging without a real Store identity:

```powershell
npm run test:msix
npm run package:msix -- --test
```

Test output is isolated in `release-msix-test/` and named `TEST-ONLY-*.msix`.
**Never upload it**: its identity is deliberately not your Store identity.

## Validation before submission

The package builder validates its manifest, identity, required files and checksum,
extracts the actual MSIX with MakeAppx, then runs the application and native host
smoke checks against those extracted files with isolated temporary user data.
It also records source revision, whether the working tree had modifications,
SDK provenance and a smoke report beside the artifact. An extracted smoke pass
does **not** prove installed MSIX behavior. Complete the normal release gate in
`docs/CROSS_PLATFORM_RELEASE.md` for the Windows MSIX channel, then test an installed
package in a separate Windows test profile/VM and run the Windows App Certification
Kit. The signed EXE/Linux distribution gates belong to those other channels.
`--stage-only` deliberately leaves runtime verification pending; it is not a
shortcut to a submission-ready claim.

In particular verify:

- Startup, persistence, runtime child processes, terminal, bundled search, plugins,
  browser, update and uninstall behavior under the MSIX package identity.
- Notifications, taskbar identity and shortcut handling, which currently use the
  desktop application's AppUserModelID.
- Browser Use: pair real Chrome and Edge with bundled extension **1.2.1** over
  authenticated loopback WebSocket. Reload old loaded extension copies first.
  Validate simultaneous independent pairings, default selection, explicit switching,
  session isolation and individual revocation. Configuration belongs to the current
  package's LocalState/browser-connector directory. No Native Messaging
  registration, execution alias or virtualization exclusion is declared.
- Check `preference.json`, `pairing.json`, `routes.json` and active `bridge.json`.
  Ordinary exit preserves pairings/bindings; Disable revokes all credentials while
  retaining bindings; Remove configuration also removes `routes.json`. No revoked
  or offline session may silently use another browser or replay an uncertain action.
- Test explicit disable, credential revocation, app/browser restarts, occupied
  ports, upgrade and migration of any old external registration. The bundled
  cleanup command must run outside package identity after exiting CardBush.
- Test normal, running and post-crash system uninstall. Verify package data
  cleanup separately from old-installation migration; preserve user workspaces
  and the separately installed Chrome/Edge extensions.
- runFullTrust certification notes explaining user-directed file, terminal and
  plugin operations. It does not grant administrator privileges.
- Windows 11 build 22000 or newer, x64, Simplified Chinese and English.

Record exact tested OS and browser versions. The extension's declared Chromium
116 API minimum is not proof of a tested minimum-version matrix. Keep second-user
isolation, minimum-version coverage and Store-signed validation explicit when
unverified. `scripts/test-browser-use-native.mjs` covers real Chrome/Edge in
isolated headless profiles at source level; it does not substitute for installed
MSIX tests. `scripts/verify-installed-chrome.mjs` exercises the installed app's
preload/IPC and package identity; the reviewer guide also covers the two-browser
workflow.

See [the implementation and evidence record](MSIX_CONNECTOR_REMEDIATION_PLAN_2026-09-28.md)
and [the revised submission draft](../packaging/msix/store-submission.zh-CN.md).

The [2026-09-29 installed validation](MSIX_INSTALLED_VALIDATION_2026-09-29.md)
records actual 1.0.4.0 Chrome, upgrade/migration and uninstall results, WACK
warnings, test-account limitations and the remaining Store-signed checks.
That report used extension 1.1.0 and is historical evidence for its named hash;
it must not be relabeled as validation of a newer Browser Use package. WACK
warnings and optional failures must be reported separately from required failures.

The [current 1.0.5.0 preparation record](MSIX_SUBMISSION_PREPARATION_2026-09-29.md)
includes installed Chrome/Edge, three system-uninstall scenarios and a complete
WACK run against the new candidate, with the actual administrator/UAC-disabled
test environment explicitly recorded. It does not replace outstanding standard-user,
minimum-version or Store-signed/protection-enabled validation.

## Manual handoff to the publisher

Prepare the final unsigned MSIX, its SHA256SUMS.txt, build/runtime reports, installed
validation and raw WACK reports. Include the [certification note](../packaging/msix/notes-for-certification.en.txt),
[eight review responses](../packaging/msix/store-submission.zh-CN.md) and
[reviewer guide](../packaging/msix/reviewer-guide.en.md). Never upload test identities,
test-signed copies, certificates, browser profiles or credentials.

The publisher checks Partner Center identity/version, store listing/privacy text,
restricted-capability justification, reviewer access and the uploaded package's
parsed requirements before manually submitting. Source preparation must not upload,
submit, publish or modify the Partner Center draft. After certification and Store
signing, install the Store-delivered build and validate it with Windows security
protections enabled. That post-certification check is distinct from local
pre-submission validation; it is not claimed complete in advance.

For privacy text, review actual MSIX data-retention behavior before reusing the
NSIS statement that uninstall preserves user data. Packaging can change storage
and uninstall semantics.

References:

- https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details
- https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool
- https://www.nuget.org/packages/Microsoft.Windows.SDK.BuildTools/10.0.26100.9169
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages
- https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization
- https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap5-appexecutionalias
