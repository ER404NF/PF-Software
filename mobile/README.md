# Store apps (Google Play / App Store)

> **Not submission-ready.** Read
> [`../docs/MOBILE_STORE_READINESS.md`](../docs/MOBILE_STORE_READINESS.md) before
> generating either native project. It contains the current Apple/Google
> requirements, policy risks, distribution choices, and blocking work.

The installable web app (see `docs/DEPLOY_HUB.md`) already works on Android and iOS
without a store. If you also want store listings, this folder is a thin
[Capacitor](https://capacitorjs.com) shell that opens your hub inside a native app: the
UI, gestures and live video are the same web app, so there is nothing to keep in sync.

**Status: scaffold only. It has not been built or run** (it needs pinned Capacitor
dependencies, generated native projects, Android Studio and/or Xcode, developer accounts,
legal/privacy work, physical testing and store review). Treat the steps below as an
early development sketch, not a release procedure.

## Development bootstrap (after the readiness decisions)

```bash
cd mobile
# Add a reviewed package.json and lockfile with pinned supported Capacitor versions.
# Replace the placeholder hub URL without committing credentials.
# Generate and commit the Android and iOS projects, then verify release builds on a Mac.
```

## Things to decide first

- The app is a viewer for **one company's hub** (`server.url`). Store review will ask what a
  reviewer can sign in with; give them a demo account on a demo hub.
- The icons come from `system/client/icons/` (regenerate with `node system/server/scripts/make-icons.js`).
- Store distribution route: public, Apple Custom/unlisted, or Managed Google Play private.
- Legal publisher, retention policy, account deletion, privacy and support URLs.
- Play and App Store policies on remote-control and AI-assisted apps; recheck them before
  every submission.
