# ZAT POS

Offline-first Point of Sale application with three delivery targets sharing one codebase:

- **Desktop app** — Electron wrapper (`main.js`) loading `offline-pos/index.html`
- **Mobile app** — Android app via Capacitor (`android/`) loading `offline-pos/mobile.html`
- **Browser** — the same static files can be served directly for testing

All three UIs share the same business logic in `offline-pos/js/` (cart, printing, receipts, ZATCA e-invoicing, i18n, local database). Only the HTML template differs between desktop (`index.html`) and mobile (`mobile.html`).

## Project structure

```
ZAT POS APP/
├── main.js, preload.js        # Electron entry point
├── capacitor.config.ts        # Capacitor (Android) config
├── icons/, img/                # App icons / images
├── offline-pos/                # The actual web app (shared by all platforms)
│   ├── index.html               # Desktop/browser UI
│   ├── mobile.html               # Mobile UI
│   ├── js/                       # Shared business logic (app.js, db.js, printer.js, zatca.js, i18n.js, ...)
│   ├── vendor/                   # Bundled third-party libs (Vue, Dexie, Tailwind, QR code)
│   ├── manifest.json, sw.js      # PWA manifest / service worker
└── android/                    # Capacitor Android project (native shell)
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- For the Android build: [Android Studio](https://developer.android.com/studio) (or the command-line SDK tools) and a JDK 17

## 1. Install dependencies

```bash
npm install
```

## 2. Run the desktop app (Electron)

```bash
npm start
```

This opens `offline-pos/index.html` in an Electron window.

## 3. Run in a browser (quick preview)

Since the app uses a service worker and relative fetches, serve the folder instead of opening the HTML file directly:

```bash
npx serve offline-pos
# or
python -m http.server 8080 --directory offline-pos
```

Then open `http://localhost:8080/index.html` (desktop UI) or `http://localhost:8080/mobile.html` (mobile UI) in your browser.

## 4. Run the mobile app (Android)

The `android/` folder is a Capacitor project. Some files inside it (native build caches, the Gradle wrapper download, and copies of the web assets) are generated automatically and are **not** committed — you regenerate them locally before building.

```bash
# 1. Sync the web app into the native Android project
npx cap sync android

# 2. Open in Android Studio to run on a device/emulator
npx cap open android

#    ...or build a debug APK from the command line
npm run cap:build
```

By default Capacitor loads `offline-pos` as configured in `capacitor.config.ts` (`webDir: "offline-pos"`); the Android shell serves `mobile.html`-driven navigation for the phone UI.

The first time you open the project in Android Studio, point the SDK location at your local Android SDK (Android Studio will create `android/local.properties` for you — this file is machine-specific and stays out of git).

## 5. Build installers / packages

```bash
npm run build:win     # Windows installer + portable exe
npm run build:mac     # macOS .dmg
npm run build:linux   # Linux package
npm run cap:release   # Android release AAB/APK (android/app/build/outputs)
```

## Notes

- The app is offline-first: data is stored locally (IndexedDB via Dexie) and syncs when a connection is available.
- ZATCA (Saudi e-invoicing) QR/XML generation lives in `offline-pos/js/zatca.js`.
- Do not fork `offline-pos/js/app.js` per platform — desktop and mobile templates both include the same shared JS files; platform-specific UI differences belong in `index.html` / `mobile.html` only.
