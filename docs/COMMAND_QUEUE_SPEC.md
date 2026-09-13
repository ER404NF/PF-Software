# AI VA Command and Queue Specification

## 1. Goal

Provide an operator-facing command system for AI VA Mode. Commands compile into durable structured `TaskSpec` records. Natural language is allowed, but execution always uses validated structured fields.

## 2. Core command syntax

### Mode

```text
/mode human [device|group]
/mode ai [device|group]
```

### Timed task

```text
/time <start>-<end> <task>
```

Current implementation note (2026-09-13): this general form is parsed but
rejected before queue admission because no generic task worker is registered.
Use `/cresearch` for the currently supported executable research workflow. This
prevents a task with no executor from acquiring and holding an AI device lease.

Examples:

```text
/time 09:00-10:00 Research AI coding reels on Instagram. Save strong examples and collect their links.
/time 10:00-10:30 Search Reddit for AI agent discussions. Save useful posts and tag recurring objections.
/time 14:00-15:00 Review X posts about multimodal agents and bookmark strong launch hooks.
```

Optional explicit date:

```text
/time 2026-09-05 09:00-10:30 <task>
```

Workspace timezone is configured centrally. Do not silently reinterpret an expired same-day window as tomorrow; reject/mark expired and ask the operator to reschedule.

### Research shorthand — `/cresearch`

```text
/cresearch <platform> [account-id] <minutes> <goal>
/cresearch <platform> [--account <account-id>] --minutes <minutes> <goal>
```

Sugar over `/time`: compiles to the same bounded-window `TaskSpec` as
`/time <now>-<now+minutes> <goal>`, plus an exact platform/account selector. This
formalizes what earlier code comments referred to only as `/cresearch` (the
command whose output `researchStore.js` records) — it is the same command,
not a different one.

Example:

```text
/cresearch instagram 30 Research AI coding reels on Instagram. Save strong examples and collect their links.
/cresearch reddit client-a-reddit 20 Find recurring objections in current threads.
/cresearch instagram --account 123 --minutes 30 Inspect the numeric account.
```

The short form is accepted only when the operator has exactly one configured
account for that platform. Zero or multiple matches fail closed; use the explicit
account form to resolve ambiguity.

Unlike the general `/time` form, `/cresearch` always starts its window at the
moment it's issued — there is no way to schedule a `/cresearch` for later
yet. `/queue add /cresearch ...` still works (it just starts immediately upon
being added, same as issuing `/cresearch` directly); use `/time` directly if
a genuinely future start time is needed.

## 3. Queue operations

```text
/queue add <task or /time command>
/queue list
/queue pause
/queue resume
/queue cancel <task_id>
/queue move <task_id> before <task_id>
/queue move <task_id> after <task_id>
/queue priority <task_id> <low|normal|high|urgent>
```

AI control:

```text
/pause [deviceId]
/resume [deviceId]
/stop [deviceId]
/takeover [deviceId]
```

`/takeover` switches the current device to Human VA Mode using the handoff protocol.

Runtime model selection:

```text
/model list
/model set <provider> [global|workspace <id>|device <id>|task <id>]
```

The most specific configured scope wins in task, device, workspace, global order.
Selections persist across relay restarts and are resolved before every model
decision, so a running research task can change providers without a restart.

## 4. TaskSpec

Recommended durable structure:

```json
{
  "id": "task_...",
  "workspace_id": "...",
  "device_selector": {"device_id": "optional"},
  "account_selector": {"platform": "instagram", "account_id": "optional"},
  "goal": "Research AI coding reels and save strong candidates",
  "criteria": {},
  "allowed_actions": [],
  "required_actions": [],
  "earliest_start": "...",
  "latest_end": "...",
  "max_duration_sec": 3600,
  "priority": "normal",
  "dependencies": [],
  "retry_policy": {},
  "created_by": "operator_id",
  "created_at": "..."
}
```

The natural-language parser may propose fields, but the scheduler/action validator enforces workspace/account permissions.

## 5. Task states

