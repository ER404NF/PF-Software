# Client Account Separation — Internal Technical Reference

**Owner:** XYZ MGMT · **Status:** Internal · **Last verified:** 2026-08-20

---

## 0. Purpose and scope

This document exists so that no client of ours is ever damaged by something that happened
to a different client, to another staff member, or to us.

The specific failure it is written against: agencies routinely pull client assets into one
shared container — one business portfolio, one login, one billing method, one browser — and
when any part of that container is compromised, restricted, or disputed, every client inside
it is affected simultaneously. The client did nothing wrong and has no way to insulate
themselves, because their access was never actually separate to begin with.

**In scope:** keeping legitimately authorized client work isolated from other clients, from
our internal systems, and from staff turnover. Understanding precisely which linkages exist
so we can make honest promises to clients about what we do and do not control.

**Out of scope:** this is not a guide to operating undisclosed accounts or presenting one
operator as multiple unrelated parties on a platform. Everything below assumes each account
is authorized by its owner and the platform knows we are the agency operating it. Where
delegated access exists, using it is the recommended practice precisely *because* it is
attributable.

**How to read this:** Sections 2–4 are the reference material — what links identities, what
does not, and how confident we can be about each. Sections 5–9 are what we actually do.
If you only read one section, read §5.

---

## 1. What we are protecting against

Ranked by how often it actually causes damage, not by how dramatic it sounds.

| # | Failure | What it looks like | Blast radius |
|---|---|---|---|
| 1 | **Shared container** | Client assets live inside our business portfolio / ad account / billing rather than theirs | All clients at once |
| 2 | **Credential spill** | We hold a client password; it leaks, or a departing staffer keeps it | That client, permanently |
| 3 | **Session bleed** | Wrong browser profile open, post goes to the wrong client | One client, publicly, immediately |
| 4 | **Billing entanglement** | One payment method across client ad accounts | Every account on that card |
| 5 | **Staff offboarding gap** | Personal access was granted directly instead of through a revocable role | Every asset that person touched |
| 6 | **Enforcement contagion** | One account actioned; platform propagates to linked entities | Anything sharing the link |
| 7 | **Vendor concentration** | One analytics/scheduling/shortener account across all clients | All clients' data, one breach |

Note what is *not* on this list: browser fingerprinting. It matters (§3.5) but it is far
down the list of things that have ever actually hurt an agency's clients. Fix the top of the
table first.

---

## 2. The layer map

Separation is not one thing. It exists independently at six layers, and a boundary at one
layer says nothing about the layer above or below it.

```
┌─────────────────────────────────────────────────────────┐
│ 6. PLATFORM ACCOUNT GRAPH   Meta / X / TikTok / Reddit   │  ← strongest linker
│    who administers what, billing, delegation records     │
├─────────────────────────────────────────────────────────┤
│ 5. IDENTITY / CREDENTIAL    passwords, 2FA, recovery     │
├─────────────────────────────────────────────────────────┤
│ 4. BROWSER PROFILE          cookies, storage, extensions │  ← where most people stop
├─────────────────────────────────────────────────────────┤
│ 3. DEVICE / OS              hardware, OS user, files     │
├─────────────────────────────────────────────────────────┤
│ 2. NETWORK                  IP, DNS, TLS, NAT            │
├─────────────────────────────────────────────────────────┤
│ 1. BEHAVIOR                 timing, assets, style, links │
└─────────────────────────────────────────────────────────┘
```

The single most common mistake in this industry is treating layer 4 as if it covered layers
5 and 6. A browser profile is an excellent boundary for cookies and a *nonexistent* boundary
for who is listed as an admin on a business portfolio.

---

## 3. What links identities

Each subsection: the mechanism, how strong the link is, and what it means for us.

### 3.1 Platform account graph — the strongest linker by a wide margin

The platform is not inferring anything here. It is reading its own database.

**Meta (Facebook / Instagram / Threads)**

- Business portfolio membership is an explicit, permanent, queryable relationship. Every
  asset inside a portfolio is linked to every other asset inside it and to every person with
  a role on it.
- Partner access creates a recorded relationship between two portfolios — ours and the
  client's. This is the *good* kind of link: explicit, scoped, and revocable by the client.
- Personal Facebook profiles are the root of admin identity. A staffer's personal profile
  with admin on six client portfolios is a six-client link running through one human being.
- Shared payment instruments link ad accounts hard. A dispute or fraud flag on one card can
  reach every ad account billed to it.
