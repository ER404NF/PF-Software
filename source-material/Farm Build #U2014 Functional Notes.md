# Farm Build — Functional Notes

**Purely the engineering. How a device gets controlled, how media gets onto it, how many fit on a host, and what breaks.**

Version 1.1 — 26 August 2026

---

## 0. Scope

**This is the "make the rack work" document.** No strategy, no platform policy, no account theory — that is all in `Phone Farm — Technical Brief.md`.

Everything here is mechanism. It is the detail that did not make the brief because the brief was written to support a build/no-build decision, and this is written to support a build.

**Same confidence labels as the brief.** Anything marked **UNTESTED** we have not run ourselves — and Dim may already have. **Ask him before spending time on anything in that state.**

---

## 1. Controlling an iOS device — the three routes

There are only three ways to drive an iPhone programmatically, and they have very different costs.

### Route A — HID over OTG (the control-chip approach)

A chip sits between the phone and the host and **presents itself as a USB mouse and keyboard**. Software sends pointer and key events. The phone believes a human is using a mouse.

| | |
|---|---|
| **Jailbreak needed** | No |
| **Code signing needed** | No |
| **Developer account needed** | No |
| **App install on device** | No |
| **Host OS** | **Windows only** for the product we looked at |
| **Cost** | ~$38 per chip, one per phone, plus ~$0.75/phone/month |
| **Supported** | iPhone 6s and above, iOS 13.4 and above |
| **API** | HTTP and WebSocket, Python bindings |
| **Vision** | Find-image, find-colour, OCR |

**The big advantage: it sidesteps every Apple-imposed limit at once.** No signing means no 100-device developer cap, no 7-day profile expiry, no Mac.

**The big open question is in §6.1 of the brief** — whether pointer-driven taps are distinguishable from finger taps on iOS 17+.

### Route B — Apple's own automation (XCUITest / WebDriverAgent)

Drives the device through the accessibility layer. This is what CI and QA labs use.

| | |
|---|---|
| **Jailbreak needed** | No |
| **Code signing needed** | **Yes** |
| **Developer account** | **$99/yr.** Free tier is unusable — 7-day profile expiry, 3-device cap |
| **Hard limit** | **100 devices per product family per membership year.** Disabling a device does **not** free the slot. Resets annually, but only if you clear the list *before* adding the year's first new device |
| **Host** | **A Mac, at least once** — see §5 |
| **Cost** | ~120MB RAM per device instance; up to ~15s launch overhead per instance |

**It can drive already-installed App Store apps** — the driver accepts a bundle ID alone, no re-signing of the target app required.

### Route C — Jailbreak

**Effectively closed, and closed for a good reason.**

- The bootrom exploit tops out at **A11 — iPhone 8 / 8 Plus / X.** Nothing newer.
- On A11 specifically you **must disable the device passcode** while jailbroken, which degrades Secure Enclave function. Anything that checks device attestation will likely fail or refuse.
- The main system-wide automation toolkit for this route was **archived in 2022** and targets iOS 13–14.
- **Snapchat runs its own anti-tamper checks on iOS** — codesigning flags, package artefacts, hook detection. A jailbroken device is a detectable device.

**Do not plan around this route.**

### What cannot drive a device at all

**MDM.** We enumerated Apple's full documented command set — profiles, app install, erase, lock, restart, lost mode, eSIM refresh. **There is no screenshot, touch-injection or UI-automation command.** MDM provisions. It does not drive.

**iPhone Mirroring.** One Mac to one iPhone at a time, both on the same Apple Account, phone must be locked and nearby, unavailable in the EU. Irrelevant at any scale.

---

## 2. Phone-side configuration for the HID route

**Not optional — the control software requires all of this set on every device.** This is real per-device setup labour and it should be in any time estimate.

| Setting | Why |
|---|---|
| **AssistiveTouch — on** | Enables the pointer input path |
| **Trackpad & Mouse — tracking speed max** | Pointer calibration; the software's coordinate mapping assumes it |
| **Full Keyboard Access — on** | Required for keyboard events **and** for the shortcut-triggered functions in §3 |
| **Screen mirroring to the controller** | How the host sees the screen |
| **Auto-Lock — Never** | A locked screen ends the session |
| **Brightness — minimum** | Heat and power |
| **Portrait orientation lock — on** | Coordinate stability |
| **Control Centre layout — two icon rows** | The software's UI navigation assumes it |
| **Same network segment as the host** | See §4.3 — **this is the unresolved egress problem** |

