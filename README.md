# Phone Farm — Dual-Mode Human VA / Future AI VA Control System

## DOWNLOAD PHONE FARM FOR MAC

**Get the installer from [GitHub Releases](https://github.com/ER404NF/PF-Software/releases/latest)** (once a release has been published; until then, use the newest run's **Artifacts** under [GitHub Actions](https://github.com/ER404NF/PF-Software/actions/workflows/mac-installer.yml), see [docs/MAC_RELEASE.md](docs/MAC_RELEASE.md)) and download the single file:

```text
Phone-Farm-<version>-arm64.pkg        (Apple silicon Macs)
```

Then **double-click it** in Finder. macOS Installer opens; click **Continue**, then
**Install**. Phone Farm appears in **Applications**; open it like any other app.

You do **not** need the source code, Node.js, npm, Terminal, or this repository.
Everything Phone Farm needs to run — including its server and the WebDriverAgent it
uses to control iPhones — is already inside the app.

- A file named `...-UNSIGNED.pkg` or `...-NOT-NOTARIZED.pkg` is a development build made without
  complete Apple signing credentials. macOS Gatekeeper will warn about it (Control-click → Open, or
  allow it in System Settings → Privacy & Security). Only the plain `Phone-Farm-<version>-arm64.pkg`
  is the signed and notarized public installer.
- Computers that only *connect* to an existing Phone Farm host need nothing else: open the app and choose
  **Connect to an existing Phone Farm host**.
- The one Mac that *controls the iPhones* needs Xcode (App Store), the USB tools
  `libimobiledevice` and `libusbmuxd`, and an Apple Developer account signed in to Xcode. Phone Farm's host
  setup screen checks each of these, shows a **Fix it** button where it can do the step for you (macOS asks for
  your Mac password once; the USB tools are installed with Homebrew if it is on the Mac) and says exactly what is
  missing otherwise. The host keeps the Mac awake, restarts itself after a crash and opens at login. If
  something does not work, **Help → Copy Diagnostics** gives you a report to send. Details:
  [desktop/README.md](desktop/README.md).

Real-Mac, real-iPhone acceptance steps: [docs/MAC_INSTALLER_ACCEPTANCE.md](docs/MAC_INSTALLER_ACCEPTANCE.md).
How a maintainer publishes a release: [docs/MAC_RELEASE.md](docs/MAC_RELEASE.md).

### For developers only: building the installer from source

`BUILD_PHONE_FARM_INSTALLER.command` (macOS) / `BUILD_PHONE_FARM_INSTALLER.cmd` (Windows) are
**developer tools, not the Phone Farm installer**. They need Node.js 20+, install the exact locked
dependencies, run the server and desktop test suites, and build a local installer into `desktop/dist/`.
Releases are normally produced by GitHub Actions (`.github/workflows/mac-installer.yml`) so that the
tests gate the build and the package is signed and notarized; ordinary users should never run these files.

```sh
cd desktop
npm ci
npm test
npm run dist:mac        # macOS only -> dist/Phone-Farm-<version>-arm64[-UNSIGNED].pkg
```

## Product goal

Build a private control plane for organization-owned or otherwise authorized phones.

The product starts as a **Human VA remote-device system** and is intentionally designed so the same phones can later be controlled by an **AI VA** for content-research workflows without replacing the device-control foundation.

The two operator modes are explicit and mutually exclusive per device:

```text
HUMAN VA MODE
AI controller OFF
Human web controls ON

        ⇅ safe handoff

AI VA MODE
AI controller ON
Human input controls locked/read-only unless takeover is requested
AI receives tasks from a command/queue interface
```

There must never be two simultaneous input owners for one device.

## Phase 1 — Human VA Mode (current milestone)

Pilot V1 should provide:

1. config-driven device discovery/registration;
2. stable per-device identity and state;
3. real-device screen observation;
4. human tap, swipe and text input;
5. exclusive device sessions;
6. authenticated operators and authorization;
7. per-device/account/client file isolation;
8. controlled media transfer;
9. device/host health reporting;
10. audit events;
11. recovery from common disconnects/failures.

Current control path:

```text
Human VA
   ↓
Web Console
   ↓
Control Plane / Device API
   ↓
Device Adapter
   ↓
Physical Phone
```

## Phase 2+ — AI VA Mode (future)

The future AI VA uses the **same Device API** as the human interface.

```text
                         Control Plane
                              │
                     Exclusive Input Lease
                              │
              ┌───────────────┴───────────────┐
              │                               │
        Human Controller                 AI VA Worker
              │                               │
              └───────────────┬───────────────┘
                              │
                          Device API
                              │
                    Platform/Device Adapter
                              │
                         Physical Phone
```

AI VA is intended for authorized content research and organization on managed accounts. Example jobs:

- browse Instagram, Reddit, X/Twitter and other configured platforms;
- search topics/keywords/accounts;
- scroll feeds and open posts/threads/media;
- collect links/stable IDs, screenshots and visible metadata;
- identify useful hooks, formats, topics, comments, creators and trends;
- save/bookmark interesting content;
- optionally use configured account actions such as likes, votes, reposts or comments as research markers/signals;
- write preset comments or content-grounded AI comments when that account policy enables it;
- record selected content internally so it can always be revisited independently of the platform UI;
- produce structured research summaries and queues for the content team.

These actions are for research/organization on managed accounts, not for manufacturing engagement. Internal content records remain the canonical research memory.

## Mode switching

Each device has an explicit controller state:

```text
HUMAN
AI_IDLE
AI_RUNNING
AI_PAUSED
HANDOFF
ERROR
```

### Switch to Human VA Mode

Expected behavior:

1. block new AI device actions;
2. finish/timeout the current atomic action safely;
3. checkpoint the AI task and queue;
4. release the AI device lease;
5. activate the normal VA screen and input controls;
6. log the handoff.

The human can inspect or correct the phone directly.

### Switch to AI VA Mode

Expected behavior:

1. validate device health, account authorization and AI policy;
2. lock human input controls for that device;
3. acquire the AI lease;
4. show AI status, current task, queue, elapsed/window time and last action;
5. start or resume the selected queued task;
6. keep a visible **Take Over / Stop AI** control available.

## AI command console and queue

A future AI VA console accepts both structured slash commands and natural-language goals.

Required command form:

```text
/time <start>-<end> <task>
```

Example:

```text
/time 09:00-10:00 Research AI coding posts on Instagram. Save strong candidates and capture their links.
```

Commands may be queued. When one task finishes, the scheduler starts the next eligible queued task immediately. A task whose allowed time window has not started yet remains scheduled while other eligible work may run.

Detailed syntax/state semantics are in `docs/COMMAND_QUEUE_SPEC.md`.

## Research memory

A platform interaction is not sufficient as storage. When the AI decides content is useful, it should create an internal `ContentCandidate` record containing as much of the following as available:

```text
platform
canonical URL / stable content ID
account and device
observed time
screenshot/evidence
visible metrics
caption/title/text extract
AI summary
reason selected
tags/category/score
platform actions taken
task/session/run IDs
human review state
```

This lets the team find content later even if the feed changes or a platform action is removed.

## Canonical documentation

Use these files in order:

1. `README.md`
2. `Architecture Baseline.md`
3. `docs/FUTURE_AI_VA_SPEC.md`
4. `docs/COMMAND_QUEUE_SPEC.md`
5. `docs/PLATFORM_CAPABILITY_MATRIX.md`
6. `docs/ROADMAP.md`
7. `system/README.md`
8. active code under `system/`

`source-material/`, `archive/`, `research/`, and `graphify-out/` are background/non-canonical unless a task explicitly names them.

## Current implementation priority

The project remains **Human VA first**. The hardware-independent Human VA
control plane, authentication, persistence, health, lease, scheduler and the
MS8 read-only research path are built. Current priorities are:

1. connect and bench-test one real iPhone;
2. configure one managed account, its installed app version, and a model provider;
3. run supervised read-only acceptance through `/cresearch`, including
   candidate/evidence persistence, challenge handoff, and provider switching;
4. enable platform-visible actions (MS9/MS10, built and default-disabled) only after the MS8 gate passes;
5. continue with configured account actions, then the measured
   1 → 2 → 5 device gates.

## Non-goals

The product does not require fake-account generation, CAPTCHA or security-control bypass, fingerprint/location spoofing, ban-replacement loops, or engagement-boosting campaigns. If a real platform requires MFA/security verification, the system should hand the device to a human operator.
