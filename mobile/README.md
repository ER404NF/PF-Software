# Store apps (Google Play / App Store)

The installable web app (see `docs/DEPLOY_HUB.md`) already works on Android and iOS
without a store. If you also want store listings, this folder is a thin
[Capacitor](https://capacitorjs.com) shell that opens your hub inside a native app: the
UI, gestures and live video are the same web app, so there is nothing to keep in sync.

**Status: scaffold only. It has not been built or run** (it needs Android Studio and/or
Xcode, developer accounts and store review, none of which exist in the development
environment). Treat the steps below as the intended path.

## Build the Android app (APK / AAB)

```bash
cd mobile
npm init -y && npm i @capacitor/core @capacitor/cli @capacitor/android
# put your hub's address in capacitor.config.json ("server.url")
npx cap add android
npx cap sync android
npx cap open android     # Android Studio: Build > Generate Signed Bundle / APK
```

Upload the signed `.aab` to the Google Play Console.

## Build the iOS app

```bash
npm i @capacitor/ios
npx cap add ios
npx cap sync ios
npx cap open ios         # Xcode: set your Team, then Product > Archive > Distribute
```

## Things to decide first

- The app is a viewer for **one company's hub** (`server.url`). Store review will ask what a
  reviewer can sign in with; give them a demo account on a demo hub.
- The icons come from `system/client/icons/` (regenerate with `node system/server/scripts/make-icons.js`).
- Play and App Store policies on remote-control apps change; read the current rules before
  submitting.
