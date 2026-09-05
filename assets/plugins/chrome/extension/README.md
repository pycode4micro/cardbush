# CardBush Browser Connector

This Manifest V3 extension connects the user's current Chrome profile to the
CardBush native messaging bridge. It never starts a separate browser profile.

Development installation:

1. Build and run a packaged CardBush application, then choose **Configure local bridge**.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this directory and start a browser task in CardBush. New tabs are
   placed in a cyan group named for that CardBush session. The connector only
   lists and controls tabs in that session's groups.
4. To use an existing personal tab, open the extension popup and explicitly
   copy it into the active CardBush group. The original tab remains untouched.

Turn completion suspends the Chrome debugger and collapses managed groups, but
does not discard the session's tab grants. A pending authorization remains
available in the popup for five minutes so it can be completed after the model
turn has ended. When several CardBush sessions are awaiting access, the popup
requires an explicit target-session selection. Temporary grants are kept in
`chrome.storage.session`, while per-site and all-site grants remain explicitly
revocable persistent settings.

Production releases should publish the extension through the Chrome Web Store.
After the first store upload, copy the store public key into `manifest.json`
and verify that its derived id matches `chromeConnectorExtensionId`; if the
store id differs, update that constant and the Native Messaging allowlist
before shipping the desktop installer. Set
`CARDBUSH_CHROME_CONNECTOR_STORE_URL` to the final listing URL so CardBush opens
the reviewed install page instead of the unpacked-extension directory.
