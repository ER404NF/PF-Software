# Device reliability, proxy routing and diagnostics final report

Date: 2026-09-21

This report describes the current local working tree. It separates verified source/test behavior from Mac, iPhone, PF, tun2proxy and live-provider acceptance that still requires physical hardware.

## 1. Repository architecture map

The detailed module-by-module ownership map is in [CODE_SYSTEM_MAP.md](CODE_SYSTEM_MAP.md). The main composition root is `system/server/src/index.js`; it wires the shared device registry, automatic provisioning, process managers, proxy pool, USB observations, route orchestration, network verification, task queue, HTTP APIs and WebSocket control plane. `desktop/main.js` owns Electron and child-server lifecycle. Browser behavior is owned by `system/client/app.js` and its focused live-view/input modules.

Persistent authorities remain singular: provisioning records own stable device allocations, the proxy pool owns proxy definitions and leases, the USB network store holds cached observations, device-network configuration owns desired policy, and the queue/research stores own work. WDA, iproxy, tun2proxy, PF rules, attachment, WDA sessions, component health and verification freshness are runtime state and are reconciled after restart.

## 2. Device-control dependency map

```text
iPhone -> idevice discovery -> DeviceProvisioner
       -> WdaProcessManager -> SupervisedProcessGroup -> xcodebuild/WDA
       -> IProxyManager     -> SupervisedProcessGroup -> iproxy
       -> WdaDevice -> registry -> HTTP/WebSocket -> browser UI
```

`DeviceProvisioner` is the per-device runtime reconciler. `WdaDevice` owns endpoint readiness and device actions. The process managers own their child processes through `SupervisedProcessGroup`. A discovery command failure is distinct from a successful poll with no phone. The browser receives component health and structured diagnostics rather than deriving physical attachment from one WDA request.

## 3. Network/proxy dependency map

```text
iPhone -> macOS Internet Sharing -> bridge member discovery
       -> USB interface/IP observation -> exclusive proxy lease
       -> tun2proxy -> runtime TUN peer -> private PF anchor
       -> device-originated egress verification -> network policy -> UI
```

Runtime interface names, USB addresses, TUN names and peers are discovered. `NetworkRoutingOrchestrator` owns active routes and fail-closed PF blocks. `NetworkVerifier` owns egress evidence. A healthy proxy and host-side route produce `VERIFYING`; only a successful configured device-originated probe produces `PROTECTED`.

## 4. Original random-disconnect behavior

The server runs WDA readiness checks every 10 seconds (`refreshWdaReadiness`, `system/server/src/index.js:2790-2797`). Previously, one timeout, refused connection, bad HTTP response, invalid JSON response, or `ready: false` result made `WdaDevice.checkReadiness()` set the whole device to `offline`. The UI therefore reported a disconnected phone even when USB attachment, xcodebuild and iproxy were still healthy.

The readiness loop did not use the existing interaction-failure hysteresis and did not identify the failed component. Independently, a failure of the `idevice_id` discovery command was represented as an empty list and could be mistaken for every phone being unplugged. Ancient supervisor failures also accumulated permanently until their restart limit was exhausted.

## 5. Exact root causes found

### Defect 1

Error Name: Transient WDA failure was treated as a physical disconnect

`checkReadiness(), lines 107-185 | system/server/src/wdaDevice.js`

Why it is happening: The old catch path converted one endpoint failure directly into `offline` and discarded whether USB, WDA or iproxy remained healthy.

How to fix: The readiness state now records classified evidence and transitions through `SUSPECT`, `DEGRADED` and `FAILED`. A single failure preserves a previously usable phone; repeated evidence triggers recovery.

Error Code: W201 or W204

### Defect 2

Error Name: Discovery failure looked like every iPhone was unplugged

`discoverIosDevicesResult(), lines 16-53 | system/server/src/deviceDiscovery.js`

Why it is happening: The old array-only contract returned `[]` for both a valid zero-device result and a failed discovery command.

