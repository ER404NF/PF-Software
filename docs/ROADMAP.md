# Roadmap — Human VA → Dual Mode → AI VA Research

## Stage 0 — Existing prototype

- browser device list;
- mock/WDA observation path;
- tap path;
- simple exclusive device use;
- per-device server-side file area.

## Stage 1 — Human VA Pilot foundation

- swipe;
- keyboard/text;
- improved frame refresh;
- stronger device session lifecycle;
- authentication;
- RBAC/device/account authorization;
- persistent state/audit events;
- health/heartbeat/reconnect;
- one real iPhone bench test;
- 1 → 2 → 5 device soak tests.

Exit condition: a human VA can reliably operate authorized real devices and recover common failures.

## Stage 2 — Controller abstraction and mode switch

- `ControllerMode` state machine;
- exclusive input lease service;
- Human ↔ AI handoff transaction;
- STOP AI / TAKE OVER control;
- read-only AI status pane in Human mode;
- persistent controller/task checkpoints.

Exit condition: mode can switch without reconnecting/restarting the device and without concurrent input.

## Stage 3 — Durable task/queue scheduler

- `TaskSpec` parser;
- `/time` command;
- queue add/list/pause/resume/cancel/reorder;
- time windows;
- immediate next-eligible dispatch;
- retries/timeouts/checkpoints;
- restart recovery;
- per-device/account locks.

Exit condition: fake workers can execute scheduled queued tasks deterministically across restarts.

## Stage 4 — AI VA read-only research

- model-provider interface;
- screen/accessibility observation package;
- AI decision schema;
- action validator;
- platform skill framework;
- Instagram/Reddit/X navigation skills;
- collect URL/stable ID, screenshot, visible text/metrics;
- `ContentCandidate`/deduplication;
- research summaries;
- Human takeover on uncertainty/security challenge.

Exit condition: supervised AI can browse and collect useful content without platform-visible actions.

## Stage 5 — Private research markers

- Instagram Save/Unsave;
- Reddit Save/Unsave;
- X Bookmark/Unbookmark;
- verification and idempotency;
- mirror every selection internally.

Exit condition: AI can collect and revisit candidates reliably with both platform and internal storage.

## Stage 6 — Configured account actions

Implement only behind per-account action policy and full audit:

- Instagram Like/Unlike;
- Reddit Upvote/Downvote/Clear Vote;
- X Like/Unlike and Repost/Undo;
- preset comments/replies;
- AI-generated content-grounded comments/replies;
- duplicate comment prevention;
- configurable approval gates.

Exit condition: actions execute only when allowed, are verified, logged, and mirrored to research records.

## Stage 7 — Timed autonomous research sessions

- time-bounded multi-step jobs;
- criteria/scoring profiles;
- candidate quotas/stop conditions;
- automatic queue chaining;
- session reports;
- cost/latency tracking;
- recovery from app/device/model failures.

Exit condition: a supervisor can queue multiple research jobs and observe them complete sequentially within defined windows.

## Stage 8 — Multi-device AI fleet

- fleet scheduler;
- multiple concurrent AI workers;
- device/account affinity;
- workspace concurrency policy;
- resource budgets;
- centralized monitoring;
- intervention queue for human VAs.

Exit condition: several devices can run independent research tasks while humans can take over any device safely.

## Stage 9 — Optimization

- local/cheap screen classification where useful;
- model routing by task difficulty;
- cached platform state detection;
- adaptive screenshot frequency;
- structured UI-tree use before expensive vision calls;
- better deduplication/search/indexing;
- analytics on research quality and operator interventions.

## Always-required engineering properties

Across every stage:

- one input owner per device;
- explicit authorization boundaries;
- no cross-client/account data leakage;
- durable task/audit state;
- deterministic action validation;
- human takeover path;
- no CAPTCHA/security-control bypass;
- benchmark real-device behavior rather than assuming capacity.
