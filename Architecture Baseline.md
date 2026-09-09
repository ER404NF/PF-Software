# Architecture Baseline — Human VA First, AI VA Ready

This file defines the active product architecture. Historical research elsewhere in the repository does not override it.

## 1. Product definition

The system manages a durable fleet of organization-owned or authorized phones through a central control plane.

It has two controller modes per device:

- **Human VA Mode** — current product milestone; a human sees and controls the phone.
- **AI VA Mode** — future mode; an AI worker receives queued research tasks and controls the phone through the same Device API.

A device has exactly one input owner at a time.

## 2. Core architectural rule: operator-independent execution

```text
                 Control Plane
                      │
               Device Input Lease
                      │
            ┌─────────┴─────────┐
            │                   │
       Human VA             AI VA Worker
            │                   │
            └─────────┬─────────┘
                      │
                 Device API
                      │
              Device Adapter
                      │
                Physical Phone
```

The device adapter executes deterministic primitives. It does not decide what content is interesting or what task should happen next.

## 3. Controller state machine

Recommended per-device states:

```text
HUMAN
  ↕
HANDOFF
  ↕
AI_IDLE ↔ AI_RUNNING ↔ AI_PAUSED
                         │
                       ERROR
```

State invariants:

1. one input lease per device;
2. `HUMAN` blocks AI input;
3. `AI_RUNNING` blocks normal human input but keeps takeover/stop controls available;
4. handoff is logged and atomic from the control-plane perspective;
5. task state is checkpointed before/while ownership changes;
6. stale leases expire/reconcile after disconnects;
7. emergency stop revokes AI execution at the control-plane boundary.

## 4. Human VA Mode — Pilot V1

The human workflow is:

```text
login
  ↓
see authorized devices
  ↓
claim device
  ↓
observe screen
  ↓
tap / swipe / type / navigate
  ↓
use authorized files/content
  ↓
release device
```

Pilot V1 must prioritize real-device reliability, authentication, failure isolation, auditability and recovery.

## 5. AI VA Mode — future runtime

AI VA operates as a control-plane worker, not as code embedded in WDA.

Recommended loop:

```text
TaskSpec
  ↓
Acquire authorized device/account
  ↓
OBSERVE
  ↓
INTERPRET
  ↓
PLAN next bounded action
  ↓
VALIDATE against permissions/policy
  ↓
ACT through Device API
  ↓
VERIFY result
  ↓
RECORD observation/action
  ↓
continue / finish / pause / escalate
```

The worker should prefer structured UI/accessibility data where available, use screenshot/vision understanding when needed, and verify the result after important actions.

## 6. AI task scheduler and queue

The future scheduler owns durable task state. See `docs/COMMAND_QUEUE_SPEC.md` for exact semantics.

Minimum concepts:

- `TaskSpec`
- `TaskQueue`
- `TaskAttempt`
- `TaskCheckpoint`
- `ScheduleWindow`
- `Priority`
- `Dependency`
- `RetryPolicy`
- `Cancellation`
- `RunResult`
- `HumanEscalation`

A task can be bounded by a time window. When a running task ends successfully, the next eligible queued task starts immediately. If no task is currently eligible, the worker idles without losing the queue.

## 7. Future research workflows

Authorized managed-account workflows can include:

- feed/search scrolling;
- opening posts, threads, profiles, images and video;
- following links/navigation within the app;
- collecting a canonical URL/stable content ID where possible;
- screenshots and evidence capture;
- visible metric snapshots;
- extraction/classification/summarization;
- private save/bookmark;
- optional configured platform actions such as like/unlike, upvote/downvote/clear vote, repost/undo repost, and comment/reply;
- preset comments;
- model-generated comments grounded in the content actually viewed;
- creation of durable internal research records.

The purpose is to identify and organize useful content for the managed model/account. Platform interactions must not be the sole research memory.

## 8. Research data model

Recommended future entities:

