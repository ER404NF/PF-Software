# Phone Farm code and runtime ownership map

This map describes the active implementation after the device-reliability and network-diagnostics audit. Runtime identifiers such as a USB `enX`, USB IPv4 address, `utunX`, TUN peer, and process ID are observations, never durable device identity. The logical device ID derived from the iPhone UDID is the stable local identity.

## Executable entry points

| Entry point | Owns | Starts/calls | External processes | Persistent state |
| --- | --- | --- | --- | --- |
| `system/server/src/index.js` | Main HTTP/WebSocket control plane, session/auth middleware, live device registry, device summaries, human ownership, task queue wiring, network routes | Device registry, provisioning boot, WDA readiness loop, proxy pool, network verifier, routing orchestrator, auto network enrollment | Indirectly owns WDA, iproxy, tun2proxy and PF work through injected managers | Sessions, audit, queue, assignments, proxy pool, USB mapping, research and account stores |
| `system/server/src/agentMain.js` | Remote site-agent process | Device registry, discovery, automatic provisioning, `SiteAgent` | WDA and iproxy through `DeviceProvisioner` | Site-agent configuration plus provisioning state |
| `desktop/main.js` | Electron lifecycle and first-run/host setup | Host prerequisite checks, managed WDA copy, local server/site agent supervision, diagnostics window | Node server or site-agent child | Electron user-data settings, logs, copied WDA checkout |
| `BUILD_PHONE_FARM_INSTALLER.mjs` | Developer build gate | Locked installs, full server tests, desktop tests, platform installer build | npm/electron-builder | Build output under `desktop/dist/` |

## Authoritative state owners

| State | Authority | Persistence | Consumers |
| --- | --- | --- | --- |
| Stable local device identity | `discoveredDeviceId()` in `deviceDiscovery.js` | `device-provisioning.json` records the UDID-to-logical-ID association | Provisioner, live registry, UI |
| Physical USB attachment | `DeviceProvisioner.pollOnce()` discovery result for automatically provisioned phones | None; rediscovered | Provisioner and device summary |
| WDA process lifecycle | `WdaProcessManager` -> `SupervisedProcessGroup` | None; log ring only | Provisioner/recovery diagnostics |
| iproxy lifecycle | `IProxyManager` -> `SupervisedProcessGroup` | None; log ring only | Provisioner/recovery diagnostics |
| WDA endpoint/session | `WdaDevice` | None | Readiness loop and Device API |
| Component and control health exposed to users | `WdaDevice.componentHealth` plus readiness evidence; legacy `device.status` remains for protocol compatibility | None | Fleet summaries, error cards, diagnostics API and browser UI |
| Human input ownership | `humanOwners` and `deviceLease.js` in the server process | None; reconciled on disconnect/restart | WebSocket handlers, queue, UI |
| Per-device interaction failure count | `deviceHealth` in `index.js` | None | Device summaries and human input path |
| Proxy definitions and exclusive leases | `proxyPool.js` | `storage/proxy-pool.json` or `PROXY_POOL_STORE_PATH` | Admin API, route setup, fleet summary |
| USB interface and private IP mapping | `usbNetworkStore.js` | `storage/usb-network.json` or override | Enrollment, routing, fleet summary |
| Active TUN/PF route state | `NetworkRoutingOrchestrator.routes` | None; must be rediscovered/rebuilt after restart | Routing API and fleet summary |
| Network verification result | `networkVerifier` in-memory status map | None | Network policy, task admission, fleet summary |
| Desired network policy | `deviceNetworkConfig.js` plus `deviceNetworkStore.js` | Device config / configured store | Network verifier and fail-closed policy |
| Desktop child supervision | `desktop/main.js` with `serverSupervisor.js` policy | Recent log file and desktop settings | Desktop status/diagnostics UI |

`device.status` remains a compatibility field with several writers. New diagnosis and UI decisions use attachment, WDA process, iproxy, WDA endpoint, control, recovery, routing and network-verification states so a forwarding fault is not presented as a physical disconnect.

## Device-control dependency map

