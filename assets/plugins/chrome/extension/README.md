# CardBush Browser Use

This Manifest V3 extension connects Chrome and Microsoft Edge profiles on Windows 11 to
the CardBush Broker through authenticated loopback WebSockets (Chromium 116+ APIs).
The default local App and CLI profile share one broker and one set of browser
connections. A surviving client takes over when the owning process exits. It never
replays an interrupted browser command or starts a replacement browser profile.

Development installation:

1. Run CardBush App or the local CLI on Windows 11 and install/enable Browser Use.
2. Open `chrome://extensions` or `edge://extensions` in that browser, enable Developer mode, and choose **Load unpacked**.
3. Select this directory and approve the first connection in the CardBush system
   dialog, then confirm in the extension's own window. No pairing code is needed. Page access still requires authorization. Start a browser task in CardBush. New tabs are
   placed in a cyan group named for that CardBush session. The connector only
   lists and controls tabs in that session's groups.
4. To use an existing personal tab, open the extension popup and explicitly
   copy it into the active CardBush group. The original tab remains untouched.

Version 1.2.4 recovers when a saved loopback port is occupied or denied by Windows. The app tries the saved endpoint, then a bounded set of 32 spread-out ports below the default Windows dynamic client range. The extension tries its saved endpoint first, then discovers the same paired broker in that set with up to four concurrent, deadline-limited handshakes. It saves a replacement endpoint only after mutual authentication; existing pairing, session routing and site permissions remain unchanged. Discovery failure uses the existing reconnect backoff, and disabling cancels pending discovery.

Reload the existing extension after upgrading; do not uninstall it, which deletes its saved state. Version 1.3 discovers the local connector and requests one-time consent in a system dialog. No `nativeMessaging` permission or registry registration is required. An already saved pairing continues to use the authenticated WebSocket transport without another dialog.
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

Installing/enabling the plugin starts the local connector. A fresh extension
attempts automatic connection; an explicit disable remains disabled. Only the
elected local broker can request system consent. The listener checks loopback,
Host and exact extension Origin; a bounded ECDH handshake creates a fresh secret
for each target before user confirmation. Origin alone is not authentication of
native processes: initial trust is the user's consent, followed by pinned mutual
authentication. No browser data or control is available before confirmation.
Rejected identities remain rejected across restarts until an explicit new request;
one dialog is allowed at a time and a persisted cooldown limits repeated requests.
Cancelling or disconnecting aborts the dialog. Remote Agents retain manual pairing
and never open a dialog on the server or inherit the desktop's connection.
The extension preserves its profile identity and automatic reconnection,
including after a browser restart. Five minutes limits accepting a new pairing
code, not the lifetime of an established pairing. Offline retries back off from
short retries to a persistent 30-second alarm and continue while enabled;
opening the popup retries immediately. No browser action is replayed.

Desktop disable stops the listener and active control while retaining pairings
and session bindings. Re-enabling the desktop connector allows automatic
reconnection. Explicit extension disable stays off across browser/worker restarts
until Connect is clicked, retaining its pairing. Removing a connection revokes
only that credential; removing connector configuration revokes all pairings and
retains invalid route bindings so old sessions cannot silently adopt another
browser. Ordinary app exit preserves enabled intent and pairing data.

Per-site and all-site grants survive ordinary app/browser restarts and temporary
disable; use Revoke access in the extension to clear them. This consent only
applies to managed session groups. It never authorizes personal tabs implicitly.
One-time grants and tab/group IDs remain browser-session state; a browser restart
does not adopt restored personal tabs based on their title or numeric ID.
Pairing a new connection preserves other credentials. After intentionally
re-pairing the same profile, remove its old offline entry. Explicit Connect after
revocation creates a new profile identity; background retries cannot undo revocation.
See [implementation and license scope](../THIRD_PARTY_NOTICES.md).

MSIX connector configuration resides in the package's LocalState. Older
Native Messaging registrations require an ownership-checked migration; see
CardBush settings if a legacy registration warning appears.

System consent is displayed by the bundled native helper for either the App or
CLI. The extension independently confirms first use in its own window, so an
untrusted local service cannot open browser control just by claiming approval.
Only both approvals commit the credential; an interrupted final reply can resume
with the stored proof without asking twice. Closing or timing out denies the request; the default button is No. It does
not elevate privileges or request UAC. MSIX keeps registry and filesystem
virtualization enabled and adds no `unvirtualizedResources` capability or execution
alias. Website authorization remains separate from connection consent.
