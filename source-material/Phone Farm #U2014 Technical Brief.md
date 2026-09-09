# Phone Farm — Technical Brief

**Everything XYZ MGMT has learned about iOS and Android device farms, prepared for technical review**

Version 1.1 — 26 August 2026

---

## 0. What this is, and what we need from you

XYZ MGMT is deciding whether to build a physical device farm for social-media traffic. We have direct access to two working operators who run very different systems, and we have run a large independent research pass against everything they told us.

**This document is the whole picture, redacted.** We are not asking you to decide whether to build it — that is our call. **We are asking you to review the technical architecture, tell us what is wrong with our understanding, and help us structure it.**

The specific questions are in **§11**. Read them first if you want to know where to focus.

### Two options are on the table, and they are very different builds

| | **Option 1 — high-volume disposable** | **Option 2 — small durable set** |
|---|---|---|
| Platform | Snapchat | Instagram / TikTok |
| Devices | 100–300 | 5–30 |
| Account life | ~14 days by design | Months to years |
| Posture | Accounts are consumables, replaced in batches | Accounts are assets, grown slowly |
| Automation | Necessary at that scale | Possibly unnecessary |
| Host | Windows | Possibly Mac mini |

**Our current honest position on Option 1:** the traffic is real and the money is real, but if the system requires replacing every phone every two weeks, **we may not be operationally ready for it.** That is a resourcing judgement, not a technical one, and it is why Option 2 is being considered in parallel. Option 2 is written up separately in `Concept — Long-Term Organic Device Set.md`.

---

## 0a. READ THIS FIRST — work with Dim

**Dim is the single most important input on this project and he is not in this document.**

He has done hands-on work that is not written down anywhere: he has **tested the mirroring/control software himself and confirmed it works**, he has handled devices, and he holds practical knowledge of what has and has not worked in our own attempts. **This brief is research. Dim is experience.**

**Please talk to him early, talk to him often, and treat him as a primary source rather than a stakeholder to update.** He will reply actively — this project matters to us and he is engaged with it.

Specific things to get from him rather than from this document:

| Ask Dim about | Why |
|---|---|
| **The name of the mirroring/control software he tested** | It is a Chinese product, it works, and we have it. **It is not named in this brief because we want the name from the person who actually ran it, not from our research notes.** There is a second candidate — Operator B recommended a specific product — and we may end up using that one instead. **Dim can tell you which is which and what he saw** |
| What he actually observed running it | Setup friction, stability, how many devices, what broke |
| Devices we already hold | Models, condition, what state they are in |
| Chassis and hardware already bought or trialled | We have at least one 20-device enclosure already — see §10a |
| Anything he tried that failed | The failures are worth more than the successes here |

**If this brief and Dim disagree, Dim wins on anything he has personally tested.** Write the correction back and tell us.

---

## 1. How to read this

### Confidence labels

| Label | Meaning |
|---|---|
| **SOLID** | Verified against a platform's, vendor's or operating-system's own documentation, or multiple independent sources that agree. Treat as fact unless you can show otherwise |
| **LIKELY** | Consistent across several third-party sources, not found in official documentation |
| **CONTRADICTED** | Public evidence directly opposes the claim as stated |
| **IN THE AIR** | No source found either way. Not disproven — unknown |
| **FOLKLORE** | Forum claim with no corroboration. Recorded because it circulates, not because it is established |

**§7 lists what we believe is solid. §8 lists what is in the air. §9 lists what we think the operators got wrong.** Those three sections are the core of the review.

### Redaction

**Both operators are anonymised, along with their companies, handles, locations and business partners.** They are referred to throughout as **Operator A** and **Operator B**.

We have also anonymised every other named individual and agency that came up during research, for consistency rather than because we were asked to. **Vendors, products, tools and platforms are not redacted** — you need those to do the work.

**One of the two asked us in writing not to share his stack.** We consider a redacted technical brief for internal review to be within that, but it is why the redaction is thorough rather than cosmetic. **Please do not forward this file.**

### A note on the source quality

A very large share of public material on this topic is search-optimised content published by anti-detect browser vendors, proxy sellers, cloud-phone services and account marketplaces. It is commercially motivated to assert both that detection is sophisticated and that their product defeats it.

**Several of its most-repeated technical claims are demonstrably false** — see §9.4. Where a vendor claim contradicts operating-system documentation in this brief, we have gone with the documentation.

---

## 2. The two systems at a glance

| Dimension | **Operator A** | **Operator B** |
|---|---|---|
| **Platform** | Snapchat only | Instagram, TikTok, X — **not Snapchat** |
| **Hardware** | **iPhone 6s** — A9, max iOS 15.8.x, physical SIM only | **Never stated.** Lightning-era (so iPhone 14 or older) and iOS 16.3+ inferred from running Instagram |
| **Claimed unit cost** | **$12–14** | Never stated |
| **Fleet** | ~100 deployed/month, 130 spare | *"a couple hundred phones"* |
| **Control** | Predominantly manual; has *some* automation, scope unstated | OTG chip presenting as USB mouse + keyboard; browser dashboard; screenshots over WebSocket at 20–30fps |
| **Control software** | Unspecified. B's guess: Apple's native automation via developer accounts | **iMouse** (some3c / phones.farm) — named directly |
| **Automation capability** | Hard-coded taps at fixed coordinates, per B's read | OCR of full screens, template matching, colour matching, vision |
| **Connectivity** | **One proxy per device**, via the Shadowrocket iOS app | **US Mobile unlimited data**, one line per device, **no proxies** |
| **Staffing** | Two family members; casual labour paid per batch | **Zero VAs**, one in-office employee |
| **Account posture** | Disposable, 14–20 days, batch replacement | Durable; argues against burn methods |
| **Content pipeline** | 5 SFW photos per phone, loaded by hand | Cloud storage → queued → imported to device camera roll at post time |
| **Time operating** | ~4 months | ~2 years |
| **Tested on Snapchat at scale** | **Yes — it is his entire business** | **No** |

