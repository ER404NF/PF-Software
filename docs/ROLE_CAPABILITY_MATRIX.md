# Role and capability matrix

Implemented 2026-09-10 in `system/server/src/roleCapabilities.js`. Capabilities are explicit strings rather than an ordinal role rank. Server checks use the current operator record on every HTTP request and WebSocket action. Device grants and research-workspace grants are separate checks and remain mandatory for every role, including Admin.

| Capability | Admin | Manager | VA | Content Creator | Editor |
|---|:---:|:---:|:---:|:---:|:---:|
| View fleet and people | Yes | Yes | Yes | Yes | Yes |
| View assignments and safe network health | Yes | Yes | Yes | Yes | Yes |
| Control an authorized phone | Yes | Yes | Yes | No | No |
| Access authorized media | Yes | Yes | Yes | Yes | Yes |
| View authorized research | Yes | Yes | Yes | Yes | Yes |
| Run authorized research | Yes | Yes | Yes | Yes | No |
| Review authorized research | Yes | Yes | Yes | Yes | Yes |
| Manage routine assignments | Yes | Yes | No | No | No |
| Review and rename members of the same assigned team | Yes | Yes | No | No | No |
| Manage scoped queue work | Yes | Yes | No | No | No |
| Manage AI controller and handoffs | Yes | Yes | No | No | No |
| Run an approved network check | Yes | Yes | No | No | No |
| Monitor an authorized phone | Yes | Yes | No | No | No |
| Pause or resume the entire queue | Yes | No | No | No | No |
| Read sensitive global audit history | Yes | No | No | No | No |
| Configure model selection | Yes | No | No | No | No |
| Manage roles, grants, passwords, 2FA, proxies, or security | Yes | No | No | No | No |

Assignment, user-management, presence, and monitor capabilities are explicit boundaries for their routes. Proxy management now controls the persisted `network.enabled` assignment through an Admin-only endpoint and fleet-card switch; the external gateway/provider still applies the real phone traffic route.

Current server enforcement:

- Live input requires `device:control` plus the device grant and the live lease.
- Role and grant edits push a safe live profile to the affected browser. The
  client clears old capability-scoped data and ignores in-flight responses from
  the previous profile generation; the server remains the authorization boundary.
- `fleet:view` provides safe summaries for all devices. `allowedDevices` controls
  opening and device-scoped routes; it does not filter situational visibility.
- VA null/missing device grants resolve to an empty array. Other established
  roles retain null as their intentional unrestricted device scope.
- File routes require `media:access` plus the device grant.
- Research routes require view, operate, or review capability plus the workspace grant.
- Routine queue and AI-controller operations permit Manager and Admin, then recheck device/workspace scope.
- `team-members:manage` lets a Manager list, accept/reject, and rename only VA,
  Content Creator, or Editor accounts with the exact same non-empty `teamId`.
  It does not expose sensitive audit records and cannot mutate grants, roles,
  passwords, 2FA, or the Manager's own account.
- Global queue state, model configuration, sensitive audit history, user/access administration, proxy mutation, and security configuration remain Admin-only.
- Unknown or missing roles normalize to VA for backward compatibility and do not acquire management capabilities.
