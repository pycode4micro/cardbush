# cardbush-electron

Electron desktop client for CardBush.

## Development

```powershell
npm install
npm run dev
```

If Electron did not install correctly, run:

```powershell
npm run fix:electron
```

## Build

```powershell
npm run typecheck
npm run build
```

## Backend

The app talks to BushServer over HTTP. By default it uses:

```text
http://127.0.0.1:51717
```

Override with:

```powershell
$env:VITE_BACKEND_BASE_URL='http://127.0.0.1:51717'
```

## Split

This project was split out from `cardbush/electron` and now lives independently at:

```text
C:\Users\wfang\Desktop\cardbush-electron
```
