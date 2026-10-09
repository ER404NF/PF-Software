# Bodun desktop app

Users get this as a ready-made installer — `Phone-Farm-macOS.pkg` or `Phone-Farm-Windows.exe` from
[GitHub Releases](https://github.com/ER404NF/PF-Software/releases/latest) — and never
build anything. This directory is the source of that app and of the pipeline that
builds and verifies the installer.

## What ships inside `Bodun.app`

| In the app | Where (`Contents/Resources/…`) | Notes |
|---|---|---|
| Electron app + desktop host code | `app.asar` | `main.js`, `preload.js`, `first-run.html`, `hostEnvironment.js`, `windowSecurity.js`, `wdaSource.js` |
| Bodun server | `system/server/src/` | run with the app's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`) — **no system Node.js needed** |
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
`iproxy`, WebDriverAgent — then starts the server with `AUTO_PROVISION_WDA=true`. Each newly
detected iPhone is registered with WDA stopped. After an authorized operator uses **Start WDA**,
the phone gets its own `xcodebuild` instance (unique derived-data path and port) and scoped
`iproxy -u <UDID>` tunnel; that running choice survives relaunch and reconnect. **Check control**
reports USB pairing separately from WDA signing without exposing raw device identifiers. Tools are
found in Homebrew and system locations without relying on the
Finder's `PATH`. No Terminal is needed to operate the app after installation.

### Settings for this Mac (the Bodun menu)

The Mac's settings are in the **Bodun** menu (the first menu, next to the Apple menu). Help only holds
**Copy Diagnostics** and **Show Log Folder**.

| Setting | What it does | Default |
| --- | --- | --- |
| **Start Bodun When This Mac Starts** | Opens Bodun again after a restart or power cut. Installed app only. | On for a host |
| **Enable Proxy Routing on This Mac (restart required)** | Turns on the per-phone network controls. Needs `tun2proxy` and an active Internet Sharing connection; Bodun asks which one when several are active and refuses when it cannot verify one. | Off |
| **Automatic Network Enrollment (restart required)** | Bodun pairs each phone to the network itself instead of waiting for you to confirm. Available once routing is on. | Off |
| **Automatic Internet Sharing (restart required)** | Bodun turns on macOS Internet Sharing for the phone itself. Available once routing is on. | Off |
| **Move Aside Damaged Process Records…** | Moves a damaged record of Bodun's earlier processes to a safe copy next to it (never deletes it). Host and site Macs only; refused while Bodun's own server or site agent runs. | — |

The last three only apply after Bodun starts again, so choosing one shows **Restart now** and **Later**.
Restart now closes Bodun properly (it waits for the phone connections to stop) and opens it again.

**Our recommendation.** Leave automatic network enrollment and automatic Internet Sharing off until the
manual steps below have worked on the real phones and Mac once. Turn them on afterwards if you want the
steps done for you. Neither has been tested on real hardware yet.

### Connecting a phone to the network by hand

When routing is on and the automatic switches are off, each phone's card shows **Start network
enrollment**. The steps are the same on every phone:

1. Press **Start network enrollment** on that phone's card. Other phones' enrollment buttons wait (they say
   why) until this one is confirmed, cancelled or the five minutes run out; the card shows the time left.
2. On the Mac open **System Settings**, then **General**, then **Sharing**.
3. Turn on **Internet Sharing** and tick this phone's USB connection.
4. Come back to Bodun and press **Confirm enrollment**. If Bodun cannot see exactly one new connection it
   says so on the card, in words, and nothing is changed. Press **Cancel enrollment** to stop at any time.

The exact wording of the System Settings screens on macOS 26 has not been checked on the Mac yet.

### Troubleshooting: "Automatic phone setup is paused"

Bodun keeps two small records of the processes it started, so that a crash, a force-quit or a power cut
cannot leave an old phone connection blocking a new one: one for its own server and site agent
(`desktop-children.json`) and one for the phone connections the server runs (`process-ownership.json`).
Both live in `host-storage`, inside Bodun's own storage folder, and both are written safely (temporary
file, flushed to disk, renamed, folder flushed; macOS cannot be forced to empty the drive's own cache from
Node, so the write order is what protects them).

If Bodun cannot read one of them it will not guess. Every Fleet page shows one notice at the top, and people
who can manage phone setup also get **Check again**:

| Notice says | What it means | What to do |
| --- | --- | --- |
| *Bodun is checking its earlier phone connections.* | Normal, short. Setup starts when the check ends. | Nothing. |
| *Bodun could not check its earlier phone connections. It will try again by itself every 30 seconds.* | The look at running processes failed (three tries). | Wait, or press **Check again**. |
| *An earlier Bodun session is still running.* | A phone connection from an earlier session is still alive and Bodun is stopping it. | Wait, or press **Check again**. If it stays, restart this Mac. |
| *The record of Bodun's earlier phone connections is damaged.* | The record is empty, cut short, or not what Bodun wrote. Needs a person. | Quit Bodun and open it again. Bodun then offers to **Move aside** the damaged record. |