```text
Workspace
PlatformAccount
Operator
AIWorker
Device
DeviceLease
TaskSpec
TaskAttempt
TaskCheckpoint
ResearchSession
ResearchObservation
ContentCandidate
ContentSnapshot
MetricSnapshot
ResearchTag
PlatformAction
CommentDraft
HumanReview
Incident
AuditEvent
SecretReference
```

### ContentCandidate minimum direction

```text
id
platform
platform_content_id
canonical_url
source_handle
device_id
platform_account_id
first_seen_at
last_seen_at
evidence_refs[]
text_extract
ai_summary
selection_reason
score
tags[]
platform_actions[]
task_id
run_id
review_state
```

Use deduplication keys such as platform + stable content ID/canonical URL when available.

## 9. Platform capability layer

Do not scatter platform-specific UI assumptions across the AI worker. Introduce versioned platform skills/adapters above the generic Device API.

```text
AI Worker
   ↓
Platform Skill
  - recognize screens/states
  - map goals to generic device actions
  - validate expected transitions
   ↓
Device API
```

Examples: `InstagramSkill`, `RedditSkill`, `XSkill`.

Each capability should declare:

- required permissions;
- expected UI preconditions;
- action policy category;
- success evidence;
- reversible/undo behavior when available;
- known failure/recovery paths;
- platform/app version compatibility.

## 10. Action policy

Each workspace/account should configure actions independently:

```text
ALLOW_AUTONOMOUS
REQUIRE_APPROVAL
DISABLED
```

Examples:

- scroll/open/observe: usually autonomous in AI mode;
- internal save/capture: autonomous;
- platform private save/bookmark: configurable autonomous;
- like/vote/repost/comment: configurable by managed account/workflow and always audited;
- security challenge/MFA/CAPTCHA: human handoff.

The purpose/configuration belongs in the control plane, not in ad-hoc model prompts.

## 11. Comment system

Support two future comment sources:

1. **Preset comments** selected from an approved template library.
2. **AI-generated comments** based on the content currently observed.

Store the exact comment text, content reference, generation source/model/version, task/run ID and result. Add duplicate/repetition checks and workspace-configurable approval requirements.

## 12. Model-provider abstraction

The AI worker should not depend directly on a single vendor.

Recommended boundary:

```text
ModelProvider
  observe_and_plan(context) -> StructuredDecision
```

Potential providers can include cloud multimodal models or local models. The scheduler/device layer must remain provider-neutral.

## 13. Credentials and challenges

Platform credentials/secrets should be stored via secret references, not plaintext in tasks or logs.

If login state expires or the platform presents MFA, CAPTCHA, security review, or account recovery, transition the task to `NEEDS_HUMAN` and support a Human VA takeover. Do not build challenge-bypass mechanisms.

## 14. Reliability and recovery

AI execution introduces additional failure modes. Plan for:

- stale screen/frame;
- UI changed unexpectedly;
- action did not register;
- wrong screen reached;
- app crashed;
- device disconnected;
- network unavailable;
- model timeout/error;
- scheduler restart;
- duplicate task execution;
- platform content removed;
- handoff during a running task.

Use checkpoints, idempotency where possible, bounded retries, explicit failure reasons and human escalation.

## 15. Observability

Future AI runs should expose:

- current mode;
- current task and queue position;
- active device/account;
- task window and elapsed time;
- last observation/action/result;
- model/provider and cost/usage where available;
- confidence/uncertainty signal;
- retry count;
- intervention state;
- links to captured research candidates and audit history.

## 16. Evaluation metrics

Measure rather than assume:

- device-control action success rate;
- task completion rate;
- human intervention rate;
- duplicate/incorrect action rate;
- content-candidate deduplication accuracy;
- extraction/link capture success;
- mean action latency;
- AI cost per research session;
- recovery success;
- zero cross-account/client data mixing;
- queue/scheduler correctness after restarts.

## 17. Current non-goals

Current Pilot V1 does not require AI operation. The long-term architecture does not require fake-account generation, security-control bypass, fingerprint/location spoofing, ban-replacement automation, or engagement-boosting campaigns.