How to fix: Structured discovery returns `{ ok, devices, error }`. Reconciliation retains known runtimes on D102 and detaches only after a successful discovery poll omits the UDID.

Error Code: D102

### Defect 3

Error Name: Old process crashes exhausted future recovery

`SupervisedProcessGroup, lines 9-83 | system/server/src/processSupervisor.js`

Why it is happening: Restart counts never reset after a long healthy run, so unrelated old failures could permanently consume the retry budget.

How to fix: A configurable stable-run timer resets the old count and emits a stable event. Deliberate stops clean up both stability and restart timers.

Error Code: W203, I203 or T207

### Defect 4

Error Name: Recovery restarted more layers than necessary

`_recoverEndpoint(), lines 255-298 | system/server/src/deviceProvisioner.js`

Why it is happening: The only reliable recovery was the manual retry, which stopped and restarted both WDA and iproxy regardless of the failed layer.

How to fix: Bounded automatic recovery restarts iproxy first for an unavailable forwarded endpoint, rechecks it, then restarts WDA only if needed. Each phone has an independent budget and cooldown.

Error Code: I202 or R201

### Defect 5

Error Name: Manual WDA prerequisites could enter a useless restart loop

`_onProcessExit(), lines 301-353 | system/server/src/deviceProvisioner.js`

Why it is happening: Trust, Developer Mode, certificate and signing failures cannot be repaired by repeating the same launch.

How to fix: Known prerequisite failures pause automatic restarts, stop device forwarding, publish the required operator action and wait for explicit Retry Automatic Setup.

Error Code: W205

### Defect 6

Error Name: Saved proxies had no progressive connectivity test

`validateProxyForTest(), lines 26-53; probeProxy(), lines 223-252; testProxy(), lines 254-316 | system/server/src/proxyTester.js`

Why it is happening: A proxy could be stored and assigned without distinguishing hostname, DNS, port, timeout, protocol, authentication, external request or country failures.

How to fix: Proxy tests now progress through field validation, DNS, connection/TLS, SOCKS5 or HTTP CONNECT authentication, external HTTPS egress, IP/country and latency. Only safe health metadata is persisted.

Error Code: P101-P111

### Defect 7

Error Name: Missing verification configuration blocked useful diagnosis

`POST /api/devices/:deviceId/network-check, lines 1669-1756 | system/server/src/index.js`

Why it is happening: Without a manually configured check URL, the route returned “Network verification endpoint is not configured” even when a saved proxy could be tested automatically.

How to fix: The route tests the assigned proxy using configurable providers with safe built-in fallbacks and records infrastructure health. It remains `VERIFYING` until a device-originated probe succeeds.

Error Code: P111 or V201

### Defect 8

Error Name: A live tunnel and PF rule could be mistaken for protected egress

`recordInfrastructureCheck(), lines 187-215 | system/server/src/networkVerifier.js`

Why it is happening: Host process/rule presence does not prove that phone traffic exits through the intended proxy.

How to fix: Infrastructure checks cannot set `PROTECTED`. Only the configured end-to-end device request can do so; mismatched egress, shared egress across distinct assignments or unexpected IPv6 fails verification.

Error Code: V202, V203 or V204

### Defect 9

Error Name: Route loss did not fail closed or self-heal

`checkHealth(), lines 320-387; quarantineRoute(), lines 389-410 | system/server/src/networkRoutingOrchestrator.js`

Why it is happening: A dead tunnel or missing PF rule was observable but did not install an explicit device-specific block before recovery.

How to fix: The orchestrator regenerates its private anchor with the affected USB IP blocked, stops the affected tunnel and attempts at most two isolated rebuilds. Other phones keep their routes.

Error Code: T206, F203, T207 or V204

### Defect 10

Error Name: Persisted USB observations could become stale

`tick(), lines 81-203 | system/server/src/autoNetworkEnrollment.js`