```text
physical iPhone
  -> idevice_id / ideviceinfo
     -> deviceDiscovery.discoverIosDevices()
        -> DeviceProvisioner.pollOnce()
           -> WdaProcessManager
              -> SupervisedProcessGroup
                 -> xcodebuild WebDriverAgentRunner
           -> IProxyManager
              -> SupervisedProcessGroup
                 -> iproxy -u <UDID> local:8100 local:9100
           -> WdaDevice in the shared devices Map
              -> HTTP /status and session/action endpoints
              -> MJPEG stream on the forwarded 9100 port
                 -> StreamHub
        -> index.js summaries, HTTP routes and WebSocket protocol
           -> system/client/app.js + liveViewController.js + phoneStage.js
```

### Device-control module ownership

| Module | Owns and is called by | Calls/state/processes | Current errors and hidden errors | Dependent surfaces and tests |
| --- | --- | --- | --- | --- |
| `deviceDiscovery.js` | Device enumeration; called at server startup, by `DeviceProvisioner`, `AutoNetworkEnrollment`, and the site agent | Synchronous `idevice_id` and `ideviceinfo`; no state | `discoverIosDevicesResult()` distinguishes a command failure (`D102`) from a successful empty device list. The legacy array wrapper remains for compatible callers. | Fleet discovery; `deviceDiscovery.test.js` |
| `deviceProvisioningStore.js` | Stable provisioning allocation; called only by `DeviceProvisioner` | Atomic temp-file/rename store containing UDID, logical ID, local ports and derived-data path | Corrupt JSON is surfaced. It persists some transient allocations deliberately, but not process health. | Automatic setup; `deviceProvisioningStore.test.js` |
| `provisioningBoot.js` | Composition root for automatic setup; called by server and site-agent entry points | Host preflight, managers, provisioner | Startup/preflight failures are logged and represented only as `null`; there is no structured device error because no device runtime may exist yet. | Desktop/site startup; `provisioningBoot.test.js` |
| `deviceProvisioner.js` | Attachment reconciliation, per-device WDA/iproxy startup and endpoint recovery; called by provisioning boot and retry API | Runtime map by UDID; starts/stops WDA and iproxy; writes provisioning store | Retains runtimes across `D102`, classifies manual prerequisites as `W205`, restarts iproxy first and WDA second, and stops after a bounded recovery budget. | Fleet setup banners, component health and Retry Automatic Setup; `deviceProvisioner.test.js` |
| `processSupervisor.js` | Generic per-key child lifecycle; used by WDA, iproxy and tun2proxy managers | Child, log ring, restart counter, stability timer and restart timer | Resets an old restart budget after a configurable stable run; exhaustion remains visible until an explicit recovery. | All managed child processes; `processSupervisor.test.js`, `tunManager.test.js` |
| `wdaProcessManager.js` | One WDA/xcodebuild process per UDID; called by provisioner | `xcodebuild` argv, signing and derived-data path | Exposes supervisor status and redacted log state through the manager. | Provisioning; `wdaProcessManager.test.js` |
| `iproxyManager.js` | One scoped USB forwarding process per UDID; called by provisioner | `iproxy -u` forwarding control and MJPEG ports | Exposes supervisor status; an alive process with a failed endpoint is handled by the provisioner's forwarding-first recovery. | Provisioning; `iproxyManager.test.js` |
| `wdaDevice.js` | Deterministic Device API adapter, readiness evidence, component health and WDA session cache | `/status`, WDA session/actions/source/screenshot/window size and MJPEG connection; runtime session/window cache | Classifies timeout vs endpoint failure. One failure is `SUSPECT`, repeated failures become `DEGRADED`/`FAILED`, and success clears the failure evidence. | Device control, screenshots/live stream, readiness loop; `wdaDevice.test.js`, `wdaStream.test.js`, `wsProtocol.test.js` |
| `deviceRegistry.js` | Initial adapter construction; called by server/site entry points | Creates mock/WDA/unconfigured devices | It does not own ongoing discovery or health. | Server device map; `deviceRegistry.test.js` |
| `index.js` device layer | Fleet summary, current health counters, human ownership, readiness timer, diagnostics and API/WS authorization | Calls every device primitive and WDA readiness check; owns `deviceHealth` and `humanOwners` | Publishes component snapshots and a device-scoped admin diagnostics route while retaining the legacy public status field. | `/api/devices`, diagnostics/retry routes, WebSocket selection/input/stream; integration suites |
| `streamHub.js` | One upstream stream per device with viewer fan-out | Calls `device.openStream()`; owns source/viewer state | Reports stream state only; it must not be interpreted as attachment or control readiness. | Live-view UI/site relay; `streamHub.test.js`, `wsStream.test.js` |

