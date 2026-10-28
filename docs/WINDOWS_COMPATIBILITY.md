# Windows compatibility

Current source builds target **Windows 10 version 1809 (build 17763) or later,
x64**, including Windows 10 LTSC 2019/2021, Windows 10 22H2 and Windows 11.
This is the shared desktop and MSIX baseline. The published Microsoft Store
package keeps its own requirements until a new package is certified and released.

`minimumWindowsVersion` and `windowsReleaseSupported` in `@cardbush/platform`
define the runtime policy. Desktop startup and Browser Use both use it. The MSIX
manifest is checked against the same minimum in regression tests. Do not infer
Windows 11 from kernel major version 10 or gate browser functionality on build
22000: Windows 10 and Windows 11 both report kernel major version 10.

Windows 10 uses the ordinary opaque window background. Mica is enabled only on
Windows 11 build 22621+ with an available compositor and compatible accessibility
and theme settings. The appearance fallback does not disable application features.
Browser Use retains explicit connection approval, page authorization and session
isolation on both operating systems. MSIX retains normal package virtualization;
Windows 10 support does not add registry exemptions or restricted capabilities.

The desktop distribution includes Electron/Node and native helpers. Terminal
execution requires PowerShell 7; Git repository operations require Git for Windows.
The internal plugin collection includes its own Python/Node runtimes and media
dependencies. Business accounts, NAS permissions and optional hardware drivers
remain separate requirements. This compatibility change does not copy credentials
or alter plugin business permissions.

## Validation

Run `npm run test:windows-compatibility`, `npm run test:ui-localization`,
`npm run test:app-views`, the settings/browser connection regressions, type checks
and the production build. The version matrix includes the 1809 boundary, LTSC
2021, 22H2, Windows 11, malformed versions and older Windows rejection. Language
tests verify action-time translation changes; appearance tests verify both themes
without Mica on Windows 10.

Run the packaged executable outside the source checkout with an isolated user
profile on Windows 10 and Windows 11. Verify renderer/runtime startup, terminal,
search, plugin discovery, bundled resources and clean shutdown. Validate plugin
EXEs from a fresh installation with system-only PATH and isolated configuration;
exercise bundled media runtimes without network model downloads or paid calls.
Passing one Windows 10 build does not establish coverage of every LTSC patch,
GPU/driver, account configuration or Microsoft Store installation scenario.

The [2026-10-28 validation record](validation/windows-compatibility-2026-10-28.json)
records the tested Windows 10 LTSC 2021 and Windows 11 builds. Store installation,
1809/LTSC 2019 and 22H2 hardware coverage remain separate from these results.
