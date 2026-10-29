# Application menu

[English](application-menu.en.md) · [简体中文](application-menu.md)

The title bar provides conversation back/forward navigation and File, Edit, View and Help menus. They reuse existing conversation, project, preview and settings actions, without advertising unimplemented actions such as new windows, temporary sessions or account sign-out. Cache cleanup is in **Settings → Data and maintenance**; the title-bar cache button has been removed.

- File: new conversation, open project folder, open file, close window and quit. Closing follows the tray behavior; Quit follows the application shutdown flow.
- Edit: undo, redo, cut, copy, paste, delete and select all in the editor focused before the menu opened. Composer and rich-text selections are preserved. Browser editing can only target WebContents owned by this window.
- View: sidebar, right panel, review, history, Shadow, browser, search, conversation navigation, zoom and full screen. Unavailable actions are disabled for the current context.
- Help: project documentation, customizable shortcuts, diagnostics/about, feedback and releases. Links come from the application's repository metadata. Opening releases does not imply an automatic updater.
- Runtimes supporting Team retain the Beta entry.

Default shortcuts include `Ctrl+N` for a new conversation, `Ctrl+O` for a folder, `Ctrl+P` for a file, `Ctrl+F` for search, `Ctrl+B` for the sidebar, `Ctrl+Alt+B` for the right panel, `Ctrl+,` for settings, `Ctrl+/` for shortcut settings and `F11` for full screen. Menu hints follow customized bindings.

`Ctrl+[` / `Ctrl+]` navigate conversations visited in the current window. Opening another conversation after going back replaces the forward branch. `Ctrl+Tab` toggles between the two most recently visited conversations. Deleted conversations leave the navigation history; background activity does not reorder visits.

`Ctrl+R` refreshes only the active preview. Main-process interception prevents an app-page reload and routes the key to this action. With no preview, nothing reloads. Image popups retain their own zoom and keyboard behavior.

Menus support mouse switching, arrows, Home/End, Esc and scrolling in small windows. `npm run test:window-menu` verifies real editing, selection restoration, navigation/deletion, shortcut changes, popup isolation, layout and IPC ownership in isolated Electron windows, without accessing user conversations or the user's clipboard.