Why it is happening: Interface names and USB IPs are runtime topology observations but could survive restart or replug in storage.

How to fix: Enrollment verifies bridge membership, clears vanished mappings, resets cached IPs and requires fresh traffic-derived address evidence. A discovery-command failure preserves the last record because it is not detach evidence.

Error Code: N201, N202 or N203

### Defect 11

Error Name: Operators could not identify the failed component

`device summary, lines 1477-1517; diagnostics route, lines 1532-1551 | system/server/src/index.js`

Why it is happening: The legacy device status compressed attachment, WDA, forwarding, control and network health into one label.

How to fix: Summaries expose component health, route health, verification state and bounded diagnostic events. Admin diagnostics return safe process/component evidence without credentials or raw UDIDs.

Error Code: The current component-specific code

### Defect 12

Error Name: UI errors lacked evidence and recovery guidance

`deviceComponentRows(), lines 2344-2360; buildDeviceErrorCard(), lines 2412-2468 | system/client/app.js`

Why it is happening: Free-form status text did not consistently answer what failed, where it failed, what recovery ran, or what the operator should do.

How to fix: Device cards show Device, Control, WDA, iproxy, Network and Proxy states plus Error Name, Location, Why, How to fix, Error Code and Safe state. Retry and Diagnostics appear only for authorized roles.

Error Code: The current component-specific code

## 6. Why Retry Automatic Setup restored the phone

`DeviceProvisioner.retry()` (`system/server/src/deviceProvisioner.js:376-393`) deliberately stops and restarts both per-phone processes. It therefore repaired either a dead/unresponsive WDA process or a failed iproxy forwarding path, even though the former UI could not say which one failed. It also reset the setup banner and recovery state. It did not prove a USB disconnect and did not repair proxy routing directly.

Manual retry remains available as a fallback. The UI states that it restarts WebDriverAgent and USB forwarding while preserving proxy assignment, operator assignment, device identity and audit history.

## 7. Changes preventing unnecessary disconnects

- Readiness hysteresis preserves control after one transient WDA failure and fully clears evidence after success.
- Structured discovery separates D102 command failure from D101 physical detach.
- Component health separates attachment, WDA process, iproxy, endpoint, control and recovery.
- Supervisors reset old failure budgets after stable operation.
- Provisioning chooses iproxy-first or WDA-only recovery with bounded retries.
- Manual prerequisites stop automatic loops and give a concrete operator action.
- Replug reuses stable logical identity and allocations while rediscovering runtime networking.
- Phone A recovery never restarts Phone B.

## 8. Automatic recovery state machine

```text
HEALTHY
  -> first endpoint failure: SUSPECT (retain prior usable device)
  -> next success: HEALTHY and clear evidence
  -> repeated failure: DEGRADED/FAILED
       -> phone absent after successful discovery: DISCONNECTED, stop its processes
       -> discovery command failed: retain runtime, retry discovery
       -> iproxy/WDA present but endpoint absent: RECOVERING_IPROXY
       -> still absent: RECOVERING_WDA
       -> verified endpoint: HEALTHY
       -> bounded attempts exhausted: FAILED/R201, manual Retry available
       -> manual trust/signing/developer-mode prerequisite: USER_ACTION_REQUIRED/W205
```

Network recovery independently follows `ROUTED -> route evidence lost -> install per-device PF block -> stop failed tunnel -> bounded isolated rebuild -> VERIFYING -> configured device-origin probe -> PROTECTED`. Exhaustion remains fail closed.

## 9. Complete stable error-code catalog

The definitions and structured payload builder are in `system/server/src/errorCatalog.js:1-180`.