### The structural fact that governs everything

**Operator B had not run Snapchat at scale when we spoke to him.**

> **Operator B:** *"I will make some new snapchats and a warmup script for scrolling snapchat's reels page"*

> **Operator B:** *"Going to suicide a snapchat account actually to test exactly this"*

His entire stated Snapchat experience was one account. **Everything he told us about Snapchat detection is extrapolation from Instagram and TikTok.** He never claimed otherwise — but it means his confidence on Snapchat should not be weighted the same as his confidence on Instagram.

---

## 3. Operator A — the disposable Snapchat system

### 3.1 The model

Disposable Snapchat accounts on cheap physical iPhones, aged 24 hours, seeded from a scraped list of active users, then used to post a story carrying a unique tracking link. Accounts are expected to die in ~14 days. The system survives on **volume and batch replacement, not account longevity.**

> **Operator A:** *"I like to call it mass traffic since I do it in batches."*

### 3.2 Device and network layer

- iPhone 6s, claimed **$12–14** per unit from a US refurbisher
- **One proxy per device**, routed through an on-device proxy client app
- A dedicated modern iPhone running 24/7 generating email aliases
- Large USB hub chassis

> **Operator A:** *"So I don't, I don't have any like IP leaks, like every device is isolated."*

> **Operator A:** *"back then, I was posting like, every single phone I used was on my same IP address. And obviously like, very stupid thing to do."*

> **Operator A:** *"The only like hard thing about it is like literally like getting the package, sorting through all of them, marking what phones are what proxy. But I mean, that takes me like a day."*

### 3.3 Account creation sequence

1. Pull a device, pull a fresh generated email alias
2. Create the account, enable a public profile
3. Upload **a minimum of 5 SFW photos** to the profile
4. Add users from a scraped list (~7,000 usernames **scraped from TikTok**, filtered to accounts active in the past month)
5. Throttle adds **by feel**, based on perceived account health
6. **Age the account 24 hours**
7. Day 2: post a story on every device — different photo, different link per phone

> **Operator A:** *"The way Snapchat works is if you don't add people that are active and will add you back, your account is going to go to nothing."*

> **Operator A:** *"if you add so many people on Snapchat, you're going to get banned right away. So I add people based on the account's health. It's really hard to teach, but it's doable. You just learn it over time."*

> **Operator A:** *"I get all the phones done in one day. Then I come back and I just post story on every phone, different photo, different link. And then traffic just starts coming in. I don't know how it works, but it's crazy."*

**The content requirement, verbatim from his own message:**

> *"i like each public profile on snap to have atleast 5 photos, if we run 300 phones for the start thats 1500 photos… do you have enough sfw content?… just 5 photos per phone"*

**This is an architectural constraint, not a content note.** Content demand scales linearly at 5 × device count. At 300 phones that is 1,500 SFW images **before launch**. It is the only input in the system that does not scale by ordering more hardware.

### 3.3a The seed list — where it came from, and it matters for the pipeline

He described a working list of **roughly 7,000 usernames scraped from TikTok**, filtered to men active within the past month, and identified that active-in-the-past-month filter as the single most important variable in the whole method.

> **Operator A:** *"I have a list of like, I think we're close to 7000 usernames right now. That we scrape that we scrape from TikTok. And it's all these guys were active in the past month, which is really important."*

**What is confirmed as replicable:** publishing a Snapchat handle in a TikTok bio is a mainstream convention; commercial TikTok bio scrapers are a mature category returning handle, bio, follower count and last-post date; filtering by recency is trivial. **No tool markets itself as a TikTok-to-Snapchat username extractor — the pipeline is a generic scraper plus a filtering step written in-house.**

**What is NOT resolved is what he was actually scraping.** Three readings fit the transcript and they describe materially different systems:

| Reading | Implication for a build |
|---|---|
| **(a)** TikTok **bios** containing a published Snapchat handle | Straightforward, but 7,000 qualifying bios is a very large scrape |
| **(b)** TikTok **comment sections** on "add my snap" content | Higher yield, lower quality |
| **(c)** TikTok **usernames tried directly on Snapchat**, assuming handle reuse | **Explains a 7,000-name list far more easily than (a).** Should not be dismissed |

**Reading (c) is the cheapest explanation for the list size.** Nothing in the transcript settles it. **If we replicate this, the reading we pick determines what we build.**

**A cheaper alternative worth testing first.** The commonly documented approach in this space does not depend on a large list at all — seed 10–20 adds from any username source, and the platform's own friend-suggestion engine begins compounding from mutual friends, synced contacts and behavioural similarity. **If that works, a large scraped list is manual work the platform would do for us.** It is also far cheaper to test than to build the scraping pipeline.

