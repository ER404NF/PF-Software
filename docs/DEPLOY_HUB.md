# Deploying Phone Farm for remote operators and several sites

Phone Farm has two kinds of machine:

- **The hub** — one always-on server. It holds the logins, roles, queue, audit log and the
  web app. Remote operators only ever talk to the hub.
- **Sites** — each place that has phones (a Mac mini with iPhones on USB). A site runs the
  **site agent**, which dials *out* to the hub. A site needs **no open inbound port** and
  no VPN; an office router with default settings is fine.

```
 operators (browser, installed web app, Windows/Mac app) ──HTTPS──▶  HUB  ◀──HTTPS/WSS── site agent ── iPhones
   anywhere, Wi-Fi or mobile data                                    (logins, roles,         (Mac mini, one per
                                                                      audit, queue)           location)
```

Everything an operator does (tap, scroll, type, Home) goes to the hub, which checks their
role and device access, records it in the audit log, and forwards it to the site. The
phone's live video flows the other way. The exclusive lease still applies: only one
operator can control a phone at a time.

## 1. Deploy the hub

You need a small Linux server with Docker, and a DNS name pointing at it (for example
`phones.example.com`).

```bash
cd deploy/hub
cp .env.example .env
# edit .env: PUBLIC_HOSTNAME and SESSION_SECRET (openssl rand -hex 32)
docker compose up -d --build
```

Caddy (in the same compose file) gets and renews the HTTPS certificate by itself. Open
`https://<your hostname>/healthz` — it should answer `{"ok":true}`.

Create the first admin (run once; it writes to the persistent volume):

```bash
docker compose exec hub node server/scripts/create-operator.js admin '<a long password>' --role=admin
```

Everything that must survive upgrades (accounts, sessions, audit, queue, sites) lives in
the `hub-data` volume. Back that volume up. To upgrade: `git pull && docker compose up -d --build`.

**Status:** the hub was verified to boot in exactly this configuration (public HTTPS
address, real session secret, empty device list) and to answer `/healthz`; that is part of
the automated tests. The Dockerfile and compose file themselves were **not built or run**
during development because Docker was not available — expect to fix a typo or two on the
first `docker compose up`.

## 2. Add a site

1. Sign in to the hub as an admin → **Operations** → **Sites** → *Add site*. Give it a name
   (for example "Bucharest office") and, if it differs from the default, its time zone.
2. The hub shows three values **once**: the hub address, a site ID and a site token. Copy them.
3. On that location's Mac mini, either
   - install the **Phone Farm** desktop app, choose **"This is a remote site's Mac mini"** and
     enter the three values; or
   - run the agent from a checkout: `HUB_URL=… SITE_ID=… SITE_TOKEN=… npm run agent`
     (add `AUTO_PROVISION_WDA=true` to let it set up USB iPhones automatically).
4. Within seconds the site shows **Online** on the Sites page and its phones appear in the
   fleet under the site's name. Grant operators access to them like any other phone.

A lost or leaked token: **Sites → New token** cuts the old one off immediately. Deleting a
site removes its phones from the fleet. The token is stored on the hub only as a hash.

The agent refuses to send its token to an `http://` hub (except one on the same machine),
and reconnects by itself, with back-off, after any outage.

## 3. Remote operators

Operators need only a browser and an account on the hub.

| Device | How |
|---|---|
| Any computer or tablet | Open `https://<hub>` in Chrome, Edge, Safari or Firefox. |
| Android phone/tablet | Open the hub in Chrome → menu → **Install app** (installable web app). |
| iPhone / iPad | Open the hub in Safari → Share → **Add to Home Screen**. |
| Windows PC | Download `Phone-Farm-Setup-<version>.exe` from the GitHub Release; choose *Connect to an existing Phone Farm host*. |
| Mac | The `.pkg` from the release; choose *Connect to an existing Phone Farm host*. |

Store apps (Google Play / App Store) are a thin wrapper around the same web app; see
`mobile/README.md`. The installable web app works today without them.

Controls are the phone's own: click to tap, drag to swipe, mouse wheel (or arrow keys /
Page Up / Page Down) to scroll, keyboard to type, and the round button under the phone is
Home. On a touch screen there is a **Keyboard** button.

### Mobile data

The picture is live video from the phone (about 15 frames a second at half size by
default) and it stops when the browser tab is hidden. As a rough guide, expect on the order
of 1–3 Mbps while watching; **this is an estimate, not a measurement on real hardware**.
To use less, set these on the machine that runs the phone (the site agent, or the host):

```
WDA_STREAM_FPS=8        # frames per second (1-60, default 15)
WDA_STREAM_SCALE=40     # percent of the phone's native size (10-100, default 50)
WDA_STREAM_QUALITY=30   # JPEG quality (5-100, default 35)
```

## 4. Time zone

`/time 09:00-17:00 …` commands are read in **America/Los_Angeles** unless
`PHONE_FARM_TIMEZONE` says otherwise. Each site also stores a time zone (shown on the Sites
page and on its phones). Scheduling itself still uses the hub's one zone; per-site
scheduling zones are not implemented yet.

## 5. Security notes

- Sites connect outbound only; the hub never connects into a site.
- Site tokens are 256-bit random values, stored as SHA-256 hashes, compared in constant time.
- An agent can only register phones under its own site's namespace (`<site>__<phone>`); it
  cannot replace a phone the hub owns, and it can only be asked to run a fixed list of phone
  actions.
- Operators' sessions, roles, device grants, the audit log and the exclusive lease are all
  enforced on the hub; the site trusts the hub for who is allowed to do what.
- Put the hub behind HTTPS only (the compose file does). The hub refuses to listen on a public
  address without HTTPS cookie settings and refuses to start without a strong session secret.

## What is and is not verified

Verified by automated tests (simulated phones and a fake WebDriverAgent, including a real
agent process linking to a real hub): the agent link, remote control and live video across
sites, reconnection, token rotation, access rules, the site admin API, and the hub's boot
configuration. **Not yet verified on real hardware:** WebDriverAgent's actual video feed
and gesture behaviour on an iPhone, mobile-data usage, and the Docker build.
