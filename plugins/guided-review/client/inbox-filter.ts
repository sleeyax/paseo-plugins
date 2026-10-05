import type { InboxPreferences, InboxSortKey } from "../shared/inbox-preferences.ts";
import { ReviewerStateSchema, type InboxItem, type ReviewerState } from "../shared/inbox.ts";
import { numberLabel } from "../shared/reference.ts";

/**
 * Whether the reviewer has something to do on it: never reviewed, asked again, an approval the forge
 * took back, or the change moved on since their review.
 */
export function needsAttention(item: InboxItem): boolean {
  return item.state === "requested" || item.state === "unapproved" || item.changedSinceReview === true;
}

/** Every word of `query` is in the title, the project, the author or the number as the forge writes it. */
export function matchesSearch(item: InboxItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  const text = [item.title, item.project, item.author, numberLabel(item.forge, item.number)].join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

const SORT_VALUES: Record<InboxSortKey, (item: InboxItem) => number> = {
  updated: (item) => Date.parse(item.updatedAt),
  created: (item) => Date.parse(item.createdAt),
  size: (item) => item.additions + item.deletions,
};

/** URLs that skip the check-off filter, as with no rows held. */
const NONE_HELD: ReadonlySet<string> = new Set();

/**
 * The items the list shows, filtered as the preferences say and by the search, in their sort order; ties go to the latest update.
 * A `held` row is shown whether or not the check-off filter would take it, so a row just checked off or unchecked stays put.
 */
export function visibleItems(items: readonly InboxItem[], preferences: InboxPreferences, query: string, held = NONE_HELD): InboxItem[] {
  const value = SORT_VALUES[preferences.sort.key];
  const direction = preferences.sort.descending ? -1 : 1;
  return items
    .filter((item) => matchesFilters(item, preferences, query) && (held.has(item.url) || passesCheckOff(item, preferences)))
    .sort((a, b) => direction * (value(a) - value(b)) || SORT_VALUES.updated(b) - SORT_VALUES.updated(a));
}

/** How many checked-off items the list leaves out that every other filter and the search would show. */
export function hiddenCheckedOff(items: readonly InboxItem[], preferences: InboxPreferences, query: string, held = NONE_HELD): number {
  return items.filter((item) => item.checkedOff && !held.has(item.url) && !passesCheckOff(item, preferences) && matchesFilters(item, preferences, query)).length;
}

/** Whether the check-off filter shows the item, which a held row is not asked. */
export function passesCheckOff(item: InboxItem, preferences: InboxPreferences): boolean {
  switch (preferences.checkedOff) {
    case "hide":
      return !item.checkedOff;
    case "show":
      return true;
    case "only":
      return item.checkedOff;
  }
}

function matchesFilters(item: InboxItem, preferences: InboxPreferences, query: string): boolean {
  return (
    (preferences.provider === "all" || item.forge === preferences.provider) &&
    preferences.states.includes(item.state) &&
    (!preferences.hideDrafts || !item.isDraft) &&
    (!preferences.needsAttention || needsAttention(item)) &&
    matchesSearch(item, query)
  );
}

/** Each reviewer state as a sentence names it mid-way. */
export const STATE_NAMES: Record<ReviewerState, string> = {
  requested: "requested",
  commented: "commented",
  "changes-requested": "changes requested",
  approved: "approved",
  unapproved: "approval reset",
};

/**
 * Which states the list shows, naming whichever side is shorter: `States: requested and commented`,
 * or `States: all but approved`.
 */
export function statesLabel(states: readonly ReviewerState[]): string {
  const hidden = ReviewerStateSchema.options.filter((state) => !states.includes(state));
  if (hidden.length === 0) return "States: all";
  if (states.length <= hidden.length) return `States: ${namesOf(states)}`;
  return `States: all but ${namesOf(hidden)}`;
}

function namesOf(states: readonly ReviewerState[]): string {
  const names = states.map((state) => STATE_NAMES[state]);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** How many reviews the list shows, of how many when the filters or the search hide some, and how many of those are checked off. */
export function countLabel(shown: number, total: number, checkedOff = 0): string {
  const noun = total === 1 ? "review" : "reviews";
  const count = shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
  return checkedOff > 0 ? `${count} · ${checkedOff} checked off` : count;
}

/** How long ago `iso` was, in the largest whole unit: `5m`, `3h`, `2d`, `6w`, `1y`; `now` under a minute. */
export function age(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (!(minutes >= 1)) return "now";
  const units: [number, string][] = [
    [60 * 24 * 365, "y"],
    [60 * 24 * 7, "w"],
    [60 * 24, "d"],
    [60, "h"],
    [1, "m"],
  ];
  const [size, unit] = units.find(([size]) => minutes >= size) ?? [1, "m"];
  return `${Math.floor(minutes / size)}${unit}`;
}