**Compliance note:** TikTok's terms appear to prohibit automated extraction of data from the service. This is recorded because the source describes it, not because it is approved.

### 3.4 Ban cycle

> **Operator A:** *"Each account last like — some go up to 20, some go 14. So usually every 14 days. I have new phones already. By the time it hits the 14th, they just automatically deploy them."*

> **Operator A:** *"that's why I call it like mass traffic, because if you ban, it's not going to hurt me. And the reason that is because I don't get banned. I have 100 others."*

**A known gap in his own execution:** he had never run a full consistent month. The pattern was ~100 phones at month start, a small top-up or nothing mid-month, then traffic flatlining until the next month. He agreed that launching the next batch two days early would remove the trough, and had not implemented it.

### 3.5 Claimed results

| Claim | Figure |
|---|---|
| 4-day test, **8 phones**, no backend, one chatter | ~14,000 page visitors, ~$5,000 revenue |
| Last month before the call, ~100 phones, only ~half the month live | ~$35,000 |
| Time operating | ~4 months, from 20 phones |

**All self-reported. None independently verified.** A promised live showcase of his dashboard and physical setup never materialised in our records.

---

## 4. Operator B — the automated durable system

### 4.1 Architecture, in his words

> **Operator B:** *"OTG chip plugged in via lightning cable to mimic pointer device and keyboard is plugged into iphone while simultaneously charging it. Essentially, chip mimics mouse and keyboard, and software sends commands to the phones that execute actions based off said commands. Clicks, swipes, taps, etc. Architecture is as follows: iphone>otg chip>chassis>USB B to USB A into the computer"*

> **Operator B:** *"Architecture for sending automation commands to devices / Browser > Relay server > WSS > PC Node agent > Phone control software > Device"*

> **Operator B:** *"Doesn't use usbmuxd or ffmpeg… The control software essentially captures screenshots of the device rapidly and sends them over websocket… so you control via browser at 20-30 fps but it's perfectly viable for VA use."*

> **Operator B:** *"Control software is the developmental efforts of a third party. Any and all automations, i've personally developed myself."*

> **Operator B:** *"Mine can OCR entire screens, look for specific text elements, and execute actions based off of it. Does the same with templates or colors even. Can program to click certain colors when they appear, certain UI text elements, specific UI icons, etc… Because it can send a screenshot of the device state through this softwares api… to then be processed by the scripts… making things a lot more dynamic"*

### 4.2 Connectivity and staffing

> **Operator B:** *"All traffic is routed through unlimited data plans from a service provider. This is my personal preference, although a proxy setup is perfectly feasible. I just prefer less mess and more simplicity"*

> **Operator B:** *"I use USmobile. Easiest to get bulk sim allocation and $25 a month unlimited plans"*

> **Operator B:** *"As for automations and VA's, we have no VA's… Everything is automated. I have one in-office employee that utilizes my dashboard to do tasks like uploading media to device media queues, setting desired account info like bios pfp etc, but even managing hundreds of accounts, his workload is entirely normal"*

> **Operator B:** *"my system currently stores content in the cloud and queues it up, and at the time of posting, imports it to the device camera roll. keeps things organized"*

### 4.3 What we verified about his stack

**The named control system checks out in detail — SOLID.** It is a publicly sold product and its published specification matches his description closely:

| Element | Published specification |
|---|---|
| Control chip | OTG board presenting as mouse + keyboard, ~**$38** single-unit retail, **one per phone** |
| Software | ~**$0.75 per phone per month** after a 2-month trial |
| Requirements | **No jailbreak, no signing, no developer mode, no app install** |
| Supported | iPhone 6s+, iOS 13.4+ |
| Interfaces | **HTTP and WebSocket APIs**, Python bindings |
| Vision | Find-image, find-colour, **OCR** |
| Host OS | **Windows only** |
| Chassis | 20-port, ~$88–168, with a 200W PSU and three fans |

**Content push is also a documented capability** — the vendor API exposes an album-upload endpoint that operates **through Apple's Shortcuts app**, with a shortcut installed and bound per device. So his cloud→queue→camera-roll description is real, not a claim.

**One thing the vendor documentation adds that he did not mention, and it matters:** the setup appears to require the phone and control PC on **the same network segment**, with the phone mirroring its screen to the controller. See §8.2.

---

## 5. Where the two systems genuinely differ

Beyond the table in §2, these are the differences that would change an architecture.

| # | Difference | Why it matters to a build |
|---|---|---|
| 1 | **Proxy-per-device vs SIM-per-device** | Completely different network architecture, cost model and failure mode. ~3–8× cost difference per device |
| 2 | **Fixed-coordinate scripting vs vision-driven scripting** | Determines whether a platform UI change breaks the whole fleet or degrades gracefully |
| 3 | **Manual/semi-manual vs fully automated** | Determines headcount, and whether the system scales with people or with servers |
| 4 | **Disposable vs durable accounts** | Determines whether the pipeline optimises for *provisioning throughput* or *account survival* |
| 5 | **Hand-loaded content vs cloud content queue** | The single biggest labour difference at scale |
| 6 | **Windows-only control stack vs unstated** | Host OS choice is downstream of this |
| 7 | **iPhone 6s vs unstated newer hardware** | Determines which platforms are reachable at all — see §7.2 |
| 8 | **US-only geo vs multi-platform brand work** | Different content and different audience assumptions |