- Instagram accounts added to a portfolio inherit that portfolio's linkage.

**X**

- The Delegate feature records Owner / Admin / Contributor roles per account without any
  password exchange. The delegation is itself a stored relationship between our staff
  accounts and the client account.
- **Operationally critical:** changing the account password does *not* revoke delegate
  access. Revocation is a separate, explicit action. This is the single most-missed step in
  X offboarding.

**TikTok**

- Business Center is the equivalent container. Partner relationships between Business
  Centers are recorded and scoped; assets can be shared without credential exchange.

**Reddit**

- Reddit Business Manager has a Partners capability, but it covers **advertising only** —
  ad accounts, brand profiles shown on ads, credit lines, pixels and audiences.
- There is **no delegated access to organic Reddit user accounts.** None. A Reddit account
  is operated by whoever holds the password. Subreddit moderator permissions are the only
  granular sharing Reddit offers, and they apply to a subreddit, not an account.
- Consequence: any organic Reddit work is a credential-custody problem by construction.
  See §5.4 for how we handle platforms with no delegation.

**Cross-platform**

- Recovery email and phone number are the quietest hard link in existence. Two accounts
  sharing a recovery address are linked at the identity provider, forever, regardless of
  every other precaution.
- Verified business identity documents, tax IDs and payout accounts link entities
  definitively where they are required.

**Strength: definitive.** Nothing at layers 1–4 can weaken these. If two things are linked
here, they are linked, and the only question is whether the linkage is one we chose.

### 3.2 Credential and identity layer

- A password we hold is a link between us and that account that persists until the password
  changes — including after a staffer leaves, including after a laptop is lost.
- Shared vault items propagate: one vault entry visible to the whole team means every team
  member is, in the platform's eyes, a possible actor on that account.
- 2FA seeds stored next to the password reduce two factors to one.
- 2FA bound to one person's personal phone creates a single point of failure and a link
  between that person and the client, and it breaks the day they leave.
- Password reuse across client accounts converts one breach into many. Credential-stuffing
  operators test reused pairs across platforms automatically.
- Chrome's built-in password manager is per-profile, but if a profile is signed into a
  Google account with sync on, those credentials leave the machine and land in that Google
  account. If it is a staffer's *personal* Google account, client credentials are now in
  personal custody.

**Strength: definitive where present.** This layer is entirely within our control, which is
why §5 attacks it first.

### 3.3 Browser profile layer

What is genuinely separate between Chrome profiles:

- Cookie jars, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, service workers,
  history, autofill, saved passwords, and installed extensions are all per-profile.
- A site logged in on Profile A has no readable path to Profile B's cookies. There is no
  supported mechanism for a page in one profile to read another profile's storage.
- Since Chrome 115, third-party storage is additionally partitioned *within* a profile by
  top-level site, so an embedded third party cannot use storage as a cross-site join key the
  way it once could. Partition key is (embedded origin, top-level site, ancestor bit).
- Proxy configuration is per-NetworkContext, and each profile has its own. Precedence runs
  managed policy → command-line flags → `chrome.proxy` extension → system settings. So two
  profiles in one Chrome instance *can* egress via different proxies — but only via policy or
  a per-profile extension. Changing the Windows system proxy changes it for every profile at
  once, which is the default most people are actually running.

What is **not** separate, and this is where people get hurt:

- **Third-party cookies still work by default.** Google reversed the deprecation plan on
  2025-04-22 and retired most Privacy Sandbox APIs on 2025-10-17 (Topics, Protected
  Audience, Attribution Reporting). CHIPS, FedCM and Private State Tokens survive. Any
  planning that assumed third-party cookies would be gone by now is wrong.
- **Chrome Sync crosses the boundary by design.** A profile signed into a Google account
  exports its own contents to that account. Two profiles signed into the *same* Google
  account are, for practical purposes, one profile with two windows.
- **Extensions with broad host permissions see everything in their profile** — and an
  extension installed into several profiles is one vendor observing several clients.
- **"Continue running background apps when Google Chrome is closed"** (policy:
  `BackgroundModeEnabled`) lets a profile's service workers keep running after its last
  window closes. A profile you believe is closed can still be transmitting.
- Session restore, OS default-browser link handling, and pinned per-profile shortcuts all
  cause accidental opens. A single accidental page load writes a real session record.

