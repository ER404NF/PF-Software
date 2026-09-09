# Phone Farm Method & Architecture — [REDACTED]

**XYZ MGMT · INTERNAL · COMPETITOR RESEARCH**

**Source:** [REDACTED] · **Extracted from:** *Instagram Marketing Guide 2026 — Full Breakdown (14 Jul 2026).md* (same folder)
**Captured:** 30 August 2026 · **Scope:** every detail he shares about physical device infrastructure — devices, connectivity, account creation, account types and scaling. **Nothing omitted. Personal names redacted.**

> **Read this before using any of it.** This is a record of what a third-party operator said publicly — it is **not** XYZ policy and it is not a plan. Nearly everything below — **jailbreaking, device spoofers, mass account creation, and the proxy/SIM rotation used to evade IP flags** — breaches Instagram's Terms of Service. Per CLAUDE.md §2, nothing here gets actioned without checking the platform's own rules first. Filed as competitor and method research.

---

## Contents

**Part 1 — Context**
1. Why he built the operation this way

**Part 2 — The devices**
2. Devices — the full comparison

**Part 3 — Connectivity**
3. Proxies, VPNs and SIM cards

**Part 4 — Producing accounts**
4. Account-creation architecture
5. Account types — new versus aged
6. Scaling and operations

---

# SECTION 1 — Why he built the operation this way

Instagram had been "insanely difficult" for agencies over the previous three months — **ban waves and hacking** — hitting revenue. Separately, they started focusing on Instagram **last August**, because a considerable portion of Verified Earners signups was coming from Instagram; he spoke with the team and made it a main marketing funnel. Google Pixels were already on hand from their Reddit operation, which is part of why GrapheneOS became a device of choice.

The infrastructure covered here is the first of the guide's four sections (the others being algorithm/going-viral, brand/niche, and the AI content pipeline — the last of which has its own extraction document in this folder).

---

# SECTION 2 — Devices — the full comparison

## 2.1 iOS jailbreak

Opened with deliberately, "to ruffle a bit of feathers" — a lot of people dislike it; he has had **tremendous success** with it.

**What it is:** a standard iPhone lets you make ~5 Instagram accounts. A jailbroken iPhone supports **100–200 containers**, each holding one or more accounts. Same device, same interface, drastically lower cost per account.

> **The degradation curve — the key point.** At 10–20 accounts, success rate is high — three, four, five accounts might get **10K, even 50K views on day one**. As you keep creating (he stresses **a thousand accounts, not 200**), success rate slowly falls, tested with content already proven viral.

- **His retirement rule:** when you do **100 accounts and not one gets over 1,000 views**, the device is fingerprinted by Instagram and there is no coming back.
- Tested across **iPhone 8, iPhone 7, iPhone X** — same pattern each time.
- **What happens to a retired phone:** they switch it to a full Reddit operation. They have automations for iOS jailbreak and Android covering both Instagram and Reddit, so the device isn't wasted.

> **Manual operators never hit the wall:** "If you run it manually you will never reach that point" — it takes hundreds of accounts. Manual operators doing 20–30 accounts over a device's life keep a high success rate. Jailbroken phones also suit a VA's second-shift task (Reddit).

| Pros | Cons |
|---|---|
| Cheap; free to set up. Device spoofers available on Telegram (several, all functionally the same). | It has a lifetime. The fingerprint eventually binds to the phone and can no longer be spoofed into good view counts. |

## 2.2 Standard iPhones

They run **iPhone 12, 13 and 14.**

- **iPhone 13 has been the worst** for them — tried resetting, tried using it as a main account. Possibly just a bad batch.
- **Best results: iPhone 12 and iPhone 14.** He explicitly says this is his experience, not a rule to buy on.

**Use case:** branded creators. If you want posting accounts carrying branded content for one model, put them on a standard iPhone. It is the best device to hold *all* apps for one model — Reddit, X, TikTok, Instagram — because of the speed. Even an iPhone 12 is responsive enough to get work done much faster.

| Pros | Cons |
|---|---|
| Perceived device security; interface speed. | Expensive. Remote access needs **clickers** on top. Setting up remote access to match a jailbreak setup costs **triple to quadruple**, and you get far fewer Instagram accounts per phone. Purely a quality-over-quantity device. |

## 2.3 Android

**"One of the best, in my opinion."** The ability to hack an Android and suffer no repercussions is unmatched.