### Original random-disconnect path

1. The main server calls `refreshWdaReadiness()` immediately and every 10 seconds.
2. It calls `WdaDevice.checkReadiness()` for each local WDA device that is not marked `in-use`.
3. A single timeout, refused connection, non-2xx response, invalid JSON, or `ready: false` response is caught without classification.
4. `WdaDevice` immediately sets `readiness.ready = false` and `status = "offline"`.
5. The fleet broadcast makes the browser show the whole phone as offline even though USB, xcodebuild and iproxy may still be healthy.
6. The readiness loop does not inspect the WDA or iproxy supervisors and does not attempt layer-specific recovery.
7. Retry Automatic Setup works because `DeviceProvisioner.retry()` forcibly stops and starts both WDA and iproxy, clearing either a dead process, broken forwarding path, or unresponsive WDA endpoint. It also resets the public setup state, but it cannot explain which layer failed.

### Current readiness and recovery path

1. `/status` success records `HEALTHY`; the first failure records `SUSPECT` and preserves a previously usable phone.
2. Repeated failures cross `DEGRADED` and then `FAILED` with `W201` or `W204` evidence.
3. The provisioner reconciles physical attachment and process-manager state. If the phone, WDA and iproxy processes remain present, it restarts iproxy only.
4. If the endpoint still fails after forwarding recovery, it restarts WDA only.
5. After two layer-specific attempts it records `R201` and leaves manual Retry as the fallback.
6. Discovery-command failure records `D102` and retains known devices; only a successful poll that omits a UDID records `D101`.
7. A process that remains stable for the configured period receives a fresh restart allowance.

## Network/proxy dependency map

```text
physical iPhone
  -> macOS Internet Sharing
     -> bridge membership
        -> usbNetworkMapper (unambiguous before/after assignment)
           -> usbNetworkStore (logical device -> transient enX)
              -> usbIpDiscovery (tcpdump evidence -> private IPv4)
                 -> proxyPool (exclusive saved proxy lease)
                    -> NetworkRoutingOrchestrator
                       -> TunManager
                          -> SupervisedProcessGroup
                             -> sudo -n tun2proxy --tun <utunX> --proxy <secret URL>
                       -> tunManager.discoverTunPeer()
                       -> pfRuleGenerator
                          -> PrivilegedOps test/load private PF anchor
                       -> periodic process/PF-rule health check
                          -> route state in fleet summary

desired network config
  -> NetworkVerifier -> configured check URL
     -> observed IP/IPv6/region/DNS/proxy-health fields
        -> networkPolicy fail-closed admission
           -> queue and human-control availability
```

### Network module ownership