**Mouse pointer calibration differs by iOS version** — the vendor documents different settings for iOS 14.2+ versus earlier. Worth confirming per model.

**UNTESTED by us.** Dim has run this stack. Get the real setup friction from him rather than from this list.

---

## 3. Getting media onto the device — the part everyone underestimates

### 3.1 Why the obvious approach does not work on iOS

**The iOS photo library is a database, not a folder.**

Assets live under a media directory, but the library of record is a SQLite database populated by a system daemon during ingestion, which also generates thumbnails. **There is no media scanner.**

**Consequence: copying a JPEG into the device's DCIM directory over USB does nothing.** The file lands. Photos never sees it. This is reported consistently and repeatedly across the tooling ecosystem.

**This is the single biggest functional difference from Android and it surprises everyone once.**

### 3.2 What AFC can and cannot do

AFC is the file-transfer service the phone exposes over USB.

- It **is** read *and* write, jailed to the device's media directory
- It works from **Windows, Linux and macOS** — no Mac required
- No Apple ID required, but it needs a trusted USB pairing
- **Wireless clients have been barred from the media folder since 2014 — USB only**
- The unjailed, whole-filesystem variant is jailbreak-only and irrelevant

**So AFC is a byte transport, not a camera-roll write path.** You can put the file on the device. You cannot make it a photo.

*Ignore the folklore that files appear after a reboot. That claim predates the current photo-library architecture.*

### 3.3 What actually works on iOS

**Every working method runs code on the phone.** Two shapes:

**A helper app.** Some desktop tools install a companion app on the device that calls the photo framework on their behalf. The helper must be running during the import.

**Apple Shortcuts — this is what the control software uses.** Its API exposes album operations directly:

| Endpoint | Function |
|---|---|
| `/shortcut/album/upload` | Send photos or videos to the device album. Takes a file array, optional zip compression, and a target album name |
| `/shortcut/album/get` | List album contents |
| `/shortcut/album/down` | Retrieve from the device |
| `/shortcut/album/del` | Delete specific items |
| `/shortcut/album/clear` | Empty the album |
| `/shortcut/file/upload` and friends | Files-app root. **iOS 15+ only** |

**The requirement that costs time: the vendor's shortcut must be installed and bound on every device**, tied to a keyboard command — which is why Full Keyboard Access is mandatory in §2.

**What does not work:** desktop sync tools that create "From My Mac"-style albums. Those land in a **separate, read-only album** with a distinct source type, and an app must *explicitly opt in* to see them. **Whether a given social app's in-app picker surfaces them is unverified — assume no until tested.**

### 3.4 Android, for comparison

```
adb -s <serial> push image.jpg /sdcard/DCIM/Camera/
adb -s <serial> shell content call --method scan_volume --uri content://media --arg external_primary
```

Two commands. Free. Scriptable. Parallel. Works wirelessly with persistent pairing.

`adb shell` runs as the shell user, which is not an app, so scoped storage does not apply. **The file must go in a user-facing media directory or it will not index**, and the rescan is mandatory or it will not appear promptly.

**One caveat:** `adb push` does not reliably preserve file modification time. File bytes including metadata are untouched, but where the media store derives a date from mtime rather than embedded metadata, dates can come out wrong.

---

## 4. Host topology — how many devices, and what breaks

### 4.1 The real ceiling is USB endpoints, not addresses

| Limit | Value |
|---|---|
| USB addresses per host controller | 127 — theoretical, never the binding limit |
| **Controller endpoints** | commonly 96 → **~32 devices at 3 endpoints each** |
| **USB tiers** | 7 maximum → **5 daisy-chained hubs** |

Built-in peripherals consume endpoints before you plug anything in.

### 4.2 What operators actually report

