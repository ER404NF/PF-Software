# macOS installer and two-iPhone acceptance

## Status — read this first

| Check | Status |
|---|---|
| Server suite, desktop suite, dependency audits | pass on the Windows development host (see `docs/CODING_ROADMAP_STATUS.md`) |
| Packaged-app layout: runtime + `node_modules` present, dependencies resolve, server boots from the packaged executable, bundle unmodified | **verified on Windows** with an unpacked electron-builder build; re-run automatically on macOS in CI |
| `Phone-Farm-<version>-arm64.pkg` **built** | **not yet** — needs macOS; produced by `.github/workflows/mac-installer.yml` |
| `.pkg` installed with macOS Installer and the installed server booted | **not yet** — happens in that workflow on a clean macOS runner |
| Package signed with Developer ID Installer / app with Developer ID Application | **not yet** — needs your Apple credentials |
| Notarized and stapled | **not yet** — needs your Apple credentials |
| Real iPhones (WDA, iproxy, control, recovery) | **not yet** — needs a Mac and phones |

Do **not** mark the steps below as passed until they have been executed on macOS hardware.

## Preconditions

- The Mac has Xcode installed from the App Store. Nothing else needs to be done in Terminal: if Xcode is not selected or
  its licence was never accepted, or the iPhone tools (libimobiledevice, libusbmuxd) are missing, the setup screen shows a
  **Fix it** button on that row (macOS asks for the Mac password once; the tools are installed with Homebrew). The one
  thing outside the app is Homebrew itself, if this Mac does not have it: install it from https://brew.sh first.
- You know your Apple Developer **Team ID**, and Xcode is signed in to that Apple ID.
- Each iPhone: Developer Mode enabled and the Mac trusted (**Trust This Computer**).
- Proxy routing stays disabled unless it is being tested as a separate feature.

## Acceptance path — ordinary user, one file

1. Start from a Mac with **no PF-Software repository** open or cloned.
2. Node.js and npm are **not** installed (or at least not used).
3. Download **only** `Phone-Farm-<version>-arm64.pkg` from the GitHub Release.
4. Double-click it in Finder.
5. macOS **Installer.app** opens.
6. Continue through the wizard (Introduction → Read Me → Install → Summary).
7. `Phone Farm.app` appears in `/Applications`.
8. Close Terminal.
9. Close Xcode.
10. Connect two already-trusted iPhones.
11. Launch **Phone Farm** from Applications.
12. Choose **Set up a new host**; host startup happens inside the app (preflight rows, first-admin form).
    Click **Fix it** on any row that needs attention, then **Check again** if it does not re-check itself.
    On first run, enter the Apple Team ID if asked. Leave "Start Phone Farm automatically when this Mac starts" ticked.
13. Both phones are detected.
14. WDA launches automatically for each (one `xcodebuild` per phone).
15. `iproxy -u <UDID>` launches automatically for each.
16. Both phones become available in the fleet.
17. Quit Phone Farm completely.
18. Relaunch it.
19. Both phones recover automatically.
20. Unplug and replug one phone; verify the other stays operational and the replugged one recovers.

Also exercise, on each phone: tap, swipe, typing, Home.

### Running unattended (a farm host must survive these)

21. **Stays awake.** Leave the Mac idle for longer than its normal sleep time: it must not sleep while Phone Farm runs
    (Activity Monitor > Energy shows "Prevented Sleep" for Phone Farm), and the phones stay available.
22. **Crash recovery.** Activity Monitor lists "Phone Farm" twice: the app with its window and its server (no window).
    Force-quit the server one. Within a few seconds the server is back, the operator page reconnects, and both phones return.
    (The log shows "stopped unexpectedly ... restarting ... running again".)
23. **Reboot.** Restart the Mac and log in: Phone Farm opens by itself and both phones recover with no clicks.
    (System Settings > General > Login Items shows Phone Farm.)
24. **Diagnostics.** Help > Copy Diagnostics puts a plain-text report on the clipboard (prerequisite rows, tool paths, the
    recent log; no passwords or keys). Help > Show Log Folder opens ~/Library/Logs/Phone Farm/. Send the diagnostics with any
    bug report.

### Additional checks when signing/notarization credentials are configured

25. **No** "unidentified developer"/"cannot be opened" Gatekeeper warning when opening the downloaded `.pkg`.
26. `pkgutil --check-signature Phone-Farm-<version>-arm64.pkg` reports a valid **Developer ID Installer** signature.
27. `spctl --assess --type install -vv <pkg>` accepts the package, and `spctl --assess --type execute -vv "/Applications/Phone Farm.app"` accepts the installed app.
28. `xcrun stapler validate <pkg>` (and the app) reports the notarization ticket is valid.

`npm run verify:pkg -- <pkg> --expect notarized` in `desktop/` automates the signature, ticket, Gatekeeper,
payload and boot checks (25 excepted — it is a visual check).

### Record

Package filename, its SHA-256, macOS version, Mac architecture, Phone Farm commit/tag, iOS versions, and
pass/fail evidence for each numbered step. A working screenshot/render and input test does not by itself
validate video monitoring or network/proxy routing.

## Failure-path validation

Run each case independently and confirm the UI explains the problem rather than showing an unexplained
empty fleet or an endless restart:

- Developer Mode disabled: the phone shows that Developer Mode must be enabled and waits for an admin retry.
- Phone not trusted: the phone asks the operator to trust the Mac and waits for retry.
- WDA signing not configured (no Team ID): host setup shows **WebDriverAgent signing — Needs attention** with the Team ID field; with a wrong team the phone shows the signing message and waits for retry.
- `iproxy` unavailable: host setup marks iproxy as needing attention; with Homebrew present it offers **Fix it**, without
  Homebrew it says to install it from https://brew.sh.
- Xcode not selected or licence not accepted: host setup offers **Fix it**; cancelling the password prompt leaves the row
  unchanged with a calm message, and a second click works.
- Bundled WDA copy missing/corrupt: relaunch re-copies it; host setup reports WebDriverAgent as missing only if the app itself is damaged (reinstall).

A failure for Phone A must not stop Phone B, and client mode must open its configured remote host without
exposing `desktopApi` to the remote page.
