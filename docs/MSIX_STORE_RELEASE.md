# Microsoft Store MSIX release

CardBush can be packaged for the **MSIX or PWA app** submission path. This path
uploads a package to Microsoft; the Store hosts, signs and distributes updates.
The existing NSIS/EXE and Linux commands remain separate.

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
is unchanged; `1.0.0-beta.3` itself is not a valid MSIX version.

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
`docs/CROSS_PLATFORM_RELEASE.md`, then test an installed package in a separate
Windows test profile/VM and run the Windows App Certification Kit.

In particular verify:

- Startup, persistence, runtime child processes, terminal, bundled search, plugins,
  browser, update and uninstall behavior under the MSIX package identity.
- Notifications, taskbar identity and shortcut handling, which currently use the
  desktop application's AppUserModelID.
- Chrome connector: pair the real Chrome 116+ extension with the Broker over
  authenticated loopback WebSocket. Configuration belongs to the current
  package's LocalState/browser-connector directory. No Native Messaging
  registration, execution alias or virtualization exclusion is declared.
- Test explicit disable, credential revocation, app/browser restarts, occupied
  ports, upgrade and migration of any old external registration. The bundled
  cleanup command must run outside package identity after exiting CardBush.
- Test normal, running and post-crash system uninstall. Verify package data
  cleanup separately from old-installation migration; preserve user workspaces
  and the independently installed Chrome extension.
- runFullTrust certification notes explaining user-directed file, terminal and
  plugin operations. It does not grant administrator privileges.
- Windows 11 build 22000 or newer, x64, Simplified Chinese and English.

See [the implementation and evidence record](MSIX_CONNECTOR_REMEDIATION_PLAN_2026-09-28.md)
and [the revised submission draft](../packaging/msix/store-submission.zh-CN.md).

The [2026-09-29 installed validation](MSIX_INSTALLED_VALIDATION_2026-09-29.md)
records actual 1.0.4.0 Chrome, upgrade/migration and uninstall results, WACK
warnings, test-account limitations and the remaining Store-signed checks.

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
