import { createAccessibilitySkill } from "./createAccessibilitySkill.js";

export function createInstagramSkill({ appVersion } = {}) {
  return createAccessibilitySkill({
    name: "instagram-accessibility",
    platform: "instagram",
    appVersion,
    appAliases: ["instagram"],
    stateRules: [
      { state: "feed", patterns: ["instagram home", "home feed", "stories tray", "feed collection"] },
      { state: "comments", patterns: ["comments screen", "comments sheet", "add a comment"] },
      { state: "search", patterns: ["explore", "search instagram", "search and explore"] },
      { state: "profile", patterns: ["followers", "following", "edit profile", "profile tab"] },
      { state: "reel", patterns: ["reels", "reel by", "reel viewer", "audio by"] },
      { state: "post", patterns: ["view post", "post viewer", "post details"] },
    ],
    actionTargets: {
      open_feed: ["home"], search: ["search", "explore"], open_post: ["post", "reel"],
      open_profile: ["profile"], open_thread: ["post"], open_comments: ["comments", "comment"],
      copy_link: ["copy link"],
    },
  });
}