| Code | Name | Component |
| --- | --- | --- |
| D101 | Physical iPhone disconnected | Device discovery |
| D102 | iPhone discovery temporarily unavailable | Device discovery |
| W201 | WDA health check timed out | WDA endpoint |
| W202 | WDA process exited | WDA process |
| W203 | WDA failed to start after repeated attempts | WDA process |
| W204 | WDA endpoint unavailable | WDA endpoint |
| W205 | WDA requires an action on the iPhone | WDA process |
| I201 | iproxy process stopped | iproxy |
| I202 | WDA forwarding unavailable | iproxy |
| I203 | iproxy failed to start after repeated attempts | iproxy |
| R201 | Automatic device recovery exhausted | Device reconciler |
| P101 | Proxy hostname invalid | Proxy test |
| P102 | Proxy DNS resolution failed | Proxy test |
| P103 | Proxy port unreachable | Proxy test |
| P104 | Proxy connection refused | Proxy test |
| P105 | Proxy connection timed out | Proxy test |
| P106 | Proxy protocol mismatch | Proxy test |
| P107 | Proxy authentication rejected | Proxy test |
| P108 | Malformed proxy configuration | Proxy test |
| P109 | Proxy connected but Internet request failed | Proxy test |
| P110 | Unexpected proxy country | Proxy test |
| P111 | Proxy test service unavailable | Proxy test |
| N201 | USB network interface could not be identified | USB network |
| N202 | USB network address unavailable | USB network |
| N203 | Stored USB network mapping is stale | USB network |
| T201 | tun2proxy executable unavailable | Tunnel |
| T202 | Proxy tunnel failed to start | Tunnel |
| T203 | TUN interface was not created | Tunnel |
| T204 | TUN peer unavailable | Tunnel |
| T205 | Proxy authentication stopped the tunnel | Tunnel |
| T206 | Proxy tunnel exited unexpectedly | Tunnel |
| T207 | Proxy tunnel restart limit reached | Tunnel |
| F201 | PF syntax validation failed | PF |
| F202 | PF rules could not be loaded | PF |
| F203 | Expected device route missing | PF |
| F204 | Traffic is not matching the device route | PF |
| F205 | PF permission failure | PF |
| F206 | Stale PF state detected | PF |
| F207 | PF anchor unavailable | PF |
| V201 | Network verification failed | Network verification |
| V202 | Unexpected proxy exit IP | Network verification |
| V203 | Unexpected IPv6 route | Network verification |
| V204 | Protected network route lost | Network verification |

Each emitted diagnostic contains code, name, component, source file/function, severity, retryability, automatic recovery, operator action, safe state, public message, reason, timestamp and sanitized technical fields. Keys resembling passwords, secrets, tokens, credentials, authorization, cookies or UDIDs are removed.

## 10. Files changed

Application files:

- `system/client/app.js`
- `system/client/index.html`
- `system/client/style.css`
- `system/server/src/autoNetworkEnrollment.js`
- `system/server/src/deviceDiscovery.js`
- `system/server/src/deviceProvisioner.js`
- `system/server/src/index.js`
- `system/server/src/iproxyManager.js`
- `system/server/src/networkRoutingOrchestrator.js`
- `system/server/src/networkVerifier.js`
- `system/server/src/pfRuleGenerator.js`
- `system/server/src/processSupervisor.js`
- `system/server/src/provisioningBoot.js`
- `system/server/src/proxyPool.js`
- `system/server/src/tunManager.js`
- `system/server/src/usbNetworkStore.js`
- `system/server/src/wdaDevice.js`
- `system/server/src/wdaProcessManager.js`

Test files:

- `system/server/test/integration/networkCheckRoute.test.js`
- `system/server/test/integration/networkVerifier.test.js`
- `system/server/test/integration/proxyPoolRoutes.test.js`
- `system/server/test/integration/wdaDevice.test.js`
- `system/server/test/unit/autoNetworkEnrollment.test.js`
- `system/server/test/unit/clientRoleUi.test.js`
- `system/server/test/unit/deviceDiscovery.test.js`
- `system/server/test/unit/deviceProvisioner.test.js`
- `system/server/test/unit/networkRoutingOrchestrator.test.js`
- `system/server/test/unit/pfRuleGenerator.test.js`
- `system/server/test/unit/processSupervisor.test.js`
- `system/server/test/unit/proxyPool.test.js`

