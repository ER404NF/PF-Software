import { createAccessibilitySkill } from "./createAccessibilitySkill.js";

export function createInstagramSkill({ appVersion } = {}) {
  return createAccessibilitySkill({
    name: "instagram-accessibility",
    platform: "instagram",
    appVersion,
    appAliases: ["instagram"],
    stateRules: [
      { state: "comments", patterns: ["comments", "add a comment"] },
      { state: "search", patterns: ["explore", "search instagram", "search and explore"] },
      { state: "profile", patterns: ["followers", "following", "edit profile", "profile tab"] },
      { state: "reel", patterns: ["reels", "reel by", "reel viewer", "audio by"] },
      { state: "post", patterns: ["view post", "post viewer", "likes"] },
      { state: "feed", patterns: ["app instagram", "instagram home", "home feed", "stories"] },
    ],
    actionTargets: {
      open_feed: ["home"], search: ["search", "explore"], open_post: ["post", "reel"],
      open_profile: ["profile"], open_thread: ["post"], open_comments: ["comments", "comment"],
      copy_link: ["copy link"],
    },
  });
}