```text
DRAFT
VALIDATED
QUEUED
SCHEDULED
DISPATCHED
RUNNING
PAUSED
NEEDS_HUMAN
SUCCEEDED
PARTIAL
FAILED_RETRYABLE
FAILED_FINAL
CANCELLED
EXPIRED
```

## 6. Eligibility

A queued task is eligible when:

- current time is inside its schedule window (if any);
- dependencies are satisfied;
- required device/account is available;
- action policy permits the job;
- no conflicting lease exists;
- workspace concurrency limits allow it.

After a task finishes, immediately dispatch the highest-priority eligible task. Preserve FIFO ordering among equal-priority tasks unless explicitly reordered.

## 7. Time-window semantics

For `/time 09:00-10:00 ...`:

- before 09:00 → `SCHEDULED`;
- 09:00–10:00 → eligible to run;
- at 10:00 → stop/checkpoint at a safe action boundary;
- after 10:00 without completion → `PARTIAL` or `EXPIRED` according to task progress/requirements.

A task does not continue past its configured window unless `allow_overrun=true` is an explicit setting.

`maxDurationSec` is a positive finite elapsed-time limit per dispatch attempt, measured from the persisted `dispatchedAt`. Pauses count toward this limit; a retry receives a new attempt deadline. `allowOverrun` affects the schedule window only and never disables the duration cap. On expiry, new input is revoked immediately; already submitted input must settle before another task receives the device. The worker also checks the deadline before executing a decision, between scheduler ticks.

## 8. Immediate chaining

When Task A completes:

1. persist result/checkpoint;
2. release/reconcile task resources;
3. select next eligible queue item;
4. acquire required lease;
5. start Task B immediately.

Do not require a human click between normal successful tasks.

## 9. Pause, stop and takeover

- `/pause`: finish current atomic action, checkpoint, hold lease or release according to policy, no new actions.
- `/resume`: continue from checkpoint after re-observing current screen.
- `/stop`: cancel active task and revoke future actions; preserve audit/result data. Already-submitted input must settle before ownership can be reused. If saving the cancellation fails, report the failure and hold the device in `ERROR`; do not dispatch replacement work.
- `/takeover`: pause/cancel AI control as configured and transfer device to Human VA Mode.

The UI should always expose a physical-looking high-priority **STOP AI / TAKE OVER** control independent of chat/command parsing — always visible to whichever operator can see the device at all, i.e. gated by the same role check as the rest of the AI-mode surface (as of 2026-09-09, that's the `admin` role; a VA-role operator sees a read-only "admin handoff required" indicator instead and must escalate). "Independent of chat/command parsing" means it bypasses the text-command parser, not that it bypasses operator-role authorization.

## 10. Retries and idempotency

Actions must define whether they are safe to retry.

Examples:

- observe/screenshot: retryable;
- scroll: retryable with state verification;
- platform save: verify current saved state before retry;
- like/vote/repost: verify current action state before reissuing;
- comment: never blindly retry after ambiguous network/result state; inspect whether the exact comment was already posted first.

## 11. Checkpoints

Checkpoint after meaningful transitions, including:

- opening target content;
- recording a candidate;
- platform action success;
- comment submission;
- device/account change;
- mode handoff;
- time-window end.

Checkpoint should include enough state to re-observe and resume without assuming the UI is unchanged.

## 12. Natural-language commands

The command console may also accept:

```text
Research Reddit for 30 minutes for discussions about AI coding agents. Save good posts and summarize the main complaints.
```

The parser converts this into a proposed TaskSpec and shows/records the structured interpretation. Ambiguous destructive/high-impact fields should not be silently invented.

## 13. Queue UI

Show:

- position;
- task ID/name;
- platform/account;
- device assignment;
- start/end window;
- priority;
- status;
- progress/candidate count;
- elapsed time;
- last action;
- retry/intervention state;
- pause/cancel/reorder controls.

## 14. Persistence

Queue/task state must survive service restart. On restart:

1. load nonterminal tasks;
2. mark interrupted `RUNNING` attempts as recovery-needed;
3. reconcile device leases;
4. re-observe device state before resuming;
5. prevent duplicate public/platform-visible actions through action-history verification.