The pre-existing untracked `.claude/settings.local.json` was not changed or removed.

## 11. Files added

- `docs/CODE_SYSTEM_MAP.md`
- `docs/RELIABILITY_NETWORK_FINAL_REPORT.md`
- `system/server/src/errorCatalog.js`
- `system/server/src/proxyTester.js`
- `system/server/test/unit/proxyTester.test.js`

## 12. Tests added or expanded

- Single and repeated WDA failures, timeout classification and recovery.
- Discovery command failure versus true zero-device discovery.
- Stable-run supervisor budget reset.
- Per-phone provisioning, detach/replug, manual prerequisites, iproxy-first/WDA-second recovery, exhaustion and phone isolation.
- Stale USB interface/IP validation, detach/replug and bridge-inspection failure.
- Proxy validation, DNS, connection/protocol/authentication classification, provider fallback, country and safe persisted health.
- Proxy test API authentication, role gates and stable validation errors.
- PF fail-closed blocks and route/block conflicts.
- Tunnel/rule loss, isolated rebuild, bounded exhaustion and verification quarantine.
- Infrastructure verification remaining `VERIFYING`, configured end-to-end verification, egress collisions and diagnostic events for both phones.
- Client component health, structured errors, Test Proxy, Diagnostics and authorization gates.

The broader existing suite also exercises WDA/iproxy exit handling, exclusive proxy leases, PF syntax/load rollback, authorization and two-phone control boundaries.

## 13. Test results

- Full server suite, current final tree: **107 files, 1,142 tests, 1,142 passed, 0 failed, 0 skipped** (`npm.cmd test` from `system`).
- Desktop suite: **150/150 passed** (`npm.cmd test` from `desktop`). It was run after the desktop audit; no desktop files changed afterward.
- Focused post-quarantine network suite: **63/63 passed**.
- Focused final network-verifier suite: **11/11 passed**.
- Final `git diff --check`: passed. Added files were also checked separately for trailing whitespace.

These are local tests using fixtures, process doubles and browser/static checks. They are not physical-device or live-provider evidence.

## 14. Remaining uncertainties

- Whether the Mac's actual Internet Sharing bridge and phone USB interfaces behave identically to fixtures.
- Whether live tun2proxy creates the expected TUN peer under the installed macOS/network-extension version.
- Whether scoped `sudo -n` PF permissions and the private anchor are installed correctly.
- Whether live provider endpoints classify every vendor-specific authentication/protocol response as expected.
- Whether device-originated check traffic traverses PF and produces the expected distinct public IP, DNS and IPv6 result.
- PF counters are parsed and exposed, but counter growth needs traffic generated by a real phone. An idle zero counter is not automatically treated as failure.
- WDA signing, trust, Developer Mode, lock state and long-running stability remain host/device dependent.

## 15. Items requiring real Mac/iPhone testing

- WDA launch/signing and automatic recovery on each physical iPhone.
- Kill/restart behavior for each phone's iproxy and WDA process.
- Real detach/replug and stable logical identity.
- Bridge member and USB IPv4 discovery with one and two attached phones.
- Live proxy DNS, port, protocol, credentials, country and public-IP tests.
- tun2proxy/TUN creation, PF syntax/load/state and packet counters.
- Direct-fallback blocking when a tunnel or expected PF route disappears.
- Device-originated exit-IP, DNS and IPv6 verification.
- Phone 1 fault isolation while Phone 2 remains controllable and protected.

## 16. Exact US 1 and US 2 hardware acceptance procedure

Keep credentials local; do not paste them into chat, screenshots or diagnostics.

