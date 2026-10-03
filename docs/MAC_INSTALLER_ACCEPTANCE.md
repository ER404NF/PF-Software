# macOS installer and two-iPhone acceptance

## Status — read this first

| Check | Status |
|---|---|
| Server suite, desktop suite, dependency audits | pass on the Windows development host (see `docs/CODING_ROADMAP_STATUS.md`) |
| Packaged-app layout: runtime + `node_modules` present, dependencies resolve, server boots from the packaged executable, bundle unmodified | **verified on Windows** with an unpacked electron-builder build; re-run automatically on macOS in CI |
| `Phone-Farm-<version>-arm64.pkg` **built** | **automated CI verified** on a GitHub macOS runner (run 35707854622); the stable release alias is `Phone-Farm-macOS.pkg` |
| `.pkg` installed with macOS Installer and the installed server booted | **automated CI verified** on that runner; not yet accepted on the physical Mac mini |
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
3. Download **only** `Phone-Farm-macOS.pkg` from the GitHub Release.
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

### Live-screen geometry, input and timing

Use the same `1536x864` browser/window size for the first pass so results are comparable with the original
`90x160` full-screen regression. Repeat once at the Mac's normal maximized window size. Record numbers; do not
substitute "looks good" for the measurements.

25. Open Phone A in portrait, enable **Live view**, and enter Phone Farm's full-screen phone layout. Record the
    stream's intrinsic dimensions, rendered canvas width/height, visible FPS, and viewport size. The whole phone
    must remain visible, the toolbar and Home control must remain reachable, and at least one rendered canvas edge
    must reach the available contain-fit boundary (within two CSS pixels). The image must not crop or stretch.
26. Tap a harmless target near the center and once in each screen quadrant. Require the physical target under the
    pointer to receive every tap. Then drag in both axes, use wheel/trackpad scrolling, type a unique test string,
    and press Home. Record any offset or wrong target; a visually large screen with incorrect coordinates fails.
27. Rotate Phone A to landscape and back to portrait. At each orientation require the canvas to refit without crop,
    stretch, or an unreachable toolbar, then repeat one tap and one drag. Repeat steps 25-27 on Phone B.
28. Take ten samples per phone of (a) command dispatch-to-response time and (b) tap-to-visible-frame-change time.
    Record every sample plus p50 and p95, the selected live transport, requested/observed FPS, phone model, iOS
    version, and whether the Mac/phone became hot. No release latency threshold has been approved yet, so this step
    produces evidence for that product decision; it does not invent a passing number.
29. While Live view is on, hide the app for at least five seconds and return. It must show **Live paused** while
    hidden, resume without duplicate/overlapping fetches, and leave tap/drag/type/Home usable. Release the phone,
    sign out, and confirm polling stops; sign back in and reacquire it before continuing.

### File push to the real phone

30. Upload a small, non-sensitive fixture with a unique filename to Phone A. Use the file's **Push to phone** action.
    Require one explicit per-file outcome rather than a fire-and-forget success.
31. On Phone A, verify Safari completed the download and the file appears in Files with the expected name, size, and
    readable contents. Repeat on Phone B. Record the iOS/Safari accessibility labels actually observed if the skill
    reports `NEEDS_HUMAN`, `TIMED_OUT`, or `FAILED`; these labels are the expected calibration point for
    `filePushSkill.js`.
32. Confirm diagnostics/audit history records link issuance, consumption, and the final push result without including
    the raw one-time URL/token. A second use of the consumed link must fail. Delete the fixture through the normal UI
    after recording evidence.

### Opt-in proxy routing and isolation

These steps require two approved proxy exits and the persisted host routing settings to be explicitly enabled. They
are not part of ordinary automatic WDA/iproxy startup. Keep credentials in the app's protected local configuration;
never paste them into this record, chat, screenshots, diagnostics, or shell history. Follow the detailed recovery and
rollback procedure in `docs/RELIABILITY_NETWORK_FINAL_REPORT.md` sections 16-17.

