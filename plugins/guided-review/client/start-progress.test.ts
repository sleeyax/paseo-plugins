import assert from "node:assert/strict";
import test from "node:test";
import type { LocalReview } from "../shared/inbox.ts";
import { describePreparing, isSettled } from "./start-progress.ts";

function local(overrides: Partial<LocalReview> = {}): LocalReview {
  return { header: null, preparing: null, guide: "ready", workspaceId: "wks_1", ...overrides };
}

test("a review is followed until its start has ended and its guide is no longer being generated", () => {
  assert.equal(isSettled(undefined), false);
  assert.equal(isSettled(local({ preparing: { phase: "cloning", message: null } })), false);
  assert.equal(isSettled(local({ guide: "generating" })), false);

  assert.equal(isSettled(null), true);
  assert.equal(isSettled(local({ preparing: { phase: "failed", message: "Could not read it" }, guide: "generating" })), true);
  assert.equal(isSettled(local({ guide: "failed" })), true);
  assert.equal(isSettled(local()), true);
});

test("a row describes its start while it runs and once it failed, and nothing after it ended", () => {
  assert.deepEqual(describePreparing(local({ preparing: { phase: "reading", message: null } })), { text: "Reading the PR or MR…", tone: "muted" });
  assert.deepEqual(describePreparing(local({ preparing: { phase: "failed", message: "Could not read it" } })), { text: "Could not read it", tone: "danger" });
  assert.equal(describePreparing(local()), null);
  assert.equal(describePreparing(null), null);
});