### The convergence worth more than any single opinion

**Both operators, independently and from opposite directions, concluded that funnelling to a durable account beats burning accounts.**

> **Operator B:** *"I think his suicide method is even janky too. If you just funnel to a different platform like IG off of all these snapchats, you grow and keep one asset. This reminds me a lot of a twitter suicide method I did. Problem was when the accounts got banned, revenue slows down until you replace them"*

> **Operator A:** *"a lot of girls on click. And they have like 30,000, 20,000 followers… the most I get up to is like 10K. Then I get banned. But those girls, they post like they post the IG link straight to their IG. So, I mean, I'm sure that would definitely help with lasting longer."*

Operator B tried a burn method on another platform and moved away from it. Operator A observed the pattern in the wild and never tested it. **They have never discussed this with each other.**

**And the constraint neither noticed:** if Operator A's fleet is iPhone 6s, **he cannot build that funnel** — the destination accounts would need hardware his fleet does not have. He identified the best available improvement to his own system and his hardware locks him out of it.

---

## 6. Where they contradict each other directly

| Question | Operator A | Operator B | What the evidence suggests |
|---|---|---|---|
| Does a factory reset let you reuse a banned phone? | No | **Yes** — *"He's totally wasting those devices"* | **A appears right for Snapchat. See §7.1** |
| Are $12–14 iPhones credible? | Yes | **No** — *"12 bucks a pop??? How is that possible"* | **B's scepticism was reasonable; A is credible only because the model is a 6s. See §7.3** |
| What does Snapchat fingerprint? | *"it's all fingerprinting"* | *"wifi networks near your device and bluetooth devices in range"* | **B appears wrong on the WiFi half. See §9.1** |
| Proxies or mobile data? | Proxies | Data — *"less mess and more simplicity"* | **B appears right on cost. But see §8.2** |

---

## 7. What we believe is SOLID

These are the findings we would build against. **If you can break any of them, that is the most valuable thing you can do with this document.**

### 7.1 An iOS device ban appears to be permanent, per physical handset

Snapchat's own support documentation states a device ban blocks *"the phone or tablet you're using, not just one account"*, and that in most cases *"we don't unban a device, even if you just bought the phone or it's a refurbished/used device."*

Apple's own developer material on its per-device flag framework states the state *"persists across app reinstallation, device transfer between users, and even 'Erase all contents and settings.'"*

**And there is a documented real-world case** of an iOS developer receiving an **AppleCare replacement iPhone** that was already banned — inheriting a stranger's ban on hardware he had never used. Apple would not lift it; the platform said it could not.

**Consequence: on iOS, a burned device is a write-off, not stock.**

### 7.2 Snapchat publishes an error code for too many accounts per device

Their error-code documentation includes a device ban specifically for **"too many accounts have been associated with the device."**

**This is not a probabilistic risk score. It is a named error code for a counted threshold.** Any architecture that stacks accounts on one handset is running at a documented tripwire.

The same documentation includes a separate code for a device failing **integrity requirements**.

### 7.3 The cheap iPhones are cheap because they are at the end of the line

| Model | Max iOS | Runs Instagram (needs 16.3)? | Approx. used price |
|---|---|---|---|
| iPhone 6s / 7 | 15.8.x | **No** | $36–60 |
| iPhone 8 / X | 16.7.x | Barely | $62–99 |
| iPhone SE 2020 / 11 | Current | Yes | $62–137 |
| Budget Android, current gen | Supported to ~2030–31 | Yes | $80–100 |

**Snapchat's App Store listing requires iOS 15.0, while their own support page still says iOS 14.** The floor already drifted upward with no announcement.

**Consequence: an iPhone 6s fleet is Snapchat-only, permanently, and one platform version bump from scrap.** At that point the units are worth their trade-in value, not their sale price.

### 7.4 Content push is genuinely harder on iOS than Android

**The iOS photo library is a database, not a folder, and there is no media scanner.** Copying a file into the device's media directory over USB does not create a photo asset — this is reported repeatedly and consistently. Every working method needs code running on the device: either a helper app, or the Shortcuts route the named control software uses.

**Android equivalent:** `adb push` to the media directory plus one media-scan call. Free, scriptable, wireless, parallel.

### 7.5 Android has no equivalent of the iOS per-device flag — today

| Identifier | Readable by an ordinary app? | Survives factory reset? |
|---|---|---|
| Android ID / SSAID | Yes, scoped per app-signing-key + user + device | **No** |
| IMEI / serial | **No** — privileged permission only since Android 10 | N/A |
| MAC address | **No** — system apps only, randomised by default | N/A |
| Hardware key attestation | Yes | **Does not yield a device-unique ID to an ordinary app** |

The unique-identifier field in Android's attestation is documented as available to *system* apps; ID attestation needs device-owner privileges; and under remote key provisioning each app gets a different attestation key, rotated regularly, with backends segmented so keys cannot be correlated to a device.

**Consequence: a burned Android appears recoverable — wipe plus disabling backup restore. A burned iPhone does not.**