**Strength: strong for cookies, zero for everything above it.** Profiles are a good tool
being asked to do a job three layers too big.

### 3.4 Device and OS layer

- Everything running as one Windows user account can read every Chrome profile folder on
  that account. Profiles are a convenience boundary, not a security boundary against local
  code or against anyone with the machine.
- Separate Windows user accounts are a genuine boundary. Separate machines are a stronger
  one. Separate VMs sit in between.
- Clipboard, downloads folder, screenshots and shared file paths move client data across
  boundaries constantly and invisibly.
- Backup and sync agents (Dropbox, OneDrive, Drive for desktop) will happily replicate one
  client's assets into a shared location.

**Strength: strong.** The OS user account is a much better boundary than the browser profile
and is underused.

### 3.5 Network layer

- Every profile on a machine shares the machine's IP unless a per-profile proxy is
  explicitly configured (§3.3).
- IP alone is weak evidence — residential IPs rotate, offices NAT dozens of people behind
  one address, mobile carriers share addresses across thousands of subscribers.
- IP is strong evidence when it is *stable and unusual*: a static business IP seen on twenty
  otherwise unrelated accounts is a very clear signal.
- Anyone operating the network sees DNS lookups and TLS SNI — which sites, when, how much —
  for all traffic on that network, but not the contents of encrypted sessions and not
  anything from a browser profile that is genuinely closed.
- **Shared commercial proxy pools are a liability, not a mitigation.** An IP from a pool
  carries whatever reputation every previous tenant gave it. Routing a client through one
  can attach them to strangers' history.

**Strength: weak alone, corroborating in combination.**

### 3.6 Device fingerprint

Available to any page without permission: OS and version, screen geometry, GPU via WebGL,
CPU core count, device memory estimate, timezone, language, installed font set, plus canvas
and audio rendering hashes. These are properties of the hardware and the browser build, so
they are **identical across every profile on one machine** and change only when the hardware,
OS, or browser changes.

Meaningful consequence for us: a third party that observes several of our client sessions —
an ad network, an analytics vendor, a CDN embedded on many sites — can tell those sessions
came from the same workstation. That is a *data-exposure* consideration (a vendor learns our
client roster) rather than a platform-enforcement one, and the mitigation is vendor hygiene
(§5.6) and per-client devices where the client's sensitivity warrants it.

**Strength: high for "same machine", zero for "same person's intent".**

### 3.7 Behavioral and content linkage

Frequently the easiest link of all, and the one nobody audits:

- Reused image assets, including EXIF metadata, embedded color profiles, and identical
  crops or exports.
- One link-shortener or UTM scheme across all clients — the shortener vendor sees the whole
  portfolio, and the tags are public in the URLs.
- A shared scheduling tool posting at machine-regular intervals with identical cadence.
- Writing style, emoji habits, signature phrasing carried between accounts by one operator.
- Templates and boilerplate reused verbatim across client bios and replies.

**Strength: moderate to high, and rising as detection improves.**

---

## 4. What does **not** link — stated precisely

Claims we can make honestly, with the caveat attached to each.

| Claim | True? | Caveat |
|---|---|---|
| A closed Chrome profile transmits nothing | **Yes** | Unless `BackgroundModeEnabled` is on, or a window is open you forgot about |
| Profile B cannot read Profile A's cookies or logins | **Yes** | Not a defense against local code running as the same OS user |
| A site in Profile B never receives Profile A's session | **Yes** | It can still fingerprint the machine as the same device |
| Separate profiles have separate extensions | **Yes** | Same extension installed in both is one vendor watching both |
| Network operator on IP B cannot see Profile A's traffic | **Yes** | Only holds if Profile A never runs on that network |
| Changing an X password revokes delegate access | **No** | Delegates persist; revoke explicitly |
| Different profiles automatically use different IPs | **No** | Same egress unless a per-profile proxy is configured |
| Third-party cookies are deprecated in Chrome | **No** | Reversed 2025-04-22; still on by default |
| Browser profiles isolate a client from our business portfolio | **No** | Different layers entirely (§2) |
| Profiles hide that two accounts share one workstation | **No** | Fingerprint is hardware-identical across profiles |

---

## 5. What we do — the operating architecture

### 5.1 Rule one: we do not hold client credentials

