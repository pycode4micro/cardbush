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
- Chrome native messaging: the manifest requests `unvirtualizedResources` so
  browsers can read `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.cardbush.browser_connector`.
  Windows 11 excludes only this key from virtualization; Windows 10 uses the
  older registry-wide opt-out. File virtualization remains enabled. Setup
  registers the manifest's physical path, and the native host finds `bridge.json`
  beside that manifest. MSIX registers the console `CardBushBrowserHost.exe`
  app execution alias under the user's `Microsoft\WindowsApps` directory as
  the native manifest's launch path. Do not resolve this alias to a protected
  package executable: an unpackaged browser must be able to activate the host
  and preserve its stdin/stdout pipes. The console alias requires
  `desktop4:SupportsMultipleInstances="true"` on its Application declaration.
  The extension waits for an authenticated broker handshake
  before reporting connected. Verify the installed package and real browser in
  the same Windows account. External registry entries survive uninstall, so
  account for a stale registration when testing uninstall/reinstall.
  Checking the registry or loading the host assembly alone is insufficient:
  launch the registered alias from a standard unpackaged process and verify
  native-message framing, then verify a round trip through the real extension.
- `runFullTrust` certification notes explaining the AI workspace's file, terminal
  and plugin operations. The manifest declares this capability for Electron; it
  does not grant administrator privileges.
- `unvirtualizedResources` certification notes: CardBush registers its local
  Native Messaging host so the user's browser extension can communicate with
  the running desktop application. Windows 11 registration is scoped to the
  single key above. No file-system virtualization exclusion is requested.
- The Store version currently targets Windows 10 build 19041 or newer, x64, with
  Simplified Chinese and English resources.

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
