# CardBush Browser Use

This Manifest V3 extension connects Chrome and Microsoft Edge profiles on Windows 11 to
the CardBush Broker through separately paired loopback WebSockets (Chromium 116+ APIs).
It never starts a separate browser profile or creates a Native Messaging registry entry.

Development installation:

1. Run CardBush on Windows 11, enable Browser Use in Browser settings, select Chrome or Edge, optionally name the connection, and generate a pairing code.
2. Open `chrome://extensions` or `edge://extensions` in that browser, enable Developer mode, and choose **Load unpacked**.
3. Select this directory. Paste the five-minute pairing code into the extension popup and choose **Pair and connect**. Pairing does not grant page access. Start a browser task in CardBush. New tabs are
   placed in a cyan group named for that CardBush session. The connector only
   lists and controls tabs in that session's groups.
4. To use an existing personal tab, open the extension popup and explicitly
   copy it into the active CardBush group. The original tab remains untouched.

Version 1.2.0 adds browser-bound pairing and concurrent connections. Reload the extension after upgrading.
`list_browsers` and `select_browser` expose the connected profiles to the agent. The configured default applies only to unbound sessions; existing bindings survive a broker restart. Switching explicitly releases the old session scope first. A failed release or disconnect never falls through to another browser. Browser and profile labels describe the target; the pairing credential and exact Origin authenticate it.

Turn completion suspends the browser debugger and collapses managed groups, but
does not discard the session's tab grants. A pending authorization remains
available in the popup for five minutes so it can be completed after the model
turn has ended. When several CardBush sessions are awaiting access, the popup
requires an explicit target-session selection. Temporary grants are kept in
`chrome.storage.session`, while per-site and all-site grants remain explicitly
revocable persistent settings.

Visual verification uses `take_screenshot`, `resize_page`, and `export_image`.
An accidental viewport narrower than 320 CSS pixels (or shorter than 180) is
repaired before capture; explicitly requested sizes are preserved. `fullPage`
uses document bounds, while `selector` captures a chart or other element.
Viewport emulation is cleared when the debugger is released or suspended.
`export_image` exports canvas pixels or captures SVG/HTML elements. Explicit
image values from `evaluate_script` are also attached automatically, including
JSON-stringified `{url: dataURL}` results. Use `resultType: "json"` only when
literal JSON is required. No browser download is needed for visual inspection.
Original images are saved under CardBush's browser-connector artifact directory,
isolated per session; the runtime separately prepares bounded vision copies.

Version 1.0.2 adds the Chrome `downloads` permission. Reload an unpacked extension
after updating these files. `download_file` creates a task in
`Downloads/CardBush/<task-id>/` with `saveAs: false`; `download_status` follows
that task and `cancel_download` cancels it. Repeated requests reuse the task,
including while Chrome has not acknowledged the start. Only Chrome's `complete`
state promotes a file into the task's artifact directory. Pending `.tmp` files
are never returned as finished artifacts. Browser interruptions and cancellations
do not trigger automatic retries. Task ownership and request keys survive worker
restarts in `chrome.storage.session`; unrelated downloads are not tracked.

Production releases should publish reviewed extensions through the Chrome Web Store / Edge Add-ons.
After the first store upload, copy the store public key into `manifest.json`
and verify that its derived id matches `chromeConnectorExtensionId`; if the
store id differs, update that constant and the exact WebSocket Origin check
before shipping the desktop installer. Set
`CARDBUSH_CHROME_CONNECTOR_STORE_URL` to the final listing URL so CardBush opens
the reviewed install page instead of the unpacked-extension directory.

The connector starts disabled. Explicit desktop disable revokes all paired
credentials; enabling again requires new pairings. Removing a connection revokes only that credential. App exit preserves pairings
in app data. A fresh browser session requires an explicit Connect click;
worker recovery within an enabled session is bounded. Pairing a new connection preserves other credentials. After re-pairing the same profile, remove its old offline entry. The extension has no nativeMessaging permission.

MSIX connector configuration resides in the package's LocalState. Older
Native Messaging registrations require an ownership-checked migration; see
CardBush settings if a legacy registration warning appears.
