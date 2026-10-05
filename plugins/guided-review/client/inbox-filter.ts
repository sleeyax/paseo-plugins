import type { InboxPreferences, InboxSortKey } from "../shared/inbox-preferences.ts";
import type { InboxItem } from "../shared/inbox.ts";
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

/** The items the list shows, filtered as the preferences say and by the search, in their sort order; ties go to the latest update. */
export function visibleItems(items: readonly InboxItem[], preferences: InboxPreferences, query: string): InboxItem[] {
  const value = SORT_VALUES[preferences.sort.key];
  const direction = preferences.sort.descending ? -1 : 1;
  return items
    .filter((item) => preferences.provider === "all" || item.forge === preferences.provider)
    .filter((item) => !preferences.hideApproved || item.state !== "approved")
    .filter((item) => !preferences.hideDrafts || !item.isDraft)
    .filter((item) => !preferences.needsAttention || needsAttention(item))
    .filter((item) => matchesSearch(item, query))
    .sort((a, b) => direction * (value(a) - value(b)) || SORT_VALUES.updated(b) - SORT_VALUES.updated(a));
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