- **On view-count success rate, Android beats iOS**, whether the iOS device is state-of-the-art or the Android is semi-old. "If you post good content on it, you can go mega mega viral."
- Remote access needs only a **USB-C cable.** Device spoofers are extremely easy to add.

> **The one real con: speed.** Automations run much slower than iOS, even with a self-hosted proxy sitting right beside the device.

| Task | Android | iOS jailbreak (iPhone 8) |
|---|---|---|
| Create account + post 3 reels | **~15 minutes** | **6–9 minutes** |

Faster tasks mean more accounts per phone, which means more potential reach. Android app-cloning / device-spoofer apps from Telegram give hundreds of containers, mimicking a jailbreak — but the slowness remains. His verdict: *"The Android versus iOS situation is just completely unnecessary. Android is just as good as iOS. There's just pros and cons to each one."*

## 2.4 Google Pixel + GrapheneOS

**One of his favourites.** Originally used for Reddit, then moved onto Instagram.

> **32 devices, free.** GrapheneOS gives you 32 users on one device — 32 unique devices, completely free.

- Setup takes **30–60 minutes the first time**; about **10–15 minutes per device** once you know it.
- **Shortcut:** don't configure each user individually. From the main user, duplicate the apps across all users you created.
- Result: 32 unique devices on one phone, at no cost.

*Context: they had Pixels already from the Reddit operation, but Reddit can't consume a device's whole day — hence GrapheneOS to fill it with Instagram.*

## 2.5 Cloud phones

Tested for a very short period. Automation, creation and posting are all easy on them.

> **He does not like them:** "I don't like renting phones. I don't like the fact that it's not actually yours." Their experience was that cloud phones simply don't compare to physical devices.

## 2.6 Motherboards

Take a phone, strip the screen, case, camera and everything non-essential; the bare motherboard chip goes into a PC and the phone's screen is mirrored there.

- **20 devices per motherboard** when ordered.
- Remote access and scaling become extremely easy. Device spoofers can run on them.

**Cons:**

- **Resale value is poor.** After three bad months on Instagram, people in Telegram groups are dumping them "for pennies on the dollar." A physical phone stays an asset — intact and uncracked, you recover a decent share of the cost even after years of use.
- **The use case is very narrow.** Automations and posting only. **No TikTok lives, essentially nothing else.**

**iPhone motherboards exist**, but you supply the iPhones yourself; the product is a clicker that mirrors the screen. Options exist for both platforms.

---

# SECTION 3 — Proxies, VPNs and SIM cards

He opens by calling the anti-VPN consensus on Telegram *"the biggest load of [expletive] I've ever heard in my life."*

## 3.1 VPNs

**They work.** Every access point to the internet will work; you will get a viral account if you test enough.

- Providers hold thousands of IPs. **Mullvad is what they use**; NordVPN also named.
- **Device matters more than the VPN.** iOS success rate is much better than Android.
- **A flagged location is provider-specific.** Mullvad's Miami IPs being burnt says nothing about NordVPN's Miami IPs.
- You have access to hundreds or thousands of IPs — a single city may carry several. "You truly have more than you can utilize."
- **Extremely cheap**, which makes it the easiest way to start.
- **iOS is the best device for a VPN. On Android, don't waste your time** — lower trust score, very hard to get accounts live.
- **Standard iPhone + VPN is perfectly acceptable.** Jailbroken + VPN gives more issues.

## 3.2 SIM cards

Operate essentially the same as a mobile proxy.

> **The mechanism:** you sit inside a **triangular cell-tower location**, and every IP in that triangle is available to you. Toggle flight mode on and off and you rotate to a new IP.

- IP pool size varies enormously by location. Sometimes many, sometimes very few.
- Creating accounts by flight-mode cycling: you might get **three or four accounts through cleanly**, then start hitting *"we limit how often you can do these actions"* because you have looped back to the same IP.
- **The same problem shows up on Reddit** — one proxy provider serving one account/device eventually repeats IPs and Reddit rate-limits you.
- **His recommendation:** take it slow. **One or two accounts a day, never over three**, if you are on GrapheneOS or an Android device spoofer. Premium iPhones and basic Androids don't hit this — you can only make five accounts total on those anyway.
- IPs are clean and widely shared, so **less likely to be flagged than a VPN**.

**Cost by country — the deciding factor:**

| Location | Cost |
|---|---|
| **Poland** | **€12 for 30GB/month** |
| USA | ~$60/month |
| Dubai (where he lives now) | €100–150/month |

