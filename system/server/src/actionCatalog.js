// The complete list of things the AI worker may ever ask a phone to do, grouped by
// what they can affect. Kept separate from the validator so the model-response
// schema and the validator can share it without importing each other.

// Reading and moving around only (roadmap MS8).
export const READ_ONLY_ACTIONS = Object.freeze([
  "observe", "open_feed", "search", "open_post", "open_profile", "open_thread", "scroll_next",
  "scroll_previous", "open_comments", "capture", "capture_screenshot", "copy_link", "extract_visible",
]);

// Private research markers: visible to the account owner only (MS9).
export const MARKER_ACTIONS = Object.freeze(["platform_save", "platform_unsave"]);

// Visible to other people on the platform (MS10).
export const REACTION_ACTIONS = Object.freeze([
  "like", "unlike", "upvote", "downvote", "clear_vote", "repost", "undo_repost",
]);
export const COMMENT_ACTIONS = Object.freeze(["comment_preset", "comment_generated", "reply_preset", "reply_generated"]);

export const PLATFORM_VISIBLE_ACTIONS = Object.freeze([...MARKER_ACTIONS, ...REACTION_ACTIONS, ...COMMENT_ACTIONS]);
export const ACTIONS = Object.freeze([...READ_ONLY_ACTIONS, ...MARKER_ACTIONS, ...REACTION_ACTIONS, ...COMMENT_ACTIONS]);

// Toggle-style controls: pressing twice undoes it, so they go through stateToggle.js.
// family = which control; desired = the state the action wants it to end in.
export const TOGGLE_ACTIONS = Object.freeze({
  platform_save: { family: "save", desired: "on" },
  platform_unsave: { family: "save", desired: "off" },
  like: { family: "like", desired: "on" },
  unlike: { family: "like", desired: "off" },
  upvote: { family: "vote_up", desired: "on" },
  downvote: { family: "vote_down", desired: "on" },
  clear_vote: { family: "vote", desired: "off" },
  repost: { family: "repost", desired: "on" },
  undo_repost: { family: "repost", desired: "off" },
});

const COMMENT_SET = new Set(COMMENT_ACTIONS);
export const isCommentAction = action => COMMENT_SET.has(action);
export const isPlatformVisible = action => PLATFORM_VISIBLE_ACTIONS.includes(action);
