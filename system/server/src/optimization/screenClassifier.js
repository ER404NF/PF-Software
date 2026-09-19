// Cheap local screen classification and planning before any model is asked
// (roadmap MS13.1). The accessibility tree already says which screen this is; when the
// next step follows mechanically from that, spending a model call on it is waste.
//
// This planner is deliberately narrow. It answers ONLY the two situations where the
// right move never depends on judgement:
//   - the app is closed (springboard)            -> open it
//   - a candidate was just recorded on the feed   -> move on to the next post
// Everything else, including anything unfamiliar or any challenge, goes to a model.
// It also never proposes an action the task or the account's policy does not permit.

export async function classifyScreen(observation, skill) {
  try {
    const state = await skill.detectState(observation);
    return {
      state,
      known: typeof state === "string" && !["unknown", "screenshot"].includes(state),
      challenge: state === "security_challenge",
    };
  } catch {
    return { state: "unknown", known: false, challenge: false };
  }
}

const FEED_STATES = new Set(["feed", "reel"]);

export class LocalPlanner {
  constructor() {
    this.lastByTask = new Map(); // taskId -> last decision that was executed
  }

  remember(taskId, decision) {
    if (taskId) this.lastByTask.set(taskId, decision);
  }

  forget(taskId) {
    this.lastByTask.delete(taskId);
  }

  // Returns a full decision, or null when a model is needed.
  plan({ screen, platform, taskId, permittedActions = [] }) {
    if (!screen?.known || screen.challenge) return null;
    const permitted = action => permittedActions.includes(action);
    if (screen.state === "springboard" && platform && permitted("open_feed")) {
      return { screen_state: "springboard", goal_progress: "working", action: "open_feed", target: platform,
        reason: "the app is closed; open it (local rule)", confidence: 1 };
    }
    const last = this.lastByTask.get(taskId);
    if (FEED_STATES.has(screen.state) && last?.candidate && permitted("scroll_next")) {
      return { screen_state: screen.state, goal_progress: "working", action: "scroll_next", target: "feed",
        reason: "the last post was recorded; move to the next one (local rule)", confidence: 1 };
    }
    return null;
  }
}