| Module | Owns and is called by | Calls/state/processes | Current errors and hidden errors | Dependent surfaces and tests |
| --- | --- | --- | --- | --- |
| `internetSharingManager.js` | Best-effort macOS Internet Sharing toggle; called from server startup | PlistBuddy and launchctl via `sudo -n` | Apple provides no supported API; success does not prove bridge operation. Caller currently logs failure rather than publishing a structured system/device error. | Host startup; `internetSharingManager.test.js` |
| `usbNetworkMapper.js` | Bridge member parsing and unambiguous diff | `ifconfig`; no state | Correctly refuses zero/multiple candidates. OS errors are plain strings. | Enrollment APIs/automation; `usbNetworkMapper.test.js`, routing route tests |
| `usbIpDiscovery.js` | Evidence-based phone IPv4 discovery | `sudo -n tcpdump`; no state | Correctly avoids guessing. Capture, privilege and no-traffic errors are not yet catalogued. | Enrollment APIs/automation; `usbIpDiscovery.test.js` |
| `usbNetworkStore.js` | Last known interface/IP mapping by logical device | Atomic JSON store | Interface and IP are transient cached observations. Enrollment validates bridge membership, clears stale mappings, and relearns the IP before routing. | Fleet summary/routing; `usbNetworkStore.test.js` |
| `autoNetworkEnrollment.js` | Background enrollment/IP discovery, transient-map validation and optional route start | Structured discovery, bridge mapper, capture, stores, proxy pool, injected route start | Preserves state on discovery-command failure, invalidates vanished interfaces, clears mappings on real detach and requires a fresh traffic-derived IP. | Fleet routing panel; `autoNetworkEnrollment.test.js` |
| `proxyPool.js` | Proxy definitions, encrypted passwords, safe health metadata and exclusive per-device leases | Atomic JSON store, credential crypto | Validates shape/exclusivity and persists only safe proxy-test results; secrets never enter public records. | Proxy admin API and picker; `proxyPool.test.js`, `proxyPoolRoutes.test.js` |
| `proxyProvider.js` | Abstract provider-health contract | No configured implementation by default | Not connected to saved pool proxy testing. | Future provider integration; `proxyProvider.test.js` |
| `tunManager.js` | One tun2proxy child per device | `sudo -n tun2proxy`; `ifconfig`; supervisor | Redacts credentials and exposes supervisor state for route reconciliation. | Routing orchestrator; `tunManager.test.js` |
| `pfRuleGenerator.js` | Full desired private-anchor ruleset and counter parsing | Pure validation/generation | Blocks IPv6 on the bridge and avoids incremental edits. Counter presence is not end-to-end egress proof. | Routing orchestrator; `pfRuleGenerator.test.js` |
| `privilegedOps.js` | Syntax check, private-anchor load/inspect/clear and per-IP state clear | `sudo -n pfctl` and secure temporary files | Returns sanitized bounded stderr but uses uncatalogued strings. | Routing orchestrator; `privilegedOps.test.js` |
| `networkRoutingOrchestrator.js` | In-memory route state machine, per-device fail-closed PF state and serialized recovery | Proxy pool, tun manager, TUN discovery, PF generator/ops | A lost tunnel/rule installs a device-specific block and schedules at most two isolated rebuild attempts. A routed state remains unprotected until egress verification passes. | Admin routing routes, diagnostics and fleet panel; `networkRoutingOrchestrator.test.js`, `routingRoutes.test.js` |
| `networkCheckTarget.js` | Explicit device-originated verification-target selection and SSRF boundary | Config URL in production | Still owns configured end-to-end targets. When absent, the API now runs an automatic proxy/host-route check rather than returning the old configuration error. | Network-check API; `networkCheckTarget.test.js`, route tests |
| `proxyTester.js` | Progressive saved/unsaved proxy validation | DNS, TCP/TLS, SOCKS5 or HTTP CONNECT/authentication, HTTPS egress providers | Classifies `P101`-`P111`, supports configurable/fallback providers and returns only safe observed health. | Proxy test APIs/UI; `proxyTester.test.js` |
| `networkVerifier.js` | End-to-end egress observation, infrastructure-check status and cross-device collision detection | Configured device-originated URL or safe proxy-test results; in-memory status/events | Only a configured end-to-end device probe can set `PROTECTED`; proxy and host-route health stop at `VERIFYING`. | Network policy/UI; verifier integration tests |
| `networkPolicy.js` | Fail-closed control/task admission from desired config and recent verifier status | No state | Applies only to configured device-network policy. A route marked `routed` is not equivalent to `PROTECTED`. | Human selection and queue; `networkPolicy.test.js`, network route tests |

## Desktop host and UI flow

```text
Electron desktop/main.js
  -> hostEnvironment.resolveMacHostDependencies()
     -> Xcode, idevice tools, iproxy, WDA source/signing, optional tun2proxy
  -> first-run setup / hostFixes
  -> buildHostEnvironment()
  -> spawn server/src/index.js or server/src/agentMain.js
  -> serverSupervisor restart policy
  -> diagnostics log/report
  -> BrowserWindow loads the local relay or configured hub
```

