# WDA Customization — Local Research Index

Everything needed to start the WebDriverAgent (WDA) customization work is now local in this
`research/` folder — nothing pushed to GitHub, just plain clones for offline reading and later editing.

## What's here

- **`WebDriverAgent/`** — full source clone of the actual WDA app (github.com/appium/WebDriverAgent).
  This is the code that gets modified and rebuilt.
- **`appium-xcuitest-driver/docs/`** — Appium's own documentation, cloned as clean markdown (not scraped).
  Most relevant files, in the order you'll actually use them:
  - `docs/getting-started/provisioning-profile/index.md` — Apple Developer / signing setup, needed before WDA will even install on a device
  - `docs/guides/wda-custom-server.md` — the guide for running a self-managed, customized WDA instead of the default one (exactly this project's approach)
  - `docs/guides/run-preinstalled-wda.md` — referenced by the guide above, covers building/installing WDA manually via Xcode
  - `docs/reference/capabilities.md` — every Appium capability/setting, including WDA-related overrides
  - `docs/reference/env-vars.md` — environment variables WDA reads at launch (`USE_PORT` is one — see below)

## Confirmed fingerprint locations (found by reading the actual source, not guessing)

### 1. Bundle ID
`lib/constants.ts` in the Appium driver hardcodes:
```
WDA_RUNNER_BUNDLE_ID = 'com.facebook.WebDriverAgentRunner'
```
This is only what Appium *defaults to* when it manages WDA itself. Since this project is building WDA
manually (per `wda-custom-server.md`), the bundle ID is fully controlled in the Xcode project
(`WebDriverAgent.xcodeproj/project.pbxproj` and the target's Info.plist) — change it there before building.

### 2. Ports
`WebDriverAgentLib/Utilities/FBConfiguration.m`, lines 26–27:
```objc
static NSUInteger const DefaultStartingPort = 8100;
static NSUInteger const DefaultMjpegServerPort = 9100;
```
Good news: these are **already overridable without touching the code** — WDA reads a `--port` launch
argument or a `USE_PORT` environment variable at startup (same file, ~line 125). The Java example in
`wda-custom-server.md` shows exactly this pattern (`env.put("USE_PORT", ...)`). So port randomization is
a launch-config change, not a source-code change.

### 3. Launch/test markers
Not yet fully mapped — WDA is normally started through Apple's own test harness (`xcodebuild test`),
which is what leaves process-level traces. `run-preinstalled-wda.md` covers building it as a plain
installable app instead of always launching it through the test runner, which is the relevant angle to
dig into for this specific concern. Worth reading closely once Xcode is available to actually try both
launch paths and compare.

## Still to do (needs your teammate's research + Xcode once the Mac arrives)

- Get the specific list of checks he found apps like Reddit actually perform, so this list can be
  extended with anything not covered above.
- Decide bundle ID naming and update `project.pbxproj` + Info.plist.
- Confirm port randomization strategy (per-device, per-session, etc.).
- Read `run-preinstalled-wda.md` in full and decide: launch WDA as a persistent installed app
  vs. through the test-runner path — this affects how many of the "test harness" traces even apply.
