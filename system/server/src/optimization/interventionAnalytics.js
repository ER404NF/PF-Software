// Operator-intervention analytics (roadmap MS13.4): how often, why, where and how fast
// people were needed. The point is to show what to fix next: the platform that keeps
// showing captchas, the account whose comments keep being refused, the hours nobody is
// around to pick items up.

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

function tally(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

// items: InterventionQueue records. steps: how many AI steps ran in the same period.
export function analyzeInterventions(items = [], { steps = null, now = Date.now() } = {}) {
  const resolved = items.filter(item => item.state === "RESOLVED" && item.resolvedAt);
  const claimed = items.filter(item => item.claimedAt);
  const waits = claimed.map(item => item.claimedAt - item.createdAt).filter(value => value >= 0);
  const handling = resolved.map(item => item.resolvedAt - item.createdAt).filter(value => value >= 0);
  const openNow = items.filter(item => item.state !== "RESOLVED");
  const byHour = Array(24).fill(0);
  for (const item of items) byHour[new Date(item.createdAt).getUTCHours()] += 1;
  const busiestHour = byHour.indexOf(Math.max(...byHour));
  const oldestOpenMs = openNow.length ? now - Math.min(...openNow.map(item => item.createdAt)) : 0;

  const topReasons = Object.entries(tally(items, "kind")).sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count }));
  const byPlatform = tally(items, "platform");
  const byAccount = tally(items, "accountId");
  const autoResolved = resolved.filter(item => item.resolvedBy === "system").length;

  return {
    total: items.length,
    open: openNow.length,
    resolved: resolved.length,
    autoResolved,
    perHundredSteps: steps ? Math.round((items.length / steps) * 10000) / 100 : null,
    medianSecondsToPickUp: waits.length ? Math.round(median(waits) / 1000) : null,
    medianSecondsToResolve: handling.length ? Math.round(median(handling) / 1000) : null,
    oldestOpenMinutes: Math.round(oldestOpenMs / 60_000),
    topReasons,
    byPlatform,
    byAccount,
    busiestHourUtc: items.length ? busiestHour : null,
    // What to look at first.
    attention: [
      ...(topReasons[0] && topReasons[0].count >= 3 ? [`${topReasons[0].kind} is the most common reason a person is needed (${topReasons[0].count})`] : []),
      ...Object.entries(byAccount).filter(([, count]) => count >= 5).map(([account, count]) => `account ${account} needed a person ${count} times`),
      ...(oldestOpenMs > 30 * 60_000 ? [`an item has been waiting ${Math.round(oldestOpenMs / 60_000)} minutes`] : []),
    ],
  };
}
