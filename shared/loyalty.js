// Loyalty streak: order on `days` days in a row (India time) and the next visit's dish is free,
// usable for `validDays` days after it's earned. Shared by the server (which decides) and the
// screens (which explain). A day counts when the customer's mobile is on a bill or an accepted
// QR order that day.

export const LOYALTY_DEFAULTS = { on: false, days: 6, validDays: 3, dishId: "", variant: "" };

export const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// days: visit days ("YYYY-MM-DD"). after: the last day a reward was earned (its run is used up).
// since: the day the shop turned the scheme on (older visits don't count).
// Returns the days rewards were earned on, and the current streak (0 once it's broken).
export function streakInfo(days, { today, need, after = "", since = "" }) {
  const list = [...new Set(days)].filter((d) => d > after && d >= since && d <= today).sort();
  const earned = [];
  let run = 0;
  let prev = null;
  for (const d of list) {
    run = prev && d === addDays(prev, 1) ? run + 1 : 1;
    if (run === need) {
      earned.push(d);
      run = 0;
    }
    prev = d;
  }
  // Still alive if they came today or yesterday.
  const count = prev && prev >= addDays(today, -1) ? run : 0;
  return { earned, count, visitedToday: prev === today };
}

const dishText = (dish) => (dish ? `${dish.name}${dish.variant ? ` (${dish.variant})` : ""}` : "dish");

// "🔥 4-day streak · 2 more days for a free Masala Chai"
export function streakText(count, need, dish) {
  const left = need - count;
  if (count <= 0) return `Order ${need} days in a row and get a free ${dishText(dish)}!`;
  return `🔥 ${count}-day streak · ${left} more day${left === 1 ? "" : "s"} in a row for a free ${dishText(dish)}`;
}

// The WhatsApp message for the scheme and the customer's own progress ("{name}" is filled in later).
export function loyaltyMessage(shopName, { count = 0, need, dish, link = "", reward = null }) {
  const free = dishText(dish);
  const lines = reward
    ? [`Hi {name}! 🎉 You've earned a FREE ${free} at ${shopName} for your ${need}-day streak. Come in by ${dayText(reward.validTo)} to enjoy it!`]
    : count > 0
      ? [`Hi {name}! 🔥 You're on a ${count}-day streak at ${shopName}.`, `Order ${need - count} more day${need - count === 1 ? "" : "s"} in a row and your next ${free} is FREE!`]
      : [`Hi {name}! 🔥 New at ${shopName}: order ${need} days in a row and the ${ordinal(need + 1)} day's ${free} is FREE!`];
  if (link) lines.push(`Order here: ${link}`);
  return lines.join("\n");
}

export const dayText = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const ordinal = (n) => `${n}${[, "st", "nd", "rd"][(n % 100 >> 3) ^ 1 && n % 10] || "th"}`;
