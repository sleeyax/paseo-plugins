import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_INBOX_PREFERENCES, type InboxPreferences } from "../shared/inbox-preferences.ts";
import type { InboxItem } from "../shared/inbox.ts";
import { age, countLabel, hiddenCheckedOff, matchesSearch, needsAttention, statesLabel, visibleItems } from "./inbox-filter.ts";

function item(number: number, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    forge: "github",
    host: "github.com",
    project: "acme/uploader",
    number,
    url: `https://github.com/acme/uploader/pull/${number}`,
    title: "Retry failed uploads",
    author: "author",
    isDraft: false,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    headSha: "b".repeat(40),
    additions: 10,
    deletions: 0,
    fileCount: 1,
    ci: null,
    state: "requested",
    viaTeam: null,
    changedSinceReview: null,
    pendingDrafts: 0,
    reviewId: null,
    local: null,
    checkedOff: false,
    ...overrides,
  };
}

const ALL: InboxPreferences = { ...DEFAULT_INBOX_PREFERENCES, states: ["requested", "commented", "changes-requested", "approved", "unapproved"] };

function numbers(items: InboxItem[]): number[] {
  return items.map((entry) => entry.number);
}

test("by default the newest update comes first and what the reviewer approved is hidden", () => {
  const items = [
    item(1, { updatedAt: "2026-09-01T00:00:00Z" }),
    item(2, { updatedAt: "2026-09-03T00:00:00Z", state: "approved" }),
    item(3, { updatedAt: "2026-09-02T00:00:00Z" }),
  ];

  assert.deepEqual(numbers(visibleItems(items, DEFAULT_INBOX_PREFERENCES, "")), [3, 1]);
  assert.deepEqual(numbers(visibleItems(items, ALL, "")), [2, 3, 1]);
});

test("filters by forge and drafts, and sorts by creation or size either way", () => {
  const items = [
    item(1, { forge: "gitlab", createdAt: "2026-08-01T00:00:00Z", additions: 5, deletions: 5 }),
    item(2, { isDraft: true, createdAt: "2026-08-03T00:00:00Z", additions: 100, deletions: 0 }),
    item(3, { createdAt: "2026-08-02T00:00:00Z", additions: 1, deletions: 1 }),
  ];

  assert.deepEqual(numbers(visibleItems(items, { ...ALL, provider: "gitlab" }, "")), [1]);
  assert.deepEqual(numbers(visibleItems(items, { ...ALL, hideDrafts: true, sort: { key: "created", descending: true } }, "")), [3, 1]);
  assert.deepEqual(numbers(visibleItems(items, { ...ALL, sort: { key: "size", descending: false } }, "")), [3, 1, 2]);
});

test("shows only the reviewer states chosen, updated since or not", () => {
  const items = [
    item(1),
    item(2, { state: "changes-requested", changedSinceReview: true }),
    item(3, { state: "commented", changedSinceReview: false }),
    item(4, { state: "requested", changedSinceReview: true }),
  ];

  assert.deepEqual(numbers(visibleItems(items, { ...ALL, states: ["requested"] }, "")), [1, 4]);
  assert.deepEqual(numbers(visibleItems(items, { ...ALL, states: ["commented", "changes-requested"] }, "")), [2, 3]);
});

test("checked-off items are hidden by default, shown among the rest, or shown alone", () => {
  const items = [item(1), item(2, { checkedOff: true }), item(3, { checkedOff: true, isDraft: true })];

  assert.deepEqual(numbers(visibleItems(items, ALL, "")), [1]);
  assert.deepEqual(numbers(visibleItems(items, { ...ALL, checkedOff: "show" }, "")), [1, 2, 3]);
  assert.deepEqual(numbers(visibleItems(items, { ...ALL, checkedOff: "only" }, "")), [2, 3]);
  assert.deepEqual(numbers(visibleItems(items, { ...ALL, checkedOff: "only", hideDrafts: true }, "")), [2], "with the other filters as well");
});