| Module | Responsibility | Errors/state/UI/tests |
| --- | --- | --- |
| `desktop/hostEnvironment.js` | Discovers binaries, WDA source/signing and constructs the child environment | Produces per-check setup status. Covered by `hostEnvironment.test.js`. |
| `desktop/hostFixes.js` | Bounded one-click Xcode and Homebrew fixes | Serializes fixes and returns user-readable messages. Covered by `hostFixes.test.js`. |
| `desktop/serverSupervisor.js` | Restart budget for the server child | Has a time-window stability reset, unlike the server's generic per-device supervisor. Covered by `supervisionAndDiagnostics.test.js`. |
| `desktop/diagnostics.js` | Redacted rotating host log and copyable report | Owns desktop diagnostic persistence and redaction. Covered by `supervisionAndDiagnostics.test.js`. |
| `desktop/main.js` | Window, setup workflow, server/agent spawn, restart and menus | Feeds first-run UI and the normal web client. Covered by lifecycle, first-run and packaging tests. |
| `system/client/app.js` | Role-aware fleet/admin UI, WebSocket protocol, device cards, component/system health and network controls | Renders six component states, structured stable-code error cards, role-capability Retry/Diagnostics actions, proxy tests and end-to-end verification state. Covered by client boundary/role tests and integration protocol tests. |
| `system/client/liveViewController.js` / `phoneStage.js` | Stream scheduling, fallback frame mode and coordinate mapping | Depend on server stream/action receipts; do not own device health. Covered by unit boundary tests and stream integration tests. |

## Persistence boundaries

- Persistent identity/configuration: device config, provisioning records, proxy definitions/leases, assignments, operator grants, desired network config, audit, queue and research state.
- Runtime-only and rediscovered: USB attachment, `enX`, USB IPv4 validity, WDA/iproxy/tun2proxy PIDs, `utunX`, TUN peer, PF anchor contents, WDA session, readiness counters, active ownership and verification freshness.
- Persisted interface/IP fields in `usb-network.json` are cached observations. They must be validated before rebuilding a route and cleared/relearned when attachment/topology changes.

## Existing test ownership

- Device discovery/provisioning/processes: `deviceDiscovery.test.js`, `deviceProvisioner.test.js`, `deviceProvisioningStore.test.js`, `provisioningBoot.test.js`, `processSupervisor.test.js`, `wdaProcessManager.test.js`, `iproxyManager.test.js`, `wdaDevice.test.js`.
- Device control and UI protocol: `wsProtocol.test.js`, `wsStream.test.js`, `wdaStream.test.js`, `clientBoundaries.test.js`, `clientRoleUi.test.js`.
- Network mapping/routing: `autoNetworkEnrollment.test.js`, `usbNetworkMapper.test.js`, `usbIpDiscovery.test.js`, `usbNetworkStore.test.js`, `tunManager.test.js`, `pfRuleGenerator.test.js`, `privilegedOps.test.js`, `networkRoutingOrchestrator.test.js`, `routingRoutes.test.js`.
- Proxy and verification: `proxyPool.test.js`, `proxyPoolRoutes.test.js`, `proxyProvider.test.js`, `networkCheckTarget.test.js`, `networkVerifier.test.js`, `networkCheckRoute.test.js`, `networkPolicy.test.js`.
- Desktop host/build: `hostEnvironment.test.js`, `hostFixes.test.js`, `supervisionAndDiagnostics.test.js`, lifecycle/first-run tests, packaged-runtime checks and workflow tests.

## Resolved audit findings and remaining acceptance boundary

The implementation now applies readiness hysteresis, keeps structured WDA failure evidence, distinguishes discovery failure from a true detach, refreshes restart budgets after stable operation, publishes per-component health, performs bounded layer-specific recovery, tests proxies progressively, provides fallback infrastructure checks, reserves `PROTECTED` for a device-originated egress result, blocks and rebuilds lost routes, revalidates transient USB mappings, uses a stable error catalog, and renders component/fleet diagnostics.

`index.js` remains the composition and API boundary. The existing device registry, proxy pool, USB observation store and routing orchestrator remain the respective state authorities; no parallel stores were added.

Physical Mac/iPhone acceptance is still required for WDA signing and launch, actual USB interface discovery, PF packet flow, live proxy egress, IPv6/DNS behavior, fault injection and two-phone isolation. Local fixtures and process doubles cannot prove those properties.
