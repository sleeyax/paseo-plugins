import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_INBOX_PREFERENCES, type InboxPreferences } from "../shared/inbox-preferences.ts";
import type { InboxItem } from "../shared/inbox.ts";
import { age, matchesSearch, needsAttention, visibleItems } from "./inbox-filter.ts";

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
    local: null,
    ...overrides,
  };
}

const ALL: InboxPreferences = { ...DEFAULT_INBOX_PREFERENCES, hideApproved: false };

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