1. On the Mac, start PF-Software with automatic WDA provisioning, proxy-tunnel routing and network enrollment enabled. Confirm host preflight passes for Xcode, libimobiledevice, iproxy, WDA source/signing, tun2proxy and scoped PF privileges. Stop if a prerequisite reports W205, T201 or F205.
2. Connect and unlock Phone 1. Wait for Device `CONNECTED`, WDA `RUNNING`, iproxy `RUNNING` and Control `READY`. If interface enrollment is ambiguous, disconnect other newly added phones and enroll sequentially; never choose an interface by guess.
3. In Proxy Pool, create or open **US 1**, enter the provider-supplied SOCKS5 host, port, username, password and expected country `US`, then select **Test Proxy**. Require a healthy result with a public IPv4 and expected country. Stop on P101-P111 and correct the named field/service.
4. Assign US 1 to Phone 1. Wait for USB IP discovery, tunnel start and PF application. The network state should be `VERIFYING`, not `PROTECTED`, until device-originated verification passes.
5. Connect and unlock Phone 2. Repeat the component checks and sequential enrollment if needed.
6. Create/test **US 2** with its distinct local credentials, assign it to Phone 2 and confirm the server refuses to lease one saved proxy to both phones.
7. Generate traffic on both phones. Run **Network Check** for each. Require Phone 1 to show the expected US 1 public IPv4 and Phone 2 the expected US 2 public IPv4; require no unexpected shared exit between distinct assignments, expected DNS behavior, and no IPv6 when policy says blocked. Only then accept `PROTECTED`.
8. Inspect Diagnostics for both phones. Confirm each has its own USB interface/IP observation, tunnel, TUN peer, PF route/counter and verification history. Confirm no credential or raw UDID appears.
9. Enter a wrong US 1 password and retest. Require P107. Restore the password and require a passing proxy test.
10. Select a wrong US 1 protocol and retest. Require P106. Restore SOCKS5.
11. Kill Phone 1's tunnel. Require an immediate Phone 1 fail-closed block and bounded rebuild; Phone 2 must stay controllable/routed. Stop the acceptance test if Phone 1 obtains direct Internet during this interval.
12. Kill Phone 1's iproxy. Require per-phone iproxy recovery before WDA recovery; Phone 2 must not restart.
13. Interrupt one Phone 1 WDA health check. Require `SUSPECT`/degraded evidence without a permanent disconnect, followed by recovery. Repeat enough times to test the bounded escalation path.
14. Unplug Phone 1. Require D101 and `DISCONNECTED`; Phone 2 stays healthy. Replug Phone 1 and require rediscovery of runtime interface/IP, WDA/iproxy restoration, route rebuild and a fresh end-to-end check before `PROTECTED`.
15. Accept the hardware phase only after both phones remain independently controllable and show distinct expected verified egress throughout the healthy case.

## 17. Rollback instructions

1. Use **Stop routing** for each phone. This removes that phone from the desired private-anchor rules and stops its tunnel without flushing unrelated system PF configuration.
2. Release proxy assignments in the UI if they should not be retained. Proxy definitions and assignments are otherwise persistent by design.
3. Disable automatic network enrollment and proxy-tunnel routing in the host configuration, then restart PF-Software. Disable automatic WDA provisioning only if reverting that feature too.
4. Restore the previous source revision or working tree through the repository's normal Git workflow. There is no database migration in this change.
5. Start PF-Software and verify device control before re-enabling routing. If private-anchor cleanup previously failed, use the app's Stop routing/retry path after fixing the scoped PF privilege; do not flush the Mac's entire PF ruleset.

## Quality-gate status

All twelve requested invariants have local implementation and regression coverage: transient WDA failure hysteresis, per-phone iproxy/WDA recovery, actionable manual prerequisites, phone isolation, runtime identifier discovery, classified proxy errors, automatic infrastructure checks, strict `PROTECTED` semantics, fail-closed route loss, structured diagnostics and preserved two-iPhone control boundaries. Physical Mac/iPhone and live-proxy acceptance remains explicitly unverified until the procedure above is completed.