**Caveat, and it is a real one — see §8.1.**

### 7.6 Google is building the Android equivalent, and it is in beta

An integrity API feature stores **three developer-defined bits on Google's servers, keyed to the device**, surviving reinstall *and* factory reset, and is explicitly pitched at repeat abuse and ban evasion.

**If Snapchat adopts it, §7.5 inverts and the Android recovery advantage disappears.** No published adopter list. **This is a quarterly watch item, not a solved question.**

### 7.7 Rooting or modifying Android is out for Snapchat

Independent reverse-engineering of Snapchat's Android native library documents checks, on every auth-token generation, for root binaries, superuser artefacts, emulator fingerprints, package-signature and code integrity, and runtime method hooking.

**Consequence: stock, unrooted Android only.** Third-party app cloners are the exact technique that library targets. Hardened custom ROMs cap permanently at the lowest integrity tier and have broken Snapchat login repeatedly.

**Snapchat also runs anti-tamper checks on iOS**, so jailbreaking is equally disqualifying there.

### 7.8 Apple's account and signing limits bite at scale

- **Ten devices per Apple Account** for purchases at one time
- **Up to 90 days** before a device can be reassociated with a different Apple Account
- **100 devices per product family per membership year** on the $99 developer program, and disabling a device does not free the slot
- Free provisioning profiles expire in **7 days** and cap at a handful of devices

**Consequence: a 100-phone fleet needs at least 10 Apple Accounts just for app installs, and a burned device may be idle capital for a quarter.** The named control software sidesteps the signing cap entirely by needing no signing at all — which is its main architectural advantage.

### 7.9 What actually links accounts, in order

1. **Behavioural pattern** — posting hours, phrasing, cadence. Device-independent, survives everything. Peer-reviewed analysis of coordination detection found **synchronised posting timing** and **reused media** are working detectors, while transcript similarity is not.
2. **Reused credentials** — email, phone number. Entirely within our control.
3. **Account graph** — published research from one major platform describes a deployed classifier keying primarily on features aggregated from an account's **neighbours**, not the account itself.
4. **Device flags** — persistent where implemented, but coarse.
5. **IP address** — weak. Mobile data means carrier-grade NAT.

**Consequence for architecture: the top two are software and scheduling problems, not hardware problems.** A farm that runs identical schedules and reuses assets defeats its own hardware isolation.

---

## 8. What is IN THE AIR

Unresolved. Some of these are cheap to test and we would value your view on how.

### 8.1 Does Android have a reset-surviving identifier after all?

Two of our research streams disagreed on the DRM/Widevine device ID. One presented it as documented, permissionless and reset-surviving. The other, which did deeper primary-source work, **could not confirm its current scoping from Google's documentation in either direction.**

**This is the single open technical question that could reverse §7.5.** If you know the answer or can determine it, that is high value.

### 8.2 Does per-phone traffic actually egress via the SIM?

The named control software appears to require the phone and control PC on the same network segment for screen mirroring, and **iOS generally prefers WiFi when associated.**

**If app traffic leaves over the shared control network rather than each phone's SIM, every device on the rack shares one public address and the entire isolation premise collapses.**

We think this is testable with two phones and a public-IP check. **Do you agree, and is there a better test?**

### 8.3 Does hardware pointer control leave a readable signature?

The control approach drives each phone as a **USB mouse**. Apple documentation reportedly states that from iOS 17 the system defaults to delivering pointer-driven taps to apps as a distinct touch type, where earlier versions defaulted to delivering them as ordinary direct touches.

If accurate:

| Device OS | Pointer control readable by the app? |
|---|---|
| iOS 16 and earlier — iPhone 8 / X | **No** — arrives looking like a finger |
| iOS 17 and later — iPhone XR and newer | **Yes** — one line of code to check |

**No real iPhone produces pointer-type touches in normal use.** That would make it close to a binary tell rather than a probabilistic signal — with a near-zero false-positive rate and near-zero implementation cost for a platform.

**Two important caveats.** First, **we could not independently re-confirm the exact documentation wording** — one fetch succeeded, a second returned an empty page. **Please verify this in Xcode's documentation viewer; it is the single most decision-relevant unverified item in this brief.** Second, no evidence was found either way that any platform actually reads it.

**A possible third path we have not seen anyone use:** the signature would be a function of the **iOS version, not the model**. A settings-level erase appears to wipe data without reinstalling the OS, so newer models already sitting on iOS 16.x could in principle be frozen there — Instagram compatibility, no pointer signature, hardware not at end of life. Catches: you cannot order a specific model on a specific old version, auto-update must be killed before first network contact, and one accidental full restore burns that device permanently. **We would like your view on whether this is sane or fragile.**

### 8.4 Other open items

- **Realistic data consumption per phone per month.** At per-GB proxy pricing this single number decides whether a proxy model is viable at all.
- **What the semi-manual operator's automation actually covers**, and on what tooling.
- **Whether the platforms treat gallery-imported media differently from camera-captured media.** A real question for a farm; no evidence found.
- **Whether file metadata mismatch is used as a signal.** Nothing found in either direction. Absence of camera metadata appears statistically normal anyway.
- **Bulk pricing on the control hardware.** Our figures are single-unit retail from a page marked sold out.

---

