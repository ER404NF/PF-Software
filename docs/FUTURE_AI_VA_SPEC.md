# Future AI VA Specification

## Status

Future specification. Human VA Pilot V1 remains the current implementation milestone unless the user explicitly promotes an AI VA item into active scope.

## 1. User experience

The operator console should eventually expose a prominent per-device mode switch:

```text
[ Human VA ]  [ AI VA ]
```

### Human VA

- AI worker cannot send device input.
- Normal interactive phone view is visible.
- Human tap/swipe/type controls are enabled.
- Current queue can remain visible but is paused for this device.

### AI VA

- Human input is locked/read-only except Take Over / Stop AI.
- A command panel is visible.
- The operator can submit tasks, time windows and queue operations.
- The UI shows current task, queued tasks, status, last action and collected results.

## 2. AI VA objective

AI VA performs authorized content-research work on managed platform accounts using real phones.

Typical objectives:

- discover content around a topic;
- scroll for a bounded period;
- identify strong examples;
- save/bookmark interesting posts;
- collect stable links;
- capture screenshots and visible metrics;
- tag and summarize patterns;
- optionally perform configured account actions (likes, votes, reposts, comments) as research markers/signals;
- produce a structured research set for later human use.

## 3. Execution loop

```text
OBSERVE → INTERPRET → PLAN → VALIDATE → ACT → VERIFY → RECORD
                         ↑                         ↓
                         └──────── recover/retry ─┘
```

Every action should be a bounded structured command. The model does not receive unrestricted shell or host access.

Example structured decision:

```json
{
  "screen_state": "instagram_reel",
  "goal_progress": "candidate_found",
  "action": "platform_save",
  "target": "current_post",
  "reason": "Strong 3-second hook and editing pattern matches task criteria",
  "confidence": 0.94
}
```

The platform skill/action validator translates that into device primitives and verifies the result.

## 4. Device primitives

Target generic Device API:

```text
observe(device_id)
get_ui_tree(device_id)
tap(device_id, target|x,y)
swipe(device_id, direction|coordinates)
type_text(device_id, text)
press_home(device_id)
press_back(device_id)
wait(device_id, duration)
set_clipboard(device_id, text)        if supported
capture_screenshot(device_id)
get_device_status(device_id)
```

Platform-level operations sit above these primitives.

## 5. Research-oriented platform actions

Potential platform actions:

```text
open_feed
search
open_post
open_profile
open_thread
scroll_next
scroll_previous
open_comments
copy_link
platform_save
platform_unsave
like
unlike
upvote
downvote
clear_vote
repost
undo_repost
comment_preset
comment_generated
reply_preset
reply_generated
```

Not every platform supports every action. Capabilities must be discovered/versioned per platform/app version.

## 6. Action purpose and internal mirroring

For this project, platform interactions on managed research accounts are not the database.

If AI marks a post as useful by saving, liking, voting, reposting or commenting, it should also create/update an internal `ContentCandidate` with:

- link/stable ID;
- evidence screenshot;
- reason selected;
- tags/score;
- visible metrics;
- action performed;
- task/session context.

This prevents loss of research context and makes cross-platform analysis possible.

## 7. Account action policy

Per workspace/account action configuration:

```yaml
scroll: ALLOW_AUTONOMOUS
open_content: ALLOW_AUTONOMOUS
capture: ALLOW_AUTONOMOUS
copy_link: ALLOW_AUTONOMOUS
platform_save: ALLOW_AUTONOMOUS
like: ALLOW_AUTONOMOUS
upvote: ALLOW_AUTONOMOUS
downvote: REQUIRE_APPROVAL
repost: REQUIRE_APPROVAL
comment_preset: ALLOW_AUTONOMOUS
comment_generated: REQUIRE_APPROVAL
```

The above is only an example. Store actual policy in the control plane and expose it in admin UI.

## 8. Comments

### Preset

A workspace can maintain approved templates, optionally with placeholders derived from the current content.

### Generated

The model can draft a content-grounded comment. Before execution, validate:

- action is enabled for that account;
- content reference is current;
- text is non-empty and within platform limits;
- no accidental duplicate/repeated comment;
- required approval has been obtained according to policy.

Record exact sent text and result.

## 9. Time-bounded tasks

AI tasks may run only inside a defined window. `/time` is specified in `COMMAND_QUEUE_SPEC.md`.

Important behaviors:

- do not start before the window;
- stop/checkpoint at the end of the window;
- mark task `SUCCEEDED`, `PARTIAL`, or `EXPIRED` based on its completion criteria;
- continue immediately with the next eligible queue item;
- if nothing is eligible, enter `AI_IDLE`.

## 10. Multi-device / fleet execution

Eventually one scheduler may coordinate multiple AI workers, but each physical device has one input lease.

```text
Fleet Scheduler
   ├─ Worker A → Phone 01
   ├─ Worker B → Phone 02
   └─ Worker C → Phone 03
```

Add per-workspace concurrency limits, per-platform-account locks and device/account compatibility rules.

Do not allow one account session to be unintentionally operated concurrently on multiple devices unless the workspace explicitly supports that arrangement.

## 11. Platform skill architecture

Use versioned skills rather than a monolithic prompt:

```text
PlatformSkill
  detect_state(observation)
  available_actions(state)
  execute(action)
  verify(action, observation_after)
  recover(error/state)
```

Skills can use accessibility selectors where stable and vision-based targeting when needed.

## 12. Research scoring

The research task may specify criteria such as:

- topic relevance;
- hook quality;
- visual format;
- novelty;
- comment insight;
- visible engagement signal;
- creator relevance;
- content format/length;
- recency.

Store both raw observations and derived scores so later model changes do not erase the original evidence.

## 13. Human handoff

The AI should enter `NEEDS_HUMAN` / pause when encountering:

- MFA or security challenge;
- CAPTCHA;
- account recovery/login ambiguity;
- destructive/irreversible action outside policy;
- uncertain target where the cost of a wrong action is material;
- repeated failure after retry budget;
- device/host fault requiring operator intervention.

The human can take over the same live phone, resolve the issue, then return it to AI mode.

## 14. Model/provider abstraction

Support multiple model backends behind a common interface. Separate:

- vision/UI interpretation;
- planning/reasoning;
- text generation;
- deterministic platform/device execution.

This permits future cost optimization such as local screen classification plus a cloud model only for difficult decisions.

## 15. Data retention and privacy

Configuration should define what screenshots, content extracts, comments and logs are retained and for how long. Credentials/secrets should never be emitted into model prompts or ordinary audit logs unless strictly required and specifically protected.

## 16. Acceptance direction for AI VA

Before enabling unattended sessions broadly, verify through staged gates:

1. mock platform/UI fixtures;
2. one real device in supervised AI mode;
3. read-only browsing/research;
4. private save/bookmark actions;
5. configured reversible account actions;
6. comment drafting with approval;
7. comment execution according to policy;
8. timed jobs and persistent queue;
9. Human↔AI handoff under load;
10. multi-device scheduler with measured intervention/error rates.