**The Poland method:** buy a batch from the Play Store. Passport required, *"but they don't really care over in Poland, which is a good thing."* €12 for 30GB, which they wouldn't get through in a full month. **Replace the SIMs rather than topping them up** — the starter pack plus included data was cheaper than a top-up.

**Where to use them:** main accounts, or GrapheneOS.
**Where not to:** massive phone operations — blackout, jailbreak, Android device spoofers. Not enough IPs in the pool; you start failing at the very end of creation, on the terms-and-conditions step.

## 3.3 Mobile proxies

**You can build your own** — websites exist for it, on an Android device or a jailbroken iPhone. Viable if you can get a very cheap mobile SIM plan consistently without provider blocks (most countries require ID).

> **Why self-hosting wins:** the proxy sits right beside the phone, so the connection is fast, and **you know it is actually dedicated.**

**The problem with Telegram providers:** many claim dedicated proxies at premium prices, and it is not always true. Downtime happens. Worse — if a provider is popular in the groups where Instagram is the main funnel, and he has 100 proxies all in one location, **thousands of Instagram accounts may be created in that same IP pool on the same day.** You get wrecked through no fault of your own.

**His advice, verbatim in spirit:** if you find a good provider, *"shut your [expletive] mouth."* Tell nobody. **Why providers go in waves:** good for two months → gets popular → *"goes to complete [expletive]"* → everyone leaves → gets good again. Some never blow up in the OFM/Instagram-Reddit community at all, and those are the ones that keep working. **Good ones run $60–$100 per month.** *"No one is going to be your girlfriend just because you tell them what proxy provider it is."*

## 3.4 Residential proxies

Extremely expensive, but you get access to **millions of IPs.** Billed either by gigabyte or per IP (usually time-based).

> **How to use them:** create on residential, then move the account to a mobile proxy or SIM card in the same location.

- Don't create on a US IP and move to Slovakia. Keep the system roughly in one region.
- **Creation IP and posting IP do not need to match exactly** — Instagram is quite lenient. California → Arizona is fine.
- **The actual problem is constant country-to-country switching.** Common with VPNs: it expires or silently shuts off, the VA logs in and posts, and suddenly the account is posting from Dubai, then somewhere else entirely.

## 3.5 Wi-Fi

Included mainly as a comparison.

- Fine for a complete beginner with one phone. But if you can afford Wi-Fi you can afford a SIM plan — **use the SIM, or hotspot from your personal phone** for a clean IP not tagged to the Wi-Fi.
- **You cannot run a big operation on Wi-Fi.** You will stall at around three accounts inside a 10–20 minute window; you might get blocked on the second.
- Fine for a girl with two or three accounts made on her own iPhone who happens to be on Wi-Fi when posting.
- If one account gets banned, Instagram may tag the Wi-Fi IP and cause issues for the others — **though he says for the most part this is not true.**

---

# SECTION 4 — Account-creation architecture

The phone farm's product is live accounts. These are the inputs and rules that get one created cleanly.

## 4.1 iOS — iCloud Hide My Email

- **iCloud Premium, about $2/month.** Generate alias emails through **Hide My Email.**
- *"Unlimited"* is really **400–700 emails** per iCloud account before a ban — it varies.
- **50 a day for 10 days straight → high chance of a ban.** 10–20 a day over months → you'll get the maximum out of it.
- **iOS only.** These do not work on Android; very few accounts pass.
- Best done on **manual premium iPhones — 12, 13, 14.** Results in views are very good and it is extremely cheap.

## 4.2 Numbers

- Providers such as **TextVerified.**
- **Dedicate numbers to Android.** Numbers and Android work extremely well together.
- **USA: 30–40 cents, sometimes close to 45**, and the success rate may not justify it. Tier-3 countries are much cheaper.
- **Match the number's country to the proxy's country.** A German number against an American proxy *"makes zero sense."*
- Numbers work on iOS too, but since iCloud + Hide My Mail is so cheap, **try that first on iOS.**

## 4.3 Emails

| Provider | Verdict |
|---|---|
| **iCloud** | For iOS |
| **Gmail** | For Android (though numbers are the better Android route) |
| **Outlook / Hotmail** | *"Wouldn't even touch with a 10-foot pole"* — for Android or iOS. Very hard to get through, banned quickly, and **definitely banned if they go viral.** |

## 4.4 The creation IP

> **One of the most important things.** Residential IPs on an automation are somewhat expensive, but once creation is done you swap to a similar IP on a mobile proxy or VPN without many issues. **Creation is what matters most** — the posting IP can be less clean.