## 9. What we think the operators got wrong

### 9.1 "Snapchat fingerprints nearby WiFi networks and Bluetooth devices"

**Appears CONTRADICTED for the WiFi half.** iOS does not appear to expose WiFi scanning to third-party apps at all — the entitlement is reserved, and apps appear able to read only the currently joined network, and only with location permission.

Bluetooth is different: an app with granted permission can scan, and iPhones with Bluetooth on do advertise. So rack co-location detection is theoretically possible — but unevidenced, and defeated by denying the permission.

**Our read: this looks like Android knowledge applied to iOS.**

### 9.2 "A factory reset lets you reuse the device"

**Appears CONTRADICTED for Snapchat.** See §7.1. Probably true for the platforms he actually runs.

### 9.3 "Each person is only allowed to own 10 Instagram accounts"

**Appears CONTRADICTED.** The documented limit is **five simultaneous logins per device**. No ownership cap was found in the platform's terms.

The sharper real rule: the platform's account-integrity standard allows restricting accounts *"Owned by the same person or entity as an account that has been disabled"* — **linkage alone is a trigger, with no requirement that the new account misbehave.**

### 9.4 "Device bans target IMEI, MAC address and hardware fingerprint"

This is the vendor-blog explanation, and it appears **technically impossible** for an ordinary app on Android 10+ or on any modern iOS. See §7.5.

**These vendors sell the remedy and reach a roughly correct conclusion via a demonstrably wrong mechanism.** Useful filter: a source that gets the mechanism wrong is probably not reliable on anything else here.

### 9.5 "I'm following TOS"

Snapchat's published policies appear to prohibit the **offer** of paid sexual subscription services regardless of what is posted, to prohibit the sale of accounts, and to prohibit automation and post-ban account creation.

**Consequence: the 14-day account lifespan is not friction or bad luck. It appears to be enforcement working slowly against something prohibited outright — and the destination of the link is the violation, not the behaviour on the device.** No amount of engineering changes that.

---

## 10. Economics

**Health warning: device, control and connectivity prices are sourced. Residuals, replacement rates, labour ratios and power are modelled, not observed.** Rank ordering is robust; exact deltas are not.

### 10.1 Modelled cost, 200 devices

| Horizon | **Android** | **iOS** | Delta |
|---|---|---|---|
| 18-month net, after residual | ~$16,000 | ~$26,300 | +64% |
| **36-month net** | **~$20,500** | **~$36,900** | **+80%** |
| Cost per account, 1/device | ~$80 | ~$131 | — |

**The gap is driven almost entirely by control hardware.** Android control is free and open (ADB); iOS requires a per-phone chip plus a per-phone monthly fee. The root cause is Apple's signing model — see §7.8.

### 10.2 The resale argument, tested and failed

One operator has a family member who resells the handsets once exhausted, and iPhones hold value far better than budget Androids. We modelled it: over 18 months at 200 devices, iPhone recovers roughly **$9,000** against Android's **$3,000** — a real threefold advantage in dollars.

**It is then entirely consumed by the ~$10,400 of control chips and subscriptions the iPhones require.** Per device: ~$30 more recovered, ~$52 more spent on control.

**Depreciation curves are also the wrong data** — they measure loss from launch price, and a farm buys at the flat bottom of the curve where the platform premium has largely disappeared.

### 10.3 The number that should decide it

A 200-device iOS farm costs roughly **$10,700/month** in year one including amortised capital at mid labour.

At the median cost-per-thousand for one platform's awareness ad inventory, that same money buys roughly **1.8 million targeted impressions a month.**

**For the farm to match that on raw reach, each device must sustain roughly 300 real impressions every single day, forever, with no ban losses.**

**No published independent dataset on sustained per-device yield exists.** Every yield figure we found came from someone selling farm hardware, farm software, or the service.

**And bought views are available at a small fraction of a cent** — the same budget buys on the order of a hundred times more views than a farm produces.

**So the only rational reason to build one is to produce what cannot be bought: distinct accounts posting real content that the recommendation system chooses to show real humans. That is a creative bet, not an infrastructure bet — and the infrastructure is the cheap part.**

**Agency benchmark for comparison:** roughly **$300 per account per month** to buy this as a service, against ~$52 for an in-house iOS device or ~$80 per Android account.

### 10.4 Labour — the number nobody publishes honestly

Vendor figures contradict each other by roughly fivefold. **No independent published ratio was found.**

Cross-checking the operators: one claims a 130-device batch takes a day solo — but has minimal automation and failed at delegation. The other claims one employee for hundreds of accounts — but with a full automation stack he built himself over two years.

**Neither ratio transfers without the corresponding stack.**

**And build labour appears in nobody's model** — plausibly 400–800 hours at 200 devices.

---

## 10a. Chassis — an open hardware decision we need help with

**We expect to build two, for different platforms and different devices.** One iOS-capable, one Android. They may not be the same product, and the requirements genuinely differ.

### What we found on the market