test("a held row stays whatever the check-off filter says, but not past the other filters", () => {
  const items = [item(1), item(2, { checkedOff: true }), item(3, { checkedOff: true, isDraft: true })];
  const held = new Set(items.map((entry) => entry.url));

  assert.deepEqual(numbers(visibleItems(items, ALL, "", held)), [1, 2, 3]);
  assert.deepEqual(numbers(visibleItems(items, { ...ALL, checkedOff: "only" }, "", held)), [1, 2, 3]);
  assert.deepEqual(numbers(visibleItems(items, { ...ALL, hideDrafts: true }, "", held)), [1, 2]);
});

test("the checked-off count is what the check-off filter alone hides", () => {
  const items = [item(1), item(2, { checkedOff: true }), item(3, { checkedOff: true, isDraft: true }), item(4, { checkedOff: true })];

  assert.equal(hiddenCheckedOff(items, ALL, ""), 3);
  assert.equal(hiddenCheckedOff(items, { ...ALL, hideDrafts: true }, ""), 2, "a draft the drafts filter hides anyway");
  assert.equal(hiddenCheckedOff(items, ALL, "", new Set([items[1]!.url])), 2, "a held row is shown");
  assert.equal(hiddenCheckedOff(items, { ...ALL, checkedOff: "show" }, ""), 0);
  assert.equal(hiddenCheckedOff(items, { ...ALL, checkedOff: "only" }, ""), 0);
});

test("the states label names whichever side is shorter", () => {
  assert.equal(statesLabel(ALL.states), "States: all");
  assert.equal(statesLabel(["requested"]), "States: requested");
  assert.equal(statesLabel(["requested", "commented"]), "States: requested and commented");
  assert.equal(statesLabel(["requested", "commented", "changes-requested", "unapproved"]), "States: all but approved");
  assert.equal(statesLabel(["requested", "commented", "changes-requested"]), "States: all but approved and approval reset");
});

test("needs attention is what was never reviewed, asked again, unapproved or changed since the review", () => {
  assert.equal(needsAttention(item(1)), true);
  assert.equal(needsAttention(item(1, { state: "unapproved" })), true);
  assert.equal(needsAttention(item(1, { state: "commented", changedSinceReview: true })), true);
  assert.equal(needsAttention(item(1, { state: "changes-requested", changedSinceReview: false })), false);
  assert.equal(needsAttention(item(1, { state: "approved", changedSinceReview: null })), false);
});

test("the search needs every word somewhere in the title, project, author or number as the forge writes it", () => {
  const mr = item(12, { forge: "gitlab", project: "example-group/service", title: "Add rate limiting", author: "kobe" });

  for (const query of ["", "rate", "RATE limit", "service !12", "kobe", "  limiting  "]) assert.equal(matchesSearch(mr, query), true, query);
  for (const query of ["#12", "rate github", "uploader"]) assert.equal(matchesSearch(mr, query), false, query);
});

test("an age is the largest whole unit", () => {
  const now = new Date("2026-10-05T12:00:00Z");

  assert.equal(age("2026-10-05T11:59:30Z", now), "now");
  assert.equal(age("2026-10-05T11:55:00Z", now), "5m");
  assert.equal(age("2026-10-05T09:00:00Z", now), "3h");
  assert.equal(age("2026-10-03T12:00:00Z", now), "2d");
  assert.equal(age("2026-08-20T12:00:00Z", now), "6w");
  assert.equal(age("2025-09-01T12:00:00Z", now), "1y");
  assert.equal(age("2026-10-06T12:00:00Z", now), "now");
});

test("countLabel gives the total alone until something is hidden", () => {
  assert.equal(countLabel(12, 12), "12 reviews");
  assert.equal(countLabel(1, 1), "1 review");
  assert.equal(countLabel(4, 12), "4 of 12 reviews");
  assert.equal(countLabel(1, 12), "1 of 12 reviews");
  assert.equal(countLabel(8, 12, 3), "8 of 12 reviews · 3 checked off");
});