Default posture on every platform that supports delegation. It is better for the client
(revocable, auditable, survives our staff changes) and better for us (we cannot leak what we
never held, and we are not a custodian of someone else's identity).

| Platform | Mechanism | Password needed? | Revocable by client |
|---|---|---|---|
| Meta / Instagram | Partner access between business portfolios | No | Yes, unilaterally |
| X | Delegate — Owner / Admin / Contributor | No | Yes, explicit revoke required |
| TikTok | Business Center partner access | No | Yes |
| Reddit (ads) | Business Manager → Partners | No | Yes |
| Reddit (organic) | **No mechanism exists** | Yes | Only by password change |

### 5.2 Rule two: client assets stay in the client's container

We request partner access **to their portfolio**. We never create client assets inside ours,
and we never accept an invitation structured that way — even when the client offers, and even
when it is faster.

This is the rule that prevents the failure at the top of §1. If our portfolio is ever
restricted, a client whose assets live in their own container is unaffected. A client whose
assets live in ours goes dark with us. Anything created inside our container during a
campaign is migrated to theirs before the campaign closes.

### 5.3 Rule three: separate billing per client

Each client's ad spend bills to that client's own payment instrument on their own ad
account. Where we must front spend, it is a distinct instrument per client, never one card
across the book. A billing dispute must be able to affect exactly one relationship.

### 5.4 Handling platforms with no delegation (Reddit organic, and any similar case)

Where we genuinely must hold a credential:

1. The client creates the account and the credential; we receive it, we never originate it.
2. It is unique — never reused anywhere, generated by the vault, never resembling any other
   client's.
3. 2FA is bound to a shared agency-controlled authenticator entry, not to any individual's
   personal phone.
4. Recovery email and phone belong to the **client**, not to us. This is what guarantees they
   can always retake the account.
5. The account is worked from its own dedicated browser profile, on its own OS user account,
   from one designated workstation.
6. Credential rotation is mandatory at offboarding and on any staff departure that touched it.
7. Named in the client agreement: which accounts we hold credentials for, and why no
   delegated alternative exists.

### 5.5 Rule four: one profile per client, and make mistakes hard

- One Chrome profile per client. Profile name is the client name. No mixing, no "quick check
  in whatever's open."
- Give each profile a distinct avatar colour and set a per-client theme — the fastest defense
  against posting to the wrong account is a window that looks obviously wrong.
- No client profile is ever signed into Chrome Sync with a personal Google account. Agency
  Workspace accounts only, and only where sync is deliberately wanted.
- `BackgroundModeEnabled` disabled by policy across the estate.
- Extensions in a client profile are limited to an approved list. No convenience extensions
  in client profiles, ever.
- A neutral, non-client profile is the Windows default browser target, so stray link clicks
  land somewhere harmless.
- High-sensitivity clients get a separate Windows user account or a dedicated device rather
  than just a profile.

### 5.6 Rule five: vendor concentration is a client risk

Any tool that touches multiple clients — scheduler, analytics, shortener, DAM, AI tooling —
is a single point at which every client's data can be exposed at once. Per-client workspaces
inside those tools where the tool supports it, per-client accounts where it does not, and a
maintained register of which vendors hold which clients' data.

### 5.7 Rule six: staff access is individual, role-based, revocable

- Never a shared agency login. Every human has their own identity.
- Access is granted by role inside a partner relationship, never by adding a personal profile
  directly to a client asset.
- Access review quarterly and on every departure.
- Departure runbook in §8.

---

## 6. Most likely ways this still breaks

Ordered by observed frequency, not severity.

1. **The X delegate that was never revoked.** Password changed, staffer gone, access intact.
2. **A "temporary" asset created in our portfolio** that nobody migrated back.
3. **One card on file** across several client ad accounts because onboarding was rushed.
4. **A client profile signed into a personal Google account** for convenience, syncing
   credentials into private custody.
5. **The wrong profile open** at the wrong moment — the only failure on this list that is
   instantly public.
6. **A shortener or analytics account** shared across the book, quietly aggregating everything.
7. **Recovery email pointing at us** rather than the client, so the client cannot self-recover
   and we cannot cleanly exit.

---

## 7. Containment — when one client is compromised or actioned

1. **Stop.** Do not log into other client accounts from the same profile, machine, or
   session while triaging.
2. **Scope it.** Which container held the affected asset? Which of our staff had roles on it?
   Which credentials, if any, did we hold?
3. **Cut the shared edges first,** in this order: billing instrument, portfolio membership,
   delegated roles, credentials. These are the edges that carry contagion to other clients.
4. **Rotate** every credential we held that touched the affected account, plus anything
   sharing a recovery address with it.
5. **Notify the client** with the actual scope — what was linked, what was not, and on what
   basis we know. §4 is the table to answer that from.
6. **Verify the other clients are clean** rather than assuming it, using §8's audit.
7. **Write it up.** Which layer failed, and which rule would have prevented it.

---

## 8. Checklists

**Onboarding a client**

- [ ] Client owns their business portfolio / Business Center; we request partner access to it
- [ ] Partner access granted at the minimum sufficient permission level
- [ ] Zero assets created inside our container
- [ ] Client's own payment instrument on their own ad account
- [ ] Recovery email and phone belong to the client
- [ ] Dedicated Chrome profile created, named, colour-coded, sync off
- [ ] Any held credentials vaulted, unique, 2FA on agency-controlled authenticator
- [ ] Credential-custody list recorded in the client agreement
- [ ] Client-specific workspaces created in shared vendor tools

**Weekly**

- [ ] No unexpected roles on any client asset
- [ ] No assets sitting in our container that should have been migrated
- [ ] Vendor register still matches reality

**Staff departure — same day**

- [ ] Meta: roles removed from every portfolio, ours and every client's
- [ ] **X: delegate access explicitly revoked on every account** (password change is not enough)
- [ ] TikTok Business Center: membership removed
- [ ] Reddit: any organic credential they held is rotated
- [ ] Vault access revoked; every item they could see is rotated
- [ ] Their Chrome profiles removed from any shared machine
- [ ] 2FA moved off any personal device of theirs

**Offboarding a client**

- [ ] All assets confirmed inside the client's own container
- [ ] Our partner access removed at the client's convenience, not silently retained
- [ ] Every credential we held rotated by the client, not by us
- [ ] Client's browser profile removed from all workstations
- [ ] Client data removed from shared vendor tools
- [ ] Written confirmation to the client of what we no longer hold

---

## 9. What this does not protect against

Stated plainly so we do not oversell it to clients.

- It does not stop a platform-side breach at Meta, X, TikTok or Reddit.
- It does not stop a client's own staff from mishandling their own credentials.
- It does not prevent a third-party vendor embedded across many sites from observing that
  several client sessions originate from one workstation (§3.6). Only per-client devices
  reduce that, and it is rarely worth the cost.
- It does not make a compromised workstation safe. Local malware running as our Windows user
  reads every profile on that account regardless of separation.
- It does not disguise our involvement, and is not intended to. Every mechanism recommended
  here is one the platform records deliberately.

---

## 10. Verification

How to confirm the setup is actually what this document says.

| Check | Where |
|---|---|
| Which Google account a profile is synced to | `chrome://settings/people` in that profile |
| Background mode / policy state | `chrome://policy` — look for `BackgroundModeEnabled` |
| Effective proxy for a profile | `chrome://net-export` opened *from that profile* |
| Extensions and their host permissions | `chrome://extensions` in that profile |
| Meta partner relationships and roles | Business Settings → Partners, and Users → People |
| X delegate list | Settings → Security and account access → Delegate |
| TikTok partner relationships | Business Center → Partners |
| Whether a profile is truly closed | Windows Task Manager — no `chrome.exe` for it |

---

## Sources

- [X — How to use the delegate feature](https://help.x.com/en/managing-your-account/how-to-use-the-delegate-feature)
- [Chrome — Third-party storage partitioning](https://privacysandbox.google.com/cookies/storage-partitioning)
- [Third-party cookies in 2026 after Google's reversal](https://www.consenteo.com/knowledge-hub/cookies/third_party_cookies_2026_after_google_reversal)
- [Google Privacy Sandbox shutdown](https://segwise.ai/blog/google-privacy-sandbox-shutdown-reason)
- [Meta — requesting partner access to client ad accounts](https://www.leadsie.com/blog/request-facebook-ad-account-access)
- [TikTok — adding partners to Business Center](https://ads.tiktok.com/help/article/invite-partners-into-tiktok-business-center?lang=en)
- [Reddit — agency profile sharing in Business Manager](https://www.contentgrip.com/reddit-advertisers-and-agencies-feature/)
- [Chromium — proxy support (per-NetworkContext configuration)](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
- [Chrome Enterprise — BackgroundModeEnabled policy](https://chromeenterprise.google/policies/background-mode-enabled/)

---

*Review cadence: quarterly, and immediately after any platform changes its access model.*
