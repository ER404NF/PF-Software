# §4 research — actual device-file-push mechanism

Status: **BLOCKED on an owner decision** — this is research only, per `PRODUCTION_READINESS_AUDIT.md` §4's own
explicit instruction not to write code until the mechanism is chosen. No code changed for this item.

## The question

`PRODUCTION_READINESS_AUDIT.md` §4 rated media transfer 2/10: files reach the server's per-device staging
folder (§3) but nothing pushes them onto the physical iPhone. Two candidate mechanisms were named, with a
note that Photos-library access "is intentionally restricted by Apple without a jailbreak — verify current
feasibility before assuming it's possible." This is that verification.

## Finding 1: there is no reliable, documented way to push an arbitrary file straight into the Photos library
without a jailbreak

- Plain AFC (`com.apple.afc`, what every non-jailbroken host tool including this project's own
  `idevice_id`/`ideviceinfo` already uses) exposes the device's Media root — DCIM, Downloads, Books,
  Recordings — and is well-documented for **reading** photos off the device (that's how Finder/iTunes/Image
  Capture import photos *from* a phone). Writing a *new* file into DCIM such that it appears in Camera
  Roll/Photos the way a real camera-taken photo does is not a documented, stable AFC operation — the closest
  real mechanism (iTunes/Finder's legacy "Sync Photos") is a completely different, computer-managed photo
  library sync flow (bundles a curated library and hands the whole thing to the device via its own
  plist-driven protocol), not "drop one file in a folder," and isn't something this project's existing
  `idevice*` toolchain already does or that has active, current tooling for.
- **AFC2** (full, unrestricted filesystem access, which *could* trivially drop a file anywhere including
  DCIM) is exactly the thing that requires a jailbreak — it doesn't exist as a service on a stock device at
  all. This route is closed, by Apple's own design, for as long as devices in this fleet stay unjailbroken
  (and CLAUDE.md's own product direction doesn't call for jailbreaking these devices).

## Finding 2: there IS a real, documented, no-jailbreak mechanism — but it targets an app's own sandbox, not
Photos

- **`com.apple.mobile.house_arrest`** ("House Arrest") is a distinct, well-documented lockdown service
  (separate from plain AFC) that, given a specific app's bundle id, hands back an AFC connection scoped to
  *that one app's own container* — its sandboxed `Documents` folder specifically, not the whole filesystem.
  This is exactly the mechanism `libimobiledevice`'s own `afcclient`/`ifuse --container` support, and it's
  also what Appium's real-device `push_file` command
  (`appium-ios-device`) uses under the hood — i.e. this is mainstream, current tooling, not an obscure or
  abandoned trick.
- **The catch, and it's a real one:** this only works for an app that opts in via
  `UIFileSharingEnabled` (and, for the file to be visible in the Files app / other apps' "import" pickers, the
  complementary `LSSupportsOpeningDocumentsInPlace`) in its own `Info.plist` — the target app has to *want*
  this. You cannot use House Arrest to push a file into an arbitrary app (e.g. Instagram, TikTok, Photos
  itself) that hasn't opted in. It also lands the file in that app's own private Documents folder, not
  automatically "imported" into whatever the app's own content model is (a video app still has to notice and
  import the file itself, e.g. via its own "browse Files" flow) — pushing the *bytes* onto the device this way
  is real and current, but it is not automatically the same as "the file is now usable content inside the
  target app."

## What this means for the two options §4 posed

- **Option (a), direct Photos-library push:** confirmed infeasible without a jailbreak, for the reasons
  above — not a "maybe with enough effort," a real protocol-level restriction Apple maintains deliberately.
- **Option (b), automate an existing in-app import flow with the tap/swipe primitives already built:** this
  is the mechanism that actually works today, and generalizes better than House Arrest — it doesn't depend on
  which specific destination app is being targeted, or on that app supporting file sharing at all. The
  realistic version of it: stage the file somewhere the device can reach over the network this project
  already controls (an authenticated, per-device-scoped HTTP URL served by this same server — §3's existing
  upload/download routes are already exactly this), drive Safari (or the target app directly) to that URL,
  and use the OS's own Share Sheet / "Save to Files" / the target app's own "Import"/"Add from Files" button —
  the same sequence a human VA already does by hand today, just executed through the tap/swipe primitives
  `wdaDevice.js` already implements. House Arrest remains available as a secondary, narrower path specifically
  for whichever destination apps *do* support file sharing, if that turns out to matter for a particular
  workflow.

## Recommendation (for the owner to confirm, not a decision made here)

Build option (b) first — it's the only one of the two that's actually general-purpose and provably works
today with tooling already in this repo, and House Arrest can be layered in later as an optimization for
specific file-sharing-enabled apps if a concrete need for it shows up. This still needs a real design pass
(which app(s) are the actual destination for VA work, what the exact tap sequence looks like for each,
per-file success/failure reporting) before writing code — flagged here, not designed here, per the audit's
own instruction to bring findings back before building.

## Proof this cannot skip

Per the audit's own §4 proof requirement, whichever mechanism is chosen can only be verified against a real
Mac mini + iPhone, not this development environment — sequence this after §12 (a real deployment) per the
audit's own priority ordering.

## Report (per the audit's own template)

```text
Item fixed: §4 research only — no code written, per the audit's explicit "research before building"
Files changed: docs/productionization/P4_DEVICE_PUSH_RESEARCH.md (this file)
Security impact: none — no code changed
Tests added: none — nothing to test yet
Tests run: n/a
Real hardware involved: no — this is protocol/mechanism research, not a hardware trial
Known limitations: recommendation is not owner-confirmed; the actual design (which app(s), exact tap
  sequence, per-file success reporting) still needs a dedicated pass once real hardware exists
Status: BLOCKED (needs an owner decision on the recommended mechanism before any code is written)
Next item: once confirmed, design + build against real hardware, sequenced after §12
```