| Report | Detail |
|---|---|
| **~22 devices** and the provisioning CLI stops listing them | USB tree uniform, 3 hubs deep, all devices visible at OS level. **Never resolved.** Single source, and it predates current Apple silicon |
| **25 phones on one host**, 4 hubs, ~6–7 devices per hub with 2.5A supplies | Mixed iOS/Android |
| **Power draw kills the bus** | 120W hub with 5 phones — **"within 36 hours the USB gets disconnected by the mac due to excessive power draw"** |
| **Silent enumeration decay** | Phones became invisible to the host after **30–60 minutes** while still charging normally. Connection refused on the control port |
| **Vendor benchmark, optimistic end** | 30 iPhones restored in ~9.5 min on a current Mac mini with 3 industrial hubs; 60 devices in ~13.6 min with 6 hubs daisy-chained |
| **Open-source farm software guidance** | ~28 devices per host across 4 powered hubs; ~10 more on motherboard ports, "not recommended" |

### 4.3 The failure mode to design against

**Silent enumeration decay is the one that will cost you.** The devices charge, the lights are on, nothing errors — and the host has quietly stopped seeing them. **Anything built here needs a heartbeat per device, not a "did the job run" check.**

**Practical design unit: 10 devices per host.** Not because more is impossible, but because a 10-device blast radius is manageable and three small hosts cost less than one host plus the industrial hubs it would need.

### 4.4 Power and charge control

- **Managed hubs** can hold a target charge level in 5% increments and cap per-port power in fine steps, with per-port draw and voltage visible. That is how you catch a swelling cell before it becomes a fire.
- **On-device charge limiting is iPhone 15 and later only.** Everything older has only the adaptive feature, which learns from usage patterns and is effectively inert on a racked device.
- Vendor chassis budget **~10W per phone** and treat active cooling as mandatory.
- Continuous 100% float accelerates degradation and swelling. **Swelling is the pre-failure signal to watch for.**

---

## 5. Removing the Mac dependency

**The only thing that genuinely, permanently requires macOS is compiling and signing WebDriverAgent.** Everything else has a Windows path.

Two techniques worth knowing:

**Pre-built WDA.** On iOS 17+, the Appium driver accepts a pre-installed or pre-built WDA bundle. Tools exist to install and launch it from Windows or Linux. **You need a Mac once to produce the signed bundle, then not again.**

**USB-over-network forwarding.** A utility exists that makes devices attached to one machine appear locally on another. **This decouples "the machine that signs" from "the machine the phones hang off"** — one Mac in a corner, phones on cheap Windows hosts.

**Also note:** the HID route in §1 needs no Mac at any point. That is its main architectural argument.

---

## 6. Provisioning at scale

**Apple Configurator blueprints** (macOS only to author; some equivalents can apply from Windows) can automate:

- Device naming with variables — `XYZ-01`…`XYZ-30` in one operation
- Wi-Fi profiles and restrictions
- Wallpaper and Home Screen layout, including folders
- **Skipping Setup Assistant panes** — chosen at prepare time
- **Deferring OTA software updates 1–90 days** — the mechanism for "do not auto-update," which matters if the iOS-version-freezing idea in the brief is pursued

**The supervision trade-off, and it is a day-zero decision:**

- **Supervising erases the device.** Un-supervising also requires an erase. **Retrofitting supervision to a phone with a warmed account on it means starting that account over.**
- **App installation through it appears to require a business-account content token.** We could not confirm a route using an ordinary Apple ID. **UNTESTED — one phone, one attempt would settle it.**
- A 2026 platform change means devices no longer restore management state from backups, which weakens the non-enrolled path over time.

**At 20–30 devices, blueprints are worth it for naming, Wi-Fi, layout and update deferral. Supervision probably is not**, given the erase cost and that the only apps needed are one or two.

---

## 7. Known failure modes, with symptoms

**The most useful table here. Build monitoring against this list.**

| Symptom | Likely cause | Note |
|---|---|---|
| Devices charge but vanish from the host after 30–60 min | Enumeration decay | Needs a per-device heartbeat to detect |
| Whole bus drops after ~36 hours | Hub power draw exceeding what the host tolerates | Managed hub with per-port limits |
| Provisioning CLI lists only some devices past ~22 | Endpoint exhaustion or hub topology | Split across hosts |
| Files copied to device, never appear in Photos | The §3.1 database-not-folder problem | Expected. Use the shortcut route |
| Automation breaks after an app update | Fixed-coordinate scripting | The argument for OCR/template matching |
| Battery swelling | Continuous float charge plus heat | Hub-side charge target, spacing, ventilation |
| Device silently stops posting, no error | Could be enforcement, could be §7 row 1 | **Distinguishing these two needs instrumentation** |