**VPN + mass phone operation:** *"you're absolutely cooked."* A VPN against a mass phone operation does not work.

**If you do use a VPN:** create on it, and **stay on that same VPN every time you post** on that account. The next account uses a different VPN. This applies to certain black-hat methods on standard iPhones. If you are simply posting on a standard iPhone with a VPN, keep it the same across all Instagram accounts in that app.

---

# SECTION 5 — Account types — new versus aged

What the farm should actually build. **New accounts win, and he explains why.**

## 5.1 The "new" badge

A new account gets a **"new" sticker under the profile picture**, visible from a phone but **not from desktop.** Instagram wants you to share content and wants people to know the account is new. It actively pushes you.

**The example he uses: [REDACTED]**, an accountant (he believes UK), started his account **late June.** His content style was brand new and *"broke the internet"* — roughly **50–60 million views across five videos.** He still had the new badge when [REDACTED] checked, three or four days before recording.

## 5.2 The comparison

Both a new account and a bought aged account start at zero followers. **The new account gets actively pushed much faster in the algorithm.** So for reels, new wins.

## 5.3 Aged accounts

- Bought on **Axe Market**; can be expensive.
- **He used to preload accounts with Reddit followers** — high percentage USA, a few hundred followers within 24 hours. This was early in his Instagram journey, before he fully understood the algorithm. The theory was those followers would engage and trigger a push.
- **He no longer does it and says it is not needed.** You can start from complete scratch as long as your content targets a US audience.
- The old refactor process was: buy the account, change profile picture and username, make it nice, add banners and pinned carousels, add followers.

> **Why aged accounts underperform on reels:** username changed, profile picture changed, new login IP most likely from a different country, and **different behavioural patterns** — the account may have been created by API or automation, with different reel swipe rates and different button-press patterns. Instagram detects this. Buying from Alaska then posting from Timbuktu sets off alarm bells.

## 5.4 Warm-up, by account type

| Account | Warm-up needed |
|---|---|
| **New account** | **None.** Create it, post 3 reels, done. Next day post 6. Spread across a session of 3 in the morning and 3 at night, posted back-to-back — get a reel, post it; get the next, post it. |
| **Aged account** | **More warm-up.** Get it used to the IP, then slowly change profile picture, username and bio. Leave it there. |

## 5.5 Which to use for what

- **Pure organic reach:** *"I wouldn't even touch an aged account with a 10-foot pole."*
- **Black-hat — mass DMs, follow/unfollow, AI chatting:** buy aged. Trying those on new accounts means you get **obliterated.**

---

# SECTION 6 — Scaling and operations

*"Are you ready for this? You just buy more phones."*

## 6.1 The scale rule

That is genuinely it — devices, creation and spoofers are all already covered. **Get more funds, get more VAs, scale outwards.** How many phones and VAs depends on the task breakdown in the team-building section of the parent guide.

## 6.2 Automations across the farm

They have **automations for iOS jailbreak and Android covering both Instagram and Reddit.** This is what keeps a device productive across its whole life — and what lets a phone that has been fingerprinted out of Instagram (see 2.1) be switched to a **full Reddit operation** rather than scrapped.

## 6.3 The VA layer

Jailbroken phones suit a VA's **second-shift task (Reddit).** A device that isn't fully consumed by one platform's workload gets filled with another — the same logic that put GrapheneOS/Instagram on top of the Reddit Pixels.

## 6.4 Device selection recap

Match the device to the job: **jailbreak / Android spoofers / motherboards** for mass volume; **standard iPhones (12/14)** for quality branded posting that must hold all apps for one model; **GrapheneOS Pixels** for free multi-device scale; **cloud phones** avoided on principle.

## 6.5 Connectivity selection recap

*(Derived from his device-by-connectivity guidance across Sections 2–4; the source states each pairing individually rather than as a single table.)*

| Setup | Best connectivity |
|---|---|
| Main accounts / GrapheneOS | SIM cards (Poland method for cost) or residential-then-mobile |
| Standard iPhone posting | VPN acceptable — keep it the same per account |
| Mass phone operations (jailbreak, Android spoofers) | **Not** SIMs and **not** VPN — dedicated mobile / residential proxies; create on residential, move to mobile in the same region |
| Any device, black-hat actions | Aged accounts on consistent IPs |

*"Android is just as good as iOS. There's just pros and cons to each one."*

---

**XYZ MGMT — Confidential & For Internal Use Only**
