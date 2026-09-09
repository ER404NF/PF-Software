# Platform Capability Matrix — Future AI VA

The read-only MS8 accessibility profiles are implemented locally for Instagram,
Reddit, and X. They remain disabled in the shipped configuration until each
installed app version is verified on an authorized account/device. MS9/MS10
platform-visible actions remain planned and are rejected by the current policy
validator.

| Capability | Instagram | Reddit | X / Twitter | Internal research record |
|---|---|---|---|---|
| Scroll feed/search | Local profile; live gate pending | Local profile; live gate pending | Local profile; live gate pending | observation/session |
| Open post/thread | Local profile; live gate pending | Local profile; live gate pending | Local profile; live gate pending | observation |
| Open profile/author | Local profile; live gate pending | Local profile; live gate pending | Local profile; live gate pending | source reference |
| Capture screenshot | Implemented; live gate pending | Implemented; live gate pending | Implemented; live gate pending | protected evidence |
| Capture/copy link | Local profile; live gate pending | Local profile; live gate pending | Local profile; live gate pending | canonical URL/stable ID |
| Extract visible text/metrics | Implemented locally | Implemented locally | Implemented locally | snapshot |
| Private save/bookmark | Save/Unsave | Save/Unsave | Bookmark/Unbookmark | candidate action |
| Like/Unlike | Planned | N/A | Planned | platform action |
| Upvote/Downvote/Clear | N/A | Planned | N/A | platform action |
| Repost/Undo | platform-dependent | N/A | Planned | platform action |
| Preset comment/reply | Planned | Planned | Planned | exact text + result |
| AI-generated comment/reply | Planned, policy-controlled | Planned, policy-controlled | Planned, policy-controlled | exact text + model metadata |
| Human takeover on challenge | Required | Required | Required | intervention event |

## Platform skill requirements

### Instagram

The local profile recognizes:

- home/feed;
- Explore/search;
- post/reel viewer;
- profile;
- comments;
- share/copy-link surface;
- saved state where observable;
- account/security challenge screens.

MS8 enables configured scroll/open/capture/link actions and internal candidate
creation. Save/unsave, like/unlike, and comments remain later policy-gated work.

### Reddit

The local profile recognizes the read-only portions of:

- home/popular/subreddit/search;
- post view;
- comment thread;
- profile/community navigation;
- save/unsave;
- upvote/downvote/clear vote;
- comment/reply according to policy;
- share/copy link;
- internal candidate creation.

### X / Twitter

The local profile recognizes the read-only portions of:

- home/following/search/list/profile feeds;
- post/thread view;
- bookmark/unbookmark;
- like/unlike;
- repost/undo repost;
- reply according to policy;
- copy link;
- internal candidate creation.

## Important implementation rule

Use platform actions as optional research markers/signals, not as the sole storage layer. Every selected item should be mirrored to the control plane with a stable reference and evidence whenever possible.

## Versioning

Platform mobile UIs change. Each `PlatformSkill` should expose/version:

- app/platform version tested;
- known screen detectors;
- supported actions;
- verification method;
- fallbacks;
- last successful bench test date.

`system/platform-skills.config.json` is currently empty, so no profile is
asserted compatible with a real installed version and no bench-test date exists.
