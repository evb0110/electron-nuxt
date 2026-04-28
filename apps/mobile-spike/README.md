# EVB Viewer Mobile Spike

This is a deliberately thin Expo/React Native host for the existing PDF.js
mobile reader route. It is not the production mobile app yet.

The spike proves the intended ownership boundary:

- React Native owns native shell chrome, native file picking, and native command
  presentation.
- The WebView owns the PDF.js document surface, rendering, page state, search
  highlights, and annotation rendering.
- The bridge between them uses shared contracts from `packages/contracts`.

## Run

In one terminal, start the web reader:

```bash
pnpm dev:web
```

`dev:web` binds to `0.0.0.0:3235` so a real phone on the same network can
reach the WebView route.

In another terminal, start Expo:

```bash
pnpm dev:mobile
```

The document transport uses native modules (`@dr.pogodin/react-native-static-server`
and `@dr.pogodin/react-native-fs`), so opening PDFs requires an Expo
development build. Expo Go can still render the shell, but it cannot run the
local document server.

If opening a file reports `ReactNativeFs could not be found`, the app is still
running in Expo Go or in a development build that was installed before the
native document-server dependencies were added. Stop Expo Go, rebuild, and
reinstall the development app.

Build and run a development app when testing document opening:

```bash
pnpm --dir apps/mobile-spike ios
pnpm --dir apps/mobile-spike android
```

The default WebView URL is:

```text
http://127.0.0.1:3235/mobile-reader-proof
```

On Android emulator, the fallback URL is:

```text
http://10.0.2.2:3235/mobile-reader-proof
```

For a physical phone, the app derives the Mac LAN IP from the Expo bundle URL
and loads the reader from the same host on port `3235`.

If that automatic host detection is wrong, pass the Mac's LAN IP address when
starting Expo:

```bash
EXPO_PUBLIC_VIEWER_URL=http://192.168.1.10:3235/mobile-reader-proof pnpm dev:mobile
```

The URL is intentionally not shown in the app UI. React Native owns this host
configuration; the WebView remains just the reader presentation surface.

## Current Scope

- Opens a PDF via Expo's native document picker.
- Imports picked PDFs into app-owned storage.
- Serves imported PDFs through a native localhost static server.
- Sends the reader a stable URL so PDF.js can load the document through normal
  browser URL/range semantics instead of `postMessage` byte transfer.
- Receives `viewer:ready`, `document:loaded`, and `reader:page-changed`.
- Sends coarse `reader:execute-command` messages from a native command sheet.

## Deliberate Limits

- The native command sheet shows command keys instead of localized labels.
- The app loads the web reader from the dev server; bundled/offline WebView
  assets are a later spike.
- The WebView route remains platform-agnostic and does not import React Native.