While setup is paused, phone cards that are waiting for it say so ("Automatic phone setup is paused. See
the notice at the top of this page.") and never say setup is turned off.

**Moving a damaged record aside.** The moved file stays in the same folder, renamed `<file>.damaged-<time>`. Bodun
moves it with one rename (nothing is copied or removed, then it checks the bytes are the ones judged damaged and puts them back if not); it never deletes
or overwrites it. Valid records are never touched. Two ways it happens:

1. *By itself*, at launch, only when it is certain the damage is old: the file was last changed before this
   Mac last started (read with the fixed command `sysctl -n kern.boottime`, cross-checked against the
   system uptime) by a safe margin. If the start time or the file's times cannot be read, it does **not**
   move anything by itself.
2. *By you*, from **Bodun > Move Aside Damaged Process Records…**, or from the question Bodun asks at launch.
   The dialog defaults to **Cancel**, says nothing is deleted, and offers **Restart now** afterwards. If Bodun
   was force-quit a moment ago, restarting the Mac first is the safest choice: the record then repairs itself.
   The menu action refuses while Bodun's own server or site agent runs (quit and reopen Bodun first).

**Copy Diagnostics** includes the same status, the name of the record file and its folder (never the full
path), and whether Bodun's own record is intact, damaged, or was moved aside during this launch.

**Not verifiable on Windows.** The Mac start time, a real power cut during a write, and macOS's own cache
flush cannot be simulated safely here; the Mac checks are in `tmp/debug-run/MAC-CHECKS.md` (checks H9 to H12).

### Bundled WebDriverAgent

- **License.** WebDriverAgent (appium/WebDriverAgent) carries the Facebook BSD 3-Clause `LICENSE`
  (its `package.json` declares Apache-2.0 for Appium's own changes). Both permit redistribution when
  the notice is kept, so it is bundled **unmodified** with its `LICENSE` beside it and copied to
  `licenses/`.
- **Pinned.** `wda.lock.json` names a tag *and* the exact commit; `scripts/prepare-wda.cjs` refuses to
  bundle anything that does not resolve to that commit.
- **Never built inside the signed app.** On first launch the source is copied to
  `~/Library/Application Support/Phone Farm/wda-source/<version>-<commit>/` (`wdaSource.js`), and
  derived data lives under `…/host-storage/wda-derived-data/`. Nothing inside `Bodun.app` is
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
  page and in the Bodun menu), allows one instance, and falls back to the next free port if 4173 is taken (`PHONE_FARM_PORT` changes the default).
- **Diagnosing.** Logs are written to `~/Library/Logs/Phone Farm/phone-farm.log` (rotating, secrets scrubbed).
  **Help > Copy Diagnostics** copies a plain-text report (prerequisites, tool paths, WebDriverAgent source,
  recent log); **Help > Show Log Folder** opens the folder (`diagnostics.js`).
- **Development switches.** `PHONE_FARM_PORT` changes the default port. `PHONE_FARM_SKIP_HOST_PREFLIGHT=1` starts the
  host server on a machine that is not a farm host (no Xcode, no phones) without the Mac prerequisite checks; the automated
  tests set it, and the installed app never does.
- **Account email deployment.** A packaged host reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_SECURE`, and `COMPANY_FROM_EMAIL` from its launch environment and passes those values directly to
  the private server child. All five connection/sender values are required except `SMTP_SECURE`. The SMTP
  password is never saved in `desktop-config.json` or included in diagnostics; use the service manager or
  managed launch environment that starts Bodun to provide it.
- **Checking a release.** `npm run check:release` lists everything about the installer that can be verified
  without a Mac and whether it is committed; see [docs/MAC_RELEASE.md](../docs/MAC_RELEASE.md).
- **Required version gate.** Before any packaged host, site agent, or client UI starts, `autoUpdate.js`
  checks the public GitHub Releases API. If the newest stable published version differs, the operator must choose
  **Update now**; **No — exit** closes the app. The downloaded platform installer is accepted only from
  trusted GitHub HTTPS hosts, with the declared byte length and GitHub-provided SHA-256 digest verified.
  If GitHub's release-list cache has not yet included a newly uploaded installer, the gate reads that
  release's dedicated asset collection before reporting it missing.
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
npm run dist:mac:app     # just the .app (dist/mac-arm64/Bodun.app)
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

- Only the packaged first-run window receives `preload.js`; the Bodun web window has no preload and
  is confined to its configured HTTP(S) origin.
- The server sidecar depends on Electron's `runAsNode` fuse staying enabled; it is not disabled.
- Electron is pinned to a patched release (44.x). `npm run audit:gate` fails the build on a high/critical
  finding in the shipped runtime.
