import { createAccessibilitySkill } from "./createAccessibilitySkill.js";

export function createXSkill({ appVersion } = {}) {
  return createAccessibilitySkill({
    name: "x-accessibility",
    platform: "x",
    appVersion,
    appAliases: ["x", "twitter"],
    stateRules: [
      { state: "comments", patterns: ["replies", "replying to", "post your reply"] },
      { state: "search", patterns: ["search x", "explore", "search twitter"] },
      { state: "profile", patterns: ["followers", "following", "profile"] },
      { state: "thread", patterns: ["show this thread", "thread"] },
      { state: "post", patterns: ["post details", "views", "reposts", "likes"] },
      { state: "feed", patterns: ["home timeline", "for you", "following timeline", "app x", "app twitter"] },
    ],
    actionTargets: {
      open_feed: ["home"], search: ["search", "explore"], open_post: ["post"],
      open_profile: ["profile"], open_thread: ["show this thread", "thread"], open_comments: ["reply", "replies"],
      copy_link: ["copy link to post", "copy link"] ,
    },
  });
}
