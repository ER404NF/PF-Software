# Bodun — Human and AI Device Operations

## DOWNLOAD BODUN

### Direct arm64 installer from `git pull` (internal/development use)

The latest successful `main` build is also stored at `prebuilt/mac/Phone-Farm.pkg`. This is the fixed internal
path for the Apple-silicon (`arm64`) installer; public versioned packages and the existing
the legacy-named `Install Phone Farm.command` flow continue to use GitHub Releases.

Git LFS is required because the package is about 130 MB:

1. Install Git LFS, then run `git lfs install` once on that Mac.
2. Run `git pull --ff-only origin main` normally.
3. Open `prebuilt/mac/Phone-Farm.pkg`. Check `prebuilt/mac/SIGNING_LEVEL.txt` for `unsigned`, `signed`, or
   `notarized`; `prebuilt/mac/Phone-Farm.pkg.sha256` contains the package checksum.
4. Until the file is notarized, Control-click **Phone-Farm.pkg**, choose **Open**, and confirm the macOS warning.

Important: a plain `git pull` performed before Git LFS is installed can silently leave a small LFS pointer file
at that path instead of the real installer. If the package is unexpectedly tiny, run `git lfs install`, then
`git lfs pull`. Git LFS storage and download bandwidth are metered by GitHub, so the repository owner must monitor
usage as this package is refreshed and downloaded.

### Mac installation from a cloned repository

1. Clone or pull PF-Software (`git pull --ff-only origin main`).
2. Open the PF-Software folder in Finder.
3. Double-click **`Install Phone Farm.command`**.
4. The latest compatible installer is downloaded and its SHA-256 checksum is verified.
5. Follow the standard macOS Installer.

What it does, and what it needs:

- **Internet is required.** It checks that GitHub is reachable first and says so plainly if it is not.
- **Where the installer comes from:** the newest stable release on
  [GitHub Releases](https://github.com/ER404NF/PF-Software/releases/latest), the same release the app's own
  update check uses. The version is never hard-coded. The installer is downloaded into a temporary folder,
  never into the repository, so `git status` stays clean.
- **Supported Macs:** Apple silicon (arm64) uses `Phone-Farm-<version>-arm64.pkg`. Intel Macs need the
  `universal` package; if a release has none, the script says so and stops rather than installing something
  incompatible. macOS 12 or newer.
- **Checksum verification:** every package is published with `<package>.sha256` (and `SHA256SUMS.txt`). The
  script compares the downloaded file with it using `shasum -a 256`. On a mismatch, a missing checksum, or an
  interrupted download it deletes the file, does **not** open the Installer, and exits with an error.
- **Signing status:** Apple Developer ID signing and notarization are supported by the release workflow but the
  Apple credentials are not configured yet. Until they are, a published macOS package is a DEVELOPMENT build
  named `...-UNSIGNED.pkg`, and the script says so.
- **If macOS blocks an unsigned DEVELOPMENT build:** open **System Settings → Privacy & Security** and click
  **Open Anyway** next to the Phone Farm package (or Control-click the package and choose **Open**). The script
  never disables Gatekeeper or removes the quarantine flag; it marks the download exactly like a browser does,
  so macOS performs its normal checks. Once the release is signed and notarized this step disappears.
- It needs no Node.js, npm, Xcode or build step. If a release has no macOS package yet, it says so and stops.

Developers who need a package built from their own checkout use `desktop/scripts/build-macos-installer.sh`
(see [docs/MAC_RELEASE.md](docs/MAC_RELEASE.md)). That is not the normal way to install.

### Other downloads

- [Download Phone Farm for Windows](https://github.com/ER404NF/PF-Software/releases/latest/download/Phone-Farm-Windows.exe)
- [See all releases and checksums](https://github.com/ER404NF/PF-Software/releases/latest)

On Windows, double-click `Phone-Farm-Windows.exe`. The release workflows build and verify these files.
Windows and public versioned installers are not committed into ordinary Git history. The one exception is the
single current internal arm64 package under `prebuilt/mac/`, stored through Git LFS and overwritten after each
successful `main` build. The small root script continues to download the published Release package instead.

Installing either package does **not** require the source code, Node.js, npm, Terminal, or this repository.
Everything Phone Farm needs to run — including its server and the WebDriverAgent it
uses to control iPhones — is already inside the app.

- A versioned file named `...-UNSIGNED.pkg` or `...-NOT-NOTARIZED.pkg` is a development build made without
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

At packaged-app startup, Phone Farm compares its application version with the newest stable published release.
When they differ it offers to download the correct installer, verifies GitHub's SHA-256 digest, and opens
the installer. Declining or failing that required update exits before a host, agent, or client window starts.
Development runs from source do not use this release gate.

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
3. `docs/productionization/README.md` for the proposed commercial cloud/site architecture, ADRs, domain model,
   trust boundaries, data classification, threat model, and database reconciliation
4. `docs/FUTURE_AI_VA_SPEC.md`
5. `docs/COMMAND_QUEUE_SPEC.md`
6. `docs/PLATFORM_CAPABILITY_MATRIX.md`
7. `docs/ROADMAP.md`
8. `system/README.md`
9. active code under `system/`

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