33. Confirm preflight for tun2proxy and the narrow PF privilege. Create/test two distinct proxy-pool entries, assign
    one per phone, enroll each USB interface sequentially if discovery is ambiguous, and start routing. One saved
    proxy must not lease to both phones.
34. Require each phone to remain `VERIFYING` until its own device-originated network check succeeds. Record only safe
    evidence: phone label, expected/observed country, redacted public-IP fingerprint, timestamp, latency, and result.
    Do not accept host-side proxy health as proof of phone routing.
35. From Safari on each phone, use the operator-approved IP/DNS/WebRTC/IPv6 test pages. Require distinct expected
    exits, expected DNS resolvers, no direct/local-address WebRTC disclosure beyond the approved policy, and no IPv6
    path when policy says IPv6 is blocked. Save redacted screenshots and page names/timestamps, not credentials.
36. Confirm each phone has an independent USB address, tunnel, TUN peer, PF route/counter, proxy lease, and fresh
    verification. Phone A activity must increment Phone A's route evidence without being attributed to Phone B.
37. Terminate only Phone A's tun2proxy child using Activity Monitor after identifying it from the app's device-scoped
    diagnostics. Require Phone A to fail closed immediately and either recover within the bounded retry budget or
    remain blocked. Phone B must stay controllable and protected. **Stop the run immediately** if Phone A obtains
    direct Internet during the fault.
38. Terminate only Phone A's iproxy, then its WDA process, one at a time. Require device-scoped recovery; Phone B must
    not restart or lose control. Re-run Phone A's device-originated network check before accepting `PROTECTED` again.
39. Unplug Phone A. Phone B must remain controllable and routed. Reconnect Phone A and require stable logical identity,
    preferred-port reuse when safe, WDA/iproxy recovery, fresh interface discovery, route rebuild, and a new passing
    device-originated check.
40. Quit Phone Farm completely and relaunch it from Applications. Require both phones to recover independently; no
    stale route may be reported `PROTECTED` before current device-originated evidence exists.
41. Run the healthy two-phone case for 30 minutes. Record disconnects, frame stalls, process restarts, CPU/energy
    observations, phone heat, and final network checks. Then use **Stop routing** for each phone and confirm the private
    routes/tunnels are removed without flushing unrelated Mac PF configuration.

### Additional checks when signing/notarization credentials are configured

42. **No** "unidentified developer"/"cannot be opened" Gatekeeper warning when opening the downloaded `.pkg`.
43. `pkgutil --check-signature Phone-Farm-<version>-arm64.pkg` reports a valid **Developer ID Installer** signature.
44. `spctl --assess --type install -vv <pkg>` accepts the package, and `spctl --assess --type execute -vv "/Applications/Phone Farm.app"` accepts the installed app.
45. `xcrun stapler validate <pkg>` (and the app) reports the notarization ticket is valid.

`npm run verify:pkg -- <pkg> --expect notarized` in `desktop/` automates the signature, ticket, Gatekeeper,
payload and boot checks (42 excepted — it is a visual check).

### Record

Package filename, its SHA-256, macOS version, Mac architecture, Phone Farm commit/tag, iOS versions, and
pass/fail evidence for each numbered step. A working screenshot/render and input test does not by itself
validate video monitoring or network/proxy routing.

Use one row per numbered step so a partial run cannot be mistaken for complete acceptance:

| Step | Phone/route | Pass/fail/blocked | Timestamp | Evidence location | Notes/error code |
|---:|---|---|---|---|---|
| 1 | Host |  |  |  |  |

Record secrets as `configured`/`not configured` only. Record raw UDIDs and public addresses in a restricted local
attachment if they are genuinely needed for diagnosis, not in this repository. A blocked step stays blocked; do not
convert it to pass because a mock, automated test, or the other phone succeeded.

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