| Product family | Approx. price | Ports | iOS-capable? | Notes |
|---|---|---|---|---|
| some3c / phones.farm — standard chassis | **~$88–168** | 20 | Via the control chip only | **Careful: several of their cheap chassis are designed for bare motherboards, not intact handsets.** Different build entirely — see below |
| some3c — 2U rackmount | ~$149 | 20 | Same | ~$7.43/slot |
| some3c — acrylic RGB charging hub | ~$105 | 20 | Charging only | ~$5.25/slot |
| phones.farm — rackmount box | ~$135–239 | 20 | **Listed as Android-only** in the material we found | Verify before buying |
| Cellhasher — Classic / Reverse / Rackmount | $159 / $179 / $239 | 20 | Not stated | Needs checking |
| MaxPhonesFarm — **iPhone Device Lab Array** | **~$1,280** | 20 | **Yes — the only explicitly iOS SKU we found** | ~$64/slot. Expensive but purpose-built |
| MaxPhonesFarm — Android boxes | $159–1,899 | 20 | No | Their Android kit is cheaper per slot than their iOS one |
| Cambrionix — managed charge/sync (PowerPad15S) | **~$500–532** | 15 | Yes | **Different category — see below** |

**Finding: chassis is not where the iOS/Android cost difference lives.** Per-slot prices are broadly comparable. In at least one vendor's range the iPhone array is actually *cheaper* per slot than their Android boxes. **The real iOS premium is the per-device control chip and its subscription, not the enclosure.**

### The distinction that matters most

**Bare-motherboard chassis versus intact-handset chassis are different builds with different consequences.**

Several of the cheapest enclosures are designed to hold **stripped logic boards**, not whole phones. That is a real technique in this space and it is much denser and cheaper per slot. But:

- **A bare board has near-zero residual value.** If any part of the plan relies on reselling exhausted hardware — and one of the two operators does exactly that — stripping the phones deletes that entirely.
- Camera, SIM tray and sensor availability differ.
- **At least one packaged offering we found ships devices that have no cameras, cannot use SIMs, and cannot be wiped.** Unusable for authentic accounts. **Verify what is actually inside any bundle before buying.**

### Two different requirements, and they pull apart

| | **Option 1 — disposable farm** | **Option 2 — durable set** |
|---|---|---|
| Priority | Density and cost per slot | **Charge control and per-port visibility** |
| Devices live | ~14 days | Years |
| Battery management | Barely matters | **Critical** |
| Suitable | Cheap 20-port chassis | Managed hub with per-port power limits and target charge level |

**For Option 2 the managed-hub category is worth the premium**, because it holds a target charge level on *any* iPhone model regardless of age, does not periodically override itself to 100% the way the on-device setting does, and gives per-port draw and voltage — which is how you catch a swelling cell before it becomes a fire. Two operator reports we found describe a host cutting USB power entirely after ~36 hours from excessive draw on an unmanaged hub, and devices silently disappearing from the host after 30–60 minutes while still charging normally.

### What we need from you on this

1. **Which chassis for the iOS side**, given we already hold at least one 20-device enclosure — **check with Dim what we have before specifying anything new.**
2. **Whether intact handsets or bare boards** is the right call for each build.
3. **Whether the Android chassis and the iOS chassis need to be different products at all**, or whether one enclosure serves both with different cabling.
4. **Whether managed charge control is worth it at Option 2 scale**, or only above some device count.

---

## 10b. Control and mirroring software — we already have something that works

**Do not start from scratch here, and do not start from this document.**

**Dim has tested a mirroring/control product and confirmed it works.** It is a Chinese product. **The name is deliberately not in this brief — get it from Dim**, because we would rather you had it from the person who ran it than from our notes.

There is a second candidate: **Operator B named a specific control product he uses**, and its published specification matches his description of his architecture closely. Details are in §4.3. **We may end up using that one instead.**

**Please evaluate both before recommending either.** The questions that matter:

- Which one Dim actually ran, and what he saw
- Whether either requires the phone and host on the same network segment — **this is the unresolved egress question in §8.2 and it may be a property of the software, not of iOS**
- API surface: is it scriptable, and how
- Whether the vision capability (OCR, template matching, colour matching) is present in both or only one
- Host OS requirements — at least one is Windows-only
- Bulk pricing, which none of them publish

---

## 11. What we need from you

Ordered by how much the answer would change what we do.

### Blocking

1. **§8.3 — verify the pointer-touch documentation in Xcode.** Does a pointer-driven tap arrive at an app as a distinguishable touch type, and what is the default per iOS version? This is the most decision-relevant unverified item in the brief.
2. **§8.2 — design the egress test.** With a phone mirroring over WiFi to a control host and an active SIM, does app traffic leave via the SIM or the WiFi? Our proposed test is two phones and a public-IP check. **Is that sufficient, and how would you force SIM egress if it is not?**
3. **§8.1 — is there a reset-surviving device identifier readable by an ordinary Android app in 2026?** Our two research passes disagreed.

### Architecture

4. **Windows-only control stack.** The named product requires Windows. Is there a credible open alternative for iOS at 100+ devices without a Mac and without the 100-device signing cap? Our read is that the open tooling for iOS is thin and the main library that removed the Mac requirement is unmaintained.
5. **Devices per host.** What is a realistic device-per-host number, and where does it break — USB enumeration, power, bandwidth, or CPU?
6. **Fleet state management.** We will need to track, per device: identity, network assignment, account state, content queue, ban status, and lifecycle. **What would you build that in?**
7. **The freeze-the-iOS-version idea in §8.3.** Sane, or fragile?
8. **Content pipeline.** Cloud storage → per-device queue → on-device media library. On iOS this appears to require Shortcuts or a helper app. **Is there a better route?**