---

## 8. Loose technical claims from the two operators

**Things said in the source conversations that are mechanism rather than strategy, and did not fit anywhere above.** Some are useful, one is probably wrong, and one is a sourcing lead.

| Claim | Source | Our read |
|---|---|---|
| **"before I implemented input randomization to a higher degree"** — roughly 2% of accounts were challenged to verify as human, and that stopped once input timing was randomised more aggressively. Once verified by captcha and phone number, accounts "function perfectly" | Operator B | **The single most actionable line either of them said about automation.** It means fixed-interval, fixed-path input was detectably robotic, and jitter fixed it. **Treat input randomisation as a design requirement, not a refinement** |
| **One Apple ID can be reused across every device** to install the app "without breaking isolation" | Operator A's playbook | **Probably wrong, or at least risky.** Apple documents a limit of ten devices associated to one account for purchases, and up to a 90-day wait to move a device to a different account. It also creates one Apple-side identifier common to the whole fleet. **The brief recommends one Apple ID per device. Worth resolving before provisioning anything** |
| **App cloning can run 20+ isolated app environments on a single device** — used for less strict platforms, explicitly *not* for Snapchat | Operator A's playbook | Plausible on Android; on iOS this needs a container/cloning tool. **Note Snapchat's Android client actively detects cloning frameworks**, so this is platform-specific and not portable |
| **Remote device control for VAs via AnyDesk or custom software** | Operator A's playbook | A remote-desktop-to-the-host approach rather than per-device browser control. **Simpler, but it gives an operator the whole host rather than one device.** Operator B's dashboard model assigns individual devices per login — better isolation, more to build |
| **"I actually know the person who makes those chassis"** — Operator B recognised the enclosure from a photograph and knows the manufacturer | Operator B | **A sourcing lead, not a technical claim.** If chassis procurement becomes a bottleneck this is a direct route to the maker |
| **Hub farm capacity of up to 580 devices** | Operator A's playbook | A stated ceiling for the enclosure type, not a claim about a single host. **Does not change the per-host limits in §4** |
| **"Snapchat geotargets extremely well"**, plus an unstated method for targeting states and large cities | Operator B | Untested and unexplained. Recorded because a geo-targeting capability would change how a fleet is provisioned — **worth asking him what the mechanism is** |
| **Offer to build a login-gated web dashboard** where VAs are assigned individual devices, admin login separate, hardware staying with us | Operator B | Standing and unclaimed. **Relevant as a reference architecture even if we build our own** |
| **Offer to introduce developers** already working on this stack, and to port existing automation functions | Operator B | Standing and unclaimed |

**One caveat on this whole table.** These are quotes from two people describing their own systems, not verified engineering. The one marked "probably wrong" is the one to check first, because it would be a provisioning decision that is expensive to reverse.

---

## 9. Open engineering questions

Ordered by how much the answer changes the build.

1. **Does app traffic egress via the SIM or the shared control network?** §2 requires the phone on the host's network segment, and iOS prefers WiFi when associated. **If it is the WiFi, every device shares one public address.** Two phones and a public-IP check.
2. **Are pointer-driven taps distinguishable from finger taps on iOS 17+?** §6 of the brief. Verify the platform documentation in Xcode.
3. **What is the real device-per-host ceiling on current hardware?** The ~22 report is single-sourced and predates Apple silicon. **Cheap test: borrow hubs, enumerate 25.**
4. **Can provisioning install App Store apps without a business account?** One phone, one attempt.
5. **Does a settings-level erase preserve the iOS version?** Foundation of the version-freezing idea. Five minutes.
6. **Realistic data consumption per device per month.** Decides whether per-device proxies are affordable at all.
7. **Bulk pricing on the control chips.** Our figure is single-unit retail from a page marked sold out.

---

## 10. Before acting on any of this — ask Dim

**He has run the control software and confirmed it works.** That makes him the only tested source in this document.

Specifically worth getting from him rather than from here: the actual per-device setup time, what the phone-side configuration in §2 is really like in practice, how many devices he has had stable at once, and anything in §7 he has already hit.

**If he contradicts this document, he is right.**

---

*XYZ MGMT — Confidential & For Internal Use Only*
