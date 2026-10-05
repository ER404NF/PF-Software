# Proxy debug handoff — 2026-10-05

> Historical snapshot: the review below was read-only at the time it was
> written. Its working-tree counts and open-finding list are not current.
> Follow-up source changes have since addressed the four findings below:
> capped iproxy recovery now returns through provisioning and fresh readiness;
> readiness is invalidated/fenced across process generations; saved bridges
> must be active sharing members; PostgreSQL preserves proxy username bytes.
> The handoff file itself is an untracked workspace artifact. Use the latest
> review and current source for present status.

This handoff records the read-only review of the working tree against
17af78553a7612a9be0d71720da81e75d9aa78b9. No application code was changed by
the review. The working tree contains 25 unstaged tracked files, no staged
files, and no untracked files.

## Findings recorded by the original read-only review

### P1 — Capped iproxy recovery leaves the device permanently blocked

Location: system/server/src/deviceProvisioner.js:380-382 and
system/server/src/index.js:2052.

_onPersistentFailure() sets discoveryState to provisioning_error while the
supervisor continues retrying. _onProcessStable() clears component error state
but does not clear that discovery state. deviceOpenDecision() rejects
provisioning_error, so a tunnel that later recovers remains unusable until a
manual Retry Automatic Setup.

Fix direction: move the device back through a recovering/provisioning state
when a replacement starts, and clear the banner only after the replacement
iproxy is stable and a fresh WDA readiness check succeeds. Add a regression
test that reaches capped retry, then emits stable plus fresh readiness, and
asserts that the device becomes openable.

### P1 — Replacement tunnel can reuse stale WDA readiness

Location: system/server/src/deviceProvisioner.js:329-331 and
system/server/src/deviceProvisioner.js:336.

An iproxy exit leaves wdaDevice.readiness.ready unchanged. When the
replacement process survives its stable-run window, refreshControlHealth() can
mark control READY using the previous tunnel generation's successful WDA
status. The fleet can then expose the phone as selectable before a fresh
status request has traversed the replacement tunnel.

Fix direction: invalidate readiness when either supervised component exits or
starts, or bind readiness to a process generation. Require a readiness check
newer than the replacement before restoring READY and allowing selection. Add
a regression test where the old WDA status is healthy, iproxy exits, the
replacement becomes stable, and selection remains blocked until a new status
check succeeds.

### P1 — Persisted bridge name bypasses active-member validation

Location: desktop/hostEnvironment.js:275-284.

bridgeCandidates contains bridges proven active with a member, but
savedBridgePresent checks only whether the saved bridgeN interface exists.
After Internet Sharing changes or a reboot, an inactive or repurposed bridge
can therefore be exported as SHARED_BRIDGE_IFACE and reported as ready.

Fix direction: accept a saved interface only when it is present in
bridgeCandidates. Otherwise fail preflight and require explicit bridge
selection again. Add tests for an existing but inactive saved bridge and an
existing bridge with no member.

### P2 — PostgreSQL backend still trims proxy usernames

Location: system/server/src/db/repositories/postgresProxyPoolRepository.js:107.

The file backend now preserves provider username bytes exactly, but the
PostgreSQL repository still inserts fields.username.trim(). Switching storage
backends can alter country/session syntax or permitted whitespace and make a
tested proxy fail after saving.

Fix direction: remove the PostgreSQL trim and add the exact-byte username
regression to the PostgreSQL repository test. The PostgreSQL suite was skipped
in this review because TEST_DATABASE_URL is not configured.

## What the current code proves locally

- HTTP Basic authentication preserves the supplied username and password.
- HTTPS proxy transport opens TLS to the proxy.
- SOCKS5 uses UTF-8 byte lengths, rejects methods it did not offer, and maps
  CONNECT reply 2 to P109 rather than P107.
- Public responses, diagnostics, and audit data do not expose tested
  credentials.
- Supervised replacement waits for the old process to exit, and a detach
  cancels a deferred replacement.

## Still requires Mac, iPhone, or provider evidence

- Verify the selected macOS Internet Sharing bridge across toggles and reboot.
- Verify the installed iproxy accepts the two mappings and reports useful
  stderr when it exits.
- Connect a real phone and exercise WDA/iproxy recovery without manual Retry.
- Test the real HTTP, HTTPS, and SOCKS5 provider credentials.
- Verify device-originated IPv4, IPv6, DNS, and WebRTC behavior, including
  fail-closed behavior and recovery.

## Existing validation

- Server: 211 files, 1,610 tests; 1,578 passed, 0 failed, 32 PostgreSQL/Redis
  skips.
- Desktop: 192 passed, 0 failed.
- Focused proxy/routing/process/WDA checks: 101 server and 21 desktop tests
  passed.
- git diff --check passed.