### Judgement

9. **Would you build Option 1 at all?** Our concern is that a system requiring full fleet replacement every 14 days may exceed what we can operate today. **We would rather hear that plainly than build it and find out.**
10. **What have we got wrong?** Sections 7 and 9 are the ones to attack.

---

## 11a. Our own live test — the only first-party data in this document

**Everything else in this brief is either self-reported by an operator or gathered from public research. This section is ours, measured, on our own hardware.**

### Setup

| | |
|---|---|
| Devices | **One.** A single phone |
| Network | **Mobile data. No proxy** |
| Account age | A few months old, created out of curiosity and **barely used until recently** |
| Content | **All SFW** |
| Refinement | **None.** No call-to-action work, no optimisation, no strategy |

### What happened

Growth was slow for the first few days. Then the **fifth public profile story** went up, and the account moved overnight:

| Point | Free page subscribers | Link clicks |
|---|---|---|
| Before | **~3–4**, stuck | — |
| Overnight after the 5th post | **19** | **147** |
| 25 Aug 2026, 11:56 PM CDT | 19 | 147 |
| Following measurement | **29** | **182** |

**+10 subscribers and +35 clicks** in the period after that timestamp, on one unoptimised device.

### Why this is in a technical brief

**Three reasons, and the third is the interesting one.**

1. **It establishes that Snapchat has real value at n=1**, without a farm, without proxies, without automation, on an account nobody had worked on. The numbers are small — but they are *ours*, and every other number in this document is someone else's claim.
2. **It is a datapoint on the proxy question.** This ran on plain mobile data with no proxy and did not get actioned. One account is not evidence about fleet behaviour, but it is consistent with Operator B's position in §6 rather than Operator A's.
3. **The five-post threshold.** Operator A independently specifies **"at least 5 photos"** on every public profile before deploying — a number he gave as a rule without explaining where it came from. **Our account jumped after its 5th public profile post.**

> **This is not being read as a coincidence, and the reason is the convergence rather than the jump on its own.**
>
> Operator A specified **five** as a rule, unprompted, without explaining where the number came from — he presented it as something he had learned, not reasoned. Our account then sat flat and moved on its **fifth** public profile post. **Two independent sources landing on the same number is materially more than one observation.**

**What that supports and what it does not.** It supports the existence of *some* threshold effect around profile content volume — an eligibility, discoverability or ranking gate. **It does not establish what the mechanism is, whether five is the exact number, or whether it is a hard gate or a gradient.** It remains one account, and timing or account aging cannot be fully excluded.

**Cheap to test properly:** three or four accounts held deliberately at different post counts — three, five, seven — and watch where the movement starts. That would turn a strong hypothesis into a number we own.

### Why this matters beyond the threshold question

**The account is also churning subscribers and clicks continuously**, not just at the moment of the jump. That is a second, separate signal, and it is the one that speaks to the method as a whole rather than to a single variable.

**It gives Operator A's account of his own system real credibility.** Everything he told us was self-reported and unverified — and the reasonable default was to discount it. **Our own device, unoptimised, on one account, is producing traffic in the same shape he described.** That does not verify his volume claims. It does mean **the underlying mechanism he is describing appears to be real**, and it moves his testimony from "unverified claim" toward "unverified claim consistent with our own observation."

**One framing note:** these are not the kind of numbers a technical review would normally look at, and they are not a performance benchmark. **They are here because they are the only measured evidence we hold**, and because the five-post observation is a testable technical hypothesis rather than a marketing one.

---

## 12. Appendix — vendors, tools and products named in research

**Not redacted.** These are commercial products, and you need them.

| Category | Named |
|---|---|
| iOS control hardware/software | iMouse (some3c / phones.farm) |
| Farm chassis | some3c, phones.farm, Cellhasher, MaxPhonesFarm |
| iOS tooling | Appium, WebDriverAgent, XCUITest, Apple Configurator 2, pymobiledevice3, libimobiledevice, iMazing, 3uTools, iFunbox |
| Dead/unmaintained | tidevice (never supported iOS 17), XXTouchNG (archived 2022) |
| Android tooling | ADB, scrcpy, DeviceFarmer/STF (**Android only, no iOS support**) |
| Connectivity | US Mobile, IPRoyal, Oxylabs, SOAX, DataImpulse, Proxidize |
| On-device proxy client | Shadowrocket |
| Cloud phones (Android only) | GeeLark, VMOS, MoreLogin, Redfinger, DuoPlus |
| iOS cloud (all unusable for this) | Corellium, AWS Device Farm, BrowserStack |
| Link tooling | Linktree, Bouncy.ai |
| Schedulers | Metricool, OneUp, Buffer |
| Antidetect browsers | Multilogin, GoLogin |

---

## 13. Related internal files

- `/Marketing/Phone Farm/Research/` — the full unredacted research set, 11 files
- `/Marketing/Phone Farm/XYZ_MGMT_iOS_Reset_Protocol.md` — our existing position on what a factory reset clears
- `Concept — Long-Term Organic Device Set.md` — Option 2, in this folder

---

*XYZ MGMT — Confidential & For Internal Use Only*
