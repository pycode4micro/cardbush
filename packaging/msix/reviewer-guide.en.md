# CardBush reviewer guide

For the current Windows 11 x64 MSIX with Browser Use extension 1.2.0. See the accompanying evidence for the exact package version, SHA-256 and completed tests. This guide is a procedure, not a claim that an unbuilt package passed it.

## Start and inspect

1. Install the submitted package using the review environment's normal MSIX procedure. Run CardBush as an ordinary user, not as administrator. Do not disable Windows security protections to make a failure disappear.
2. Open the application center at the bottom of the sidebar, then Settings > Browser. Chinese and English interfaces are available. Browser Use is a core capability; no third-party CardBush plugin is needed.
3. On a fresh installation the connector is disabled. Enable it explicitly. With no paired extension, it should report that the local bridge is ready and waiting for an extension.

## Pair Chrome and Edge

1. Choose Open extension folder. The bundled extension is at `<PackageInstallLocation>\app\resources\chrome-extension`; this historical directory name serves both browsers. No public extension-store listing is required by this bundled installation flow.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge. Enable extension Developer mode and use Load unpacked on the displayed directory. This is a browser extension setting, not a request to disable Smart App Control or alter Windows trust settings.
3. Confirm CardBush Browser Use version 1.2.0, ID `iibaamkfgackofhhpadgnmgcjkhckeln`. Reload a previous copy before testing.
4. Select the matching browser in CardBush, optionally label the connection, generate a code and paste it into that browser's extension popup, then Pair/Connect. Do not put pairing codes in screenshots or reports.
5. Repeat for the other browser. Both connections remain independent. Setting a default affects new, unbound CardBush sessions only.

## Verify page control

Setup, pairing and settings do not need a model account. Natural-language AI tasks need a configured model service. Reviewer-only credentials, if provided, belong in Partner Center's private testing information; none are bundled or included in this repository.

With a configured model, use a harmless test page and ask CardBush to create a page in the selected browser, read its heading, fill a test field, click a local test button and take a screenshot. Do not send messages, submit purchases or use personal accounts for review. Tools use the `browser_use` namespace.

- A session sees its own tab group. A personal tab must be selected and authorized in the extension before being copied into the chosen session group.
- Ask the agent to list connections and explicitly select a named connection to switch. A successful switch releases the old connected session's control and requires fresh page/element observations.
- Changing the default must not move an existing session. Disconnecting its browser must report unavailability instead of performing the task in another browser. Failed actions must not be automatically replayed.
- Stop control and page-authorization revocation in the extension release/prevent corresponding page operations.

## Verify revocation and restart

1. Remove one connection in CardBush. The other remains available. The removed credential must fail to reconnect until explicitly paired again.
2. Disable the connector. All connections close and all pairing credentials are revoked. Restarting CardBush must leave it disabled.
3. Re-enable and create fresh pairings. Ordinary CardBush exit/restart preserves enabled intent and pairings. A new browser session remains disconnected until an explicit Connect action.
4. Remove connector configuration. Bridge/pairing data and `routes.json` are removed; a disabled/removed preference marker remains. This is not a system uninstall.

## Verify installation and cleanup

Use a dedicated test account or VM without a user CardBush installation/data. Record the exact package hash, full package identity and LocalState path. Perform normal system uninstall, uninstall while running, and uninstall after terminating the test app; reinstall with fresh owned test state between scenarios. Inspect package registration and package/connector data after Windows finishes removal. Do not manually delete residue to make the check pass.

The connector creates no Native Messaging keys or external native-host manifests. When upgrading older releases that created them, CardBush reports verified legacy records and offers a fixed cleanup command. Run it after closing CardBush, outside package identity; it preserves unrelated files/registry values and supports a dry run. New-install uninstall does not automatically clear all historical external registrations.

User-created workspace files, browser profiles and separately loaded Chrome/Edge extensions are preserved intentionally. Another Windows user's package/data are separate; checking their presence does not substitute for cross-user access rejection testing.

## WACK and Store distribution

Run a complete Windows App Certification Kit session against the exact final package/test-signed counterpart. Preserve XML and logs. Record required failures, warnings and optional failures separately. For a DPI warning, inspect the actual EXE manifest and query the installed running process; do not rewrite WACK as PASS.

The current 1.0.5.0 package was tested with WACK 10.0.26100.7705: 22 PASS, one required DPI WARNING, one optional Blocked executables FAIL and zero required FAIL. The installed EXE declares `dpiAware=true/pm`; the running process reports per-monitor DPI awareness (2). WACK's warning is preserved. Process-creation APIs and command names account for the optional executable findings; S-mode support is not claimed.

Current installed testing ran on Windows 11 build 26200 with the host's existing UAC/Smart App Control settings off and administrator privileges. It does not establish ordinary-account, cross-account or protection-enabled compatibility. See the exact-package evidence and remaining checks. After Store certification/signing, validate the Store-delivered build with Windows security protections enabled; a local test-signed installation is not that validation.
