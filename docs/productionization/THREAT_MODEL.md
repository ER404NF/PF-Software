# Production threat model

Status: **accepted M01 direction; revisit at every productionization milestone**
Date: **2026-09-25**

## Scope and assets

In scope: public/client surfaces, identity, cloud API/workers, data services, billing/email/AI/proxy integrations,
site enrollment/link, local Mac host, WDA/iproxy/routing, physical command execution, evidence/files, release/update
pipeline and administrative operations.

Primary assets:

- customer and membership boundaries;
- sessions, MFA/recovery and service identities;
- exclusive physical-device control;
- platform accounts and research evidence;
- proxy/network isolation and true device egress;
- task/approval/billing integrity;
- audit evidence;
- reusable secrets and signing identities;
- availability of independent sites/devices.

## Adversaries and failure sources

- unauthenticated Internet attacker;
- authenticated malicious or compromised tenant user;
- compromised browser/desktop/mobile client;
- compromised site credential or Mac host;
- malicious page/platform content attempting prompt injection;
- faulty or malicious AI/provider/vendor response;
- insider or over-privileged operator;
- supply-chain/release compromise;
- accidental misconfiguration, stale authorization, race or partial persistence;
- network, database, Redis, object-store, vendor, WDA or device failure.

Physical theft and fully compromised administrator/root endpoints cannot be eliminated by application controls, but
the design must limit credential reuse, tenant blast radius and silent persistence.

## Threats and required controls

| Threat | Impact | Required controls | Acceptance evidence |
| --- | --- | --- | --- |
| Credential stuffing/brute force | Account takeover | MFA, distributed rate limits, breached-password policy where approved, security events | repeated distributed attempts throttle without blocking unrelated tenants |
| Session/recovery theft | Account takeover | secure cookies/storage, hash reusable tokens, rotation/revocation, expiry, no URL credentials | stolen old token fails after rotation/revocation |
| Client-supplied tenant ID | Cross-tenant access | derive tenant from membership; application authorization + RLS + composite FKs | Org A negative CRUD/reference/object/cache tests |
| Stale role/grant after login | Privilege retention | re-resolve current membership/auth version on sensitive operations and sockets | demotion/removal takes effect on existing connections |
| IDOR/file-key guessing | Data disclosure | exact resource authorization, opaque keys, short-lived signed object operations | knowing another key never grants access |
| Device lease race | Concurrent physical input | transactional single active lease, generation token, final site-side recheck | 100 concurrent claims yield one lease; stale generation cannot act |
| Lost acknowledgement | Duplicate visible action | idempotency key, applied/failed/uncertain states, reconciliation before retry | timeout does not blindly repeat tap/comment/payment |
| Site impersonation/replay | Unauthorized phone control | rotatable service identity, TLS, expiry/nonce/idempotency, site/device binding | revoked/replayed command rejected |
| Generic remote execution | Host takeover | typed allow-list protocol, argument arrays, no shell endpoint | unknown method rejected before local execution |
| WDA/phone failure crossing devices | Fleet outage | per-device process/tunnel/state isolation and bounded recovery | Phone A failure leaves Phone B operational |
| Proxy fail-open | Public-IP exposure | deny external path until device-originated verification; PF kill rules; expiry/recheck | process kill, bad credential, reboot and reconnect remain blocked |
| DNS/WebRTC/IPv6 leakage | Location/privacy exposure | explicit policy and real-device verification | documented physical checks pass per supported configuration |
| Prompt injection/malicious content | Unauthorized AI action/data exfiltration | content is untrusted observation, schema/policy/budget gate, least context, human intervention | adversarial page/model-output tests cannot change policy or reveal secrets |
| Stale/forged approval | Unauthorized external action | exact payload digest, actor, expiry, single transactional consumption | concurrent/wrong target/text/account attempts fail |
| AI cost loop/provider outage | Spend/availability loss | independent quotas, bounded steps/retries/timeouts, circuit breaker and human stop | high-cost loop stops within configured budget |
| Billing webhook forgery/replay | Entitlement fraud | signature/timestamp verification, unique provider event, order-tolerant reconciliation | repeated/out-of-order event has one correct effect |
| Partial multi-store/database update | Corruption/authorization drift | database transactions, outbox, idempotent workers, reconciliation | injected failure publishes no partial authoritative state |
| Redis loss/stale cache | Access/coordination failure | PostgreSQL authority, short TTL, namespace by org, fail safe | flush/outage never grants access or duplicates lease/approval |
| Log/diagnostic leakage | Secret/personal-data exposure | structured allow-listed fields, redaction, bounded payloads, access controls | seeded secret shapes absent from logs/exports |
| Malicious upload | Traversal/storage exhaustion/content risk | safe names/opaque keys, type/size/quota checks, staged commit, malware policy | rejected upload leaves no partial object or overwritten state |
| Supply-chain/build compromise | Malicious installer/server | lockfiles, dependency audits, least CI permissions, signing/notarization, provenance/checksums | clean-machine install/update verification and reproducible inputs |
| Update downgrade/tamper | Code execution | signed releases, channel policy, trusted origin, digest/signature verification, no silent downgrade | modified/missing/wrong-channel installer fails closed |
| Insider/break-glass misuse | Broad data/control access | least-privilege roles, MFA, approvals, time-bound access and immutable audit | privileged action attributable and reviewable |
| Backup/restore failure | Data loss/extended outage | PITR, versioned objects, secret rebinding, automated verification and drills | measured restore meets declared RPO/RTO |

## Existing strengths to preserve

- live authorization rechecks and lease ownership generation;
- typed site RPC allow-list;
- hashed site/recovery tokens and constant-time comparison;
- atomic single-file writes and fail-closed configuration validation;
- strict device/config identity validation;
- explicit action policies and single-use approvals;
- human takeover/emergency stop;
- packaged-runtime allow-list and privileged-preload origin checks;
- device-originated network verification requirement;
- dependency audit and installer verification gates.

## Open high-risk areas

1. No organization/RLS database enforcement exists yet.
2. File stores and process-local coordination do not support horizontal cloud operation.
3. Site protocol lacks durable command idempotency/replay records and production service identity.
4. Proxy routing and leakage guarantees remain physically unverified.
5. No centralized security events, metrics, traces, alerting or incident workflow exists.
6. macOS and Windows distribution are not both signed production channels.
7. Live AI/provider/platform operation and prompt-injection red-team acceptance are absent.
8. Backup/restore and deletion/anonymization workflows are absent.

## Security test gates

- cross-tenant negative matrix for every API, job, cache and object operation;
- connection-pool tenant-context reuse tests;
- lease/approval/task/webhook concurrency tests;
- stale authorization during every awaited device/site/file operation;
- failure injection at transaction, outbox, object and site-ack boundaries;
- prompt-injection, malformed model output, provider outage and budget tests;
- real Mac/two-iPhone route-kill, DNS, WebRTC and IPv6 acceptance;
- signed clean-machine install, upgrade, rollback and uninstall tests;
- backup restore and tenant deletion reconciliation.

## Explicitly disallowed responses to threats

- challenge/CAPTCHA bypass or account-farming automation;
- weakening TLS, Electron isolation, origin checks or update verification;
- treating UI hiding as authorization;
- silently falling back to the ordinary host route;
- placing raw secrets in tasks, prompts, logs, fixtures, documentation or chat;
- claiming hardware/privacy/security guarantees without the matching acceptance evidence.
