import { createAccessibilitySkill } from "./createAccessibilitySkill.js";

export function createRedditSkill({ appVersion } = {}) {
  return createAccessibilitySkill({
    name: "reddit-accessibility",
    platform: "reddit",
    appVersion,
    appAliases: ["reddit"],
    stateRules: [
      { state: "comments", patterns: ["comments", "add a comment", "reply"] },
      { state: "search", patterns: ["search reddit", "search"] },
      { state: "profile", patterns: ["view profile", "karma", "profile"] },
      { state: "post", patterns: ["post detail", "upvote", "downvote", "subreddit"] },
      { state: "feed", patterns: ["reddit home", "popular", "home feed", "app reddit"] },
    ],
    actionTargets: {
      open_feed: ["home", "popular"], search: ["search"], open_post: ["post"],
      open_profile: ["profile", "user"], open_thread: ["comments", "post"], open_comments: ["comments"],
      copy_link: ["copy link"],
    },
  });
}
