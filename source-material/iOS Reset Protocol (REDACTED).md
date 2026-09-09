# XYZ MGMT · Internal · 30 July 2026

Why a factory reset on iPhone is much cleaner than the common advice suggests, what the one real exception is, and how to test any device before committing an account to it.

This applies to iOS specifically. Most advice about device fingerprinting comes from the Android world, where apps historically had far deeper hardware access. It does not transfer to iPhones, and assuming it does leads to retiring hardware unnecessarily.

## What a third-party iOS app can actually read
Apps have access to exactly two device identifiers:
* **IDFA — Identifier for Advertising.** Resets on user reset, or factory wipe.
* **IDFV — Identifier for Vendor** — consistent across one vendor's apps. Resets on deletion of all that vendor's apps, or factory wipe.

Apps cannot read:
* IMEI or MEID
* Hardware serial number
* MAC addresses
* UDID — deprecated for app use since iOS 5

This is the part most people get wrong. The "hardware fingerprint survives a factory reset" claim is an Android argument. On iOS, Apple removed app access to those identifiers years ago, and both identifiers apps can read are cleared by a wipe.

Sensor-based fingerprinting — accelerometer and gyroscope calibration bias, touch calibration, GPU rendering quirks — is real in academic research and can survive a reset in principle. It is research-grade rather than standard anti-abuse practice, and there is no public evidence any consumer app builds a stable identity from it.

## The one real exception: Apple DeviceCheck
Introduced in iOS 11 specifically because Apple had removed the raw identifiers and developers still needed a way to fight fraud and repeat abuse.

**How it works:**
* Apple stores two bits of state per device, per developer team, on Apple's own servers.
* Four possible values: 00, 01, 10, 11.
* The token is cryptographically anchored to the device's Secure Enclave hardware.
* It survives a factory reset, a full data wipe, and a new Apple ID.

> **Apple's own wording:** "Changing an account on the device or wiping the device's data won't reset the bits you associated with it."

So if a platform flags a device, that flag persists through everything a user can do to the phone. In practice a platform might set 01 to mean "this hardware hosted a banned account." A fresh install returning 01 tells their risk engine to demand phone verification, shadowban, throttle, or auto-ban — before a login even happens.

## The four limits that matter

**It is a coarse flag, not a tracking ID**
Two bits. Four states. It can mark a device as risky; it cannot identify which account was banned, and it cannot link two accounts to each other. It feeds a risk score. It is not a fingerprint.

**It requires deliberate engineering**
DeviceCheck is not an automatic iOS feature. A developer must write server-to-server integrations against Apple's endpoints, decide when to set a bit, and check it on launch. High-abuse platforms commonly do this, often paired with App Attest for app integrity. Whether any specific app sets or checks bits, and how aggressively, is internal business logic and not public. It cannot be determined from outside.

**Developer team isolation**
DeviceCheck state is scoped strictly per Apple Developer Team ID. A flag set by one company has zero visibility to another company's backend.
*Caveat: a company running several apps under one developer certificate can share state across its whole portfolio.*

**Mobile Safari bypasses it entirely**
DeviceCheck and App Attest are native iOS frameworks. A browser sandbox cannot execute them, so mobile web never invokes DeviceCheck and never touches hardware-level flags.
But this is a trade-off, not a free win. Web traffic carries a lower baseline trust score than a native app install, and it exposes you to standard web fingerprinting instead — canvas, WebGL, cookies — plus tighter automated rate limits. If the reason for buying iPhones is the native-app trust signal, using the browser gives that up. Treat it as a fallback for a device that tests as flagged, not as the default.

## The refurbished hardware risk
This is the biggest blind spot in multi-account setups.

DeviceCheck bits belong to the hardware, not to the owner. A used or refurbished iPhone that was flagged by a previous owner arrives already carrying that flag. You can set up a clean iCloud, a fresh SIM, a new email and completely distinct behaviour, and still have the account burned instantly because of someone else's history on that Secure Enclave.

**Consequence:** Every purchased device gets tested before it becomes a real account. New units included.

## What actually links accounts
Ranked by how much they matter. Note that hardware is not at the top.

* **Behavioural pattern — survives everything:** Posting hours, subreddit selection, caption phrasing, cadence, voting behaviour. Completely device-independent. This is the real linkage risk and almost nobody optimises for it, because it does not feel like a fingerprint. Rebuilding an account on clean hardware with a clean number and then running it identically to the one that just died wastes the entire reset.
* **Reused credentials — entirely within our control:** Same iCloud, same email, same phone number. These are account-level links, and unlike hardware identifiers they are a choice rather than a constraint. The phone number is the sharpest one. If a number SMS-verified a banned account, reusing it is a direct connection and a far harder link than anything a wipe clears.
* **Account graph:** Following, DMing, upvoting or joining anything the previous account touched. Reddit retains this indefinitely.
* **DeviceCheck bit — if the platform implements it:** Persistent, unclearable, but only two bits and only a risk signal.
* **IP address — weak:** Mobile data means carrier-grade NAT, shared with thousands of other users. Closer to camouflage than to identification. Changing location shifts the tower and the CGNAT pool, which is worth something but not much.

## The test protocol
Because whether a platform uses DeviceCheck is unknowable from outside, do not reason about it — measure it.

On any device, before building a real account on it:
1. Factory reset — Erase All Content and Settings
2. New Apple ID, never used before
3. New SIM with a new phone number
4. Install the app, create a throwaway account
5. Use it normally for a few days — browse, vote, comment

**Result — Meaning:**
* **Survives normal use:** No flag on this hardware. Safe to build on.
* **Insta-banned, shadowbanned, or hit with immediate verification demands:** Something is flagged. No amount of resetting fixes it.

Costs nothing, and it answers the question for the specific hardware in hand rather than in the abstract.

**Stopping rule:** Two consecutive throwaways dying quickly on the same device means it is burned. Retire it. Each failed cycle can add flags, so iterating makes it worse rather than more informative.

## Recycling a device after a ban — the checklist
1. Factory reset
2. New Apple ID
3. New SIM and new phone number — the highest-value item on this list
4. New email address
5. New location if convenient — helps a little, not worth significant effort
6. Run the test protocol before building anything real
7. Change the behavioural pattern — different posting hours, different sub mix, different caption voice

*Note: Steps 3 and 7 do more work than the reset itself.*

## How this position was reached
Worth recording, because it was wrong twice before it was right.

* **First position — "hardware fingerprint survives, never reuse a banned device."** Wrong. Inherited from Android-oriented advice about IMEI and MAC persistence, which iOS does not expose to apps at all.
* **Second position — "iOS resets are clean, reuse freely."** Also wrong. Correctly identified that raw identifiers are inaccessible, but missed DeviceCheck entirely — a mechanism built specifically to survive the thing that was being called sufficient.
* **Current position — "test every device, because the mechanism is unknowable from outside."** This does not depend on being right about the internals, which is why it is the one to keep.

The correction came from cross-checking against a second model and finding the disagreement. On questions where being wrong is expensive and nobody is reasoning from documentation they have actually read, that is worth doing.

## Sources
* Apple identifiers — which are accessible to apps
* Prevent fraud on iOS with DeviceCheck and App Attest — adjoe engineering
* Mitigate fraud with App Attest and DeviceCheck — Apple WWDC21
* DeviceCheck framework — Apple Developer
