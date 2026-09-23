# Phone Farm desktop app

Users get this as a ready-made installer — `Phone-Farm-macOS.pkg` or `Phone-Farm-Windows.exe` from
[GitHub Releases](https://github.com/ER404NF/PF-Software/releases/latest) — and never
build anything. This directory is the source of that app and of the pipeline that
builds and verifies the installer.

## What ships inside `Phone Farm.app`

| In the app | Where (`Contents/Resources/…`) | Notes |
|---|---|---|
| Electron app + desktop host code | `app.asar` | `main.js`, `preload.js`, `first-run.html`, `hostEnvironment.js`, `windowSecurity.js`, `wdaSource.js` |
| Phone Farm server | `system/server/src/` | run with the app's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`) — **no system Node.js needed** |
| Production dependencies | `system/node_modules/` | installed from the lockfile with `npm ci --omit=dev` |
| Web client | `system/client/` | |
| WebDriverAgent (unmodified, pinned) | `wda/WebDriverAgent/` | see below |
| Licenses / notices | `licenses/`, `THIRD_PARTY_NOTICES.txt` | Electron, Chromium, WebDriverAgent |

Nothing else from the repository is packaged: an explicit allow-list is copied
(`scripts/prepare-runtime.cjs`), so operator accounts, device configuration, runtime
storage, tests and fixtures can never reach an installer. `scripts/verify-packaged-runtime.cjs`
proves this on every build — see [Verification](#verification).

## Host behaviour on first launch (unchanged)

On a Mac, **Set up a new host** runs host preflight — Xcode, `idevice_id`, `ideviceinfo`,
`iproxy`, WebDriverAgent — then starts the server with `AUTO_PROVISION_WDA=true`. Each trusted
iPhone gets its own `xcodebuild` WDA instance (unique derived-data path and port) and its own
`iproxy -u <UDID>`. Tools are found in Homebrew and system locations without relying on the
Finder's `PATH`. No Terminal is needed to operate the app after installation.

`AUTO_ROUTE_PROXY_TUNNELS`, `AUTO_NETWORK_ENROLLMENT` and `AUTO_ENABLE_INTERNET_SHARING` are not
enabled by desktop startup.

### Bundled WebDriverAgent

- **License.** WebDriverAgent (appium/WebDriverAgent) carries the Facebook BSD 3-Clause `LICENSE`
  (its `package.json` declares Apache-2.0 for Appium's own changes). Both permit redistribution when
  the notice is kept, so it is bundled **unmodified** with its `LICENSE` beside it and copied to
  `licenses/`.
- **Pinned.** `wda.lock.json` names a tag *and* the exact commit; `scripts/prepare-wda.cjs` refuses to
  bundle anything that does not resolve to that commit.
- **Never built inside the signed app.** On first launch the source is copied to
  `~/Library/Application Support/Phone Farm/wda-source/<version>-<commit>/` (`wdaSource.js`), and
  derived data lives under `…/host-storage/wda-derived-data/`. Nothing inside `Phone Farm.app` is
  modified at runtime — the verifier checks this.
- **Signing.** An unsigned WDA project cannot run on a physical iPhone. Host setup detects an Apple
  development team from your keychain when there is exactly one; otherwise it asks for your 10-character
  **Team ID** once. Xcode must be signed in to that Apple ID. `xcodebuild` then signs with automatic
  provisioning under a bundle id unique to your team (`com.phonefarm.wda.<teamid>`). This signing
  automation is **not yet verified on real hardware**. A WebDriverAgent checkout you supply yourself
  (`WDA_REPO_PATH`, or `~/WebDriverAgent`) takes precedence, is assumed already signed, and receives no
  signing overrides.
- **Still external, but fixed from the setup screen.** Xcode (App Store), and the USB tools
  `libimobiledevice` + `libusbmuxd`. These are LGPL/GPL native components and are not bundled. Host setup
  lists what is missing and offers **Fix it** (`hostFixes.js`): for Xcode, one macOS password prompt selects it
  and finishes its licence/first-launch setup; for the USB tools it runs `brew install libimobiledevice
  libusbmuxd` when Homebrew is installed (without Homebrew it says to install that from https://brew.sh —
  the one step outside the app).
- **Running unattended.** The app keeps the Mac awake while the server or site agent runs, restarts a crashed
  server/agent with backoff (`serverSupervisor.js`), starts at login (host/site modes; a checkbox on the setup
  page and in the Help menu), allows one instance, and falls back to the next free port if 4173 is taken (`PHONE_FARM_PORT` changes the default).
- **Diagnosing.** Logs are written to `~/Library/Logs/Phone Farm/phone-farm.log` (rotating, secrets scrubbed).
  **Help > Copy Diagnostics** copies a plain-text report (prerequisites, tool paths, WebDriverAgent source,
  recent log); **Help > Show Log Folder** opens the folder (`diagnostics.js`).
- **Development switches.** `PHONE_FARM_PORT` changes the default port. `PHONE_FARM_SKIP_HOST_PREFLIGHT=1` starts the
  host server on a machine that is not a farm host (no Xcode, no phones) without the Mac prerequisite checks; the automated
  tests set it, and the installed app never does.
- **Checking a release.** `npm run check:release` lists everything about the installer that can be verified
  without a Mac and whether it is committed; see [docs/MAC_RELEASE.md](../docs/MAC_RELEASE.md).
- **Required version gate.** Before any packaged host, site agent, or client UI starts, `autoUpdate.js`
  checks the public GitHub Releases API. If the newest stable published version differs, the operator must choose
  **Update now**; **No — exit** closes the app. The downloaded platform installer is accepted only from
  trusted GitHub HTTPS hosts, with the declared byte length and GitHub-provided SHA-256 digest verified.
  A check or verification error offers Retry or Exit and never starts the application. Source/development
  runs skip this gate.

## Building the installer

Normal path: **GitHub Actions** — `.github/workflows/mac-installer.yml` (see
[docs/MAC_RELEASE.md](../docs/MAC_RELEASE.md)).

Locally, on a Mac:

```sh
cd desktop
npm ci
npm test                 # desktop tests
npm run dist:mac         # = dist:mac:pkg  -> dist/Phone-Farm-<version>-arm64[-UNSIGNED].pkg
npm run dist:mac:pkg:universal   # Apple silicon + Intel
npm run dist:mac:app     # just the .app (dist/mac-arm64/Phone Farm.app)
npm run verify:pkg -- path/to/Phone-Farm-<version>-arm64.pkg
```

`scripts/build-mac-pkg.cjs` runs: stage runtime → stage pinned WDA → electron-builder makes the `.app`
→ sign/notarize/staple the app → `pkgbuild` (install-location `/Applications`, non-relocatable, no
scripts) + `productbuild` (welcome / read-me / conclusion pages) → sign/notarize/staple the package →
verify. Add `--dry-run` to print the plan.

| Credentials present | Result | File name |
|---|---|---|
| Developer ID Application + Installer + notarization | signed, notarized, stapled | `Phone-Farm-<v>-arm64.pkg` |
| both identities, no notarization | signed only | `Phone-Farm-<v>-arm64-NOT-NOTARIZED.pkg` |
| none | ad-hoc-signed app, unsigned package | `Phone-Farm-<v>-arm64-UNSIGNED.pkg` |

An unsigned/un-notarized package triggers Gatekeeper warnings and is **not** equivalent to the seamless
public installer. A release build (`--release`) fails unless it is notarized, unless
`PHONE_FARM_ALLOW_UNSIGNED=true` explicitly allows the clearly-named fallback.

The repository root no longer contains command files that can be mistaken for installers. Public binaries
are attached to a versioned GitHub Release under the stable names `Phone-Farm-macOS.pkg` and
`Phone-Farm-Windows.exe`; the stable macOS name is created only for a signed/notarized package, never for a
development package whose filename must retain `UNSIGNED` or `NOT-NOTARIZED`. Maintainers can still use
the scripts in this directory when diagnosing CI.

## Verification

- `npm test` — 80+ tests: staging allow-list, verifier, build plan (unsigned / signed / notarized),
  workflow structure, WDA copy/signing, audit classification.
- `scripts/verify-packaged-runtime.cjs <resources> <executable>` — required files present; every bare
  `import`/`require` in `system/server/src` resolves inside the packaged `node_modules`; forbidden files
  (accounts, storage, tests, key material) absent; the real server **boots** using the packaged
  executable, serves the client, answers the API, and leaves the bundle byte-for-byte unmodified.
- `npm run audit:gate` — dependency audit that classifies each finding as *shipped* (reaches the
  installed app: production dependencies + the Electron runtime) or *build-only*.
- In CI the finished `.pkg` is expanded and inspected, then **installed with macOS Installer** on a clean
  runner and the installed app's server is booted.

Hardware validation (real iPhones) is separate: [docs/MAC_INSTALLER_ACCEPTANCE.md](../docs/MAC_INSTALLER_ACCEPTANCE.md).

## Isolation and security notes

- Only the packaged first-run window receives `preload.js`; the Phone Farm web window has no preload and
  is confined to its configured HTTP(S) origin.
- The server sidecar depends on Electron's `runAsNode` fuse staying enabled; it is not disabled.
- Electron is pinned to a patched release (44.x). `npm run audit:gate` fails the build on a high/critical
  finding in the shipped runtime.
