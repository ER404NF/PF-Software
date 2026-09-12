# Durable Assignments

Implemented 2026-09-11.

Assignments are durable control-plane records stored at
`system/storage/assignments/assignments.json` (or `ASSIGNMENT_STORE_PATH` in
tests/operations). Each record contains immutable instructions and origin,
optional phone/account references, current assignee and status, timestamps, and
an append-only history naming the actor for every change.

All five roles can view assignments addressed to them. Admin and Manager have
`assignments:manage`; Manager can target VA, Content Creator, Editor, or their own
account, while Admin can target every registered operator. Existing phone and
research-workspace grants are checked for the manager, the assignee, and again on
every read or update. Revoking a referenced grant therefore removes access from
an already logged-in user without waiting for a new session.

The lifecycle is `assigned -> in_progress -> completed`, with cancellation from
either active state. Completed and cancelled records are terminal and retained;
there is no deletion endpoint. Assignment mutation requires `assignments:manage`;
VAs and other non-management roles receive read-only records. Authorized managers
may update status and reassign nonterminal work, which
returns it to `assigned` and records both assignees in history.

A durable assignment that references a phone never grants phone access. The
assignee must independently have that device ID in `allowedDevices` before the
assignment can be created, read in scope, or used to open the phone.

The store writes a complete temporary snapshot and renames it before changing
live memory. A failed write therefore leaves the running state unchanged.
Coverage includes restart persistence, write failure, invalid transitions,
duplicate IDs, HTTP role/scope enforcement, visibility, reassignment, and the
absence of a deletion route.
