import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRun, timeAgo } from "./run-status.ts";

const MINUTE = 60_000;

describe("describeRun", () => {
  it("names the exit code of a failed run", () => {
    const run = { status: "failed" as const, exitCode: 2, startedAt: 0, finishedAt: 0, output: [] };
    assert.deepEqual(describeRun(run, 10 * MINUTE), { label: "Failed with exit code 2 · 10 min ago", tone: "danger" });
  });

  it("calls an interrupted run's outcome unknown rather than failed", () => {
    const run = { status: "interrupted" as const, exitCode: null, startedAt: 0, finishedAt: null, output: [] };
    assert.equal(describeRun(run, 0).tone, "warning");
  });

  it("says when a command never ran", () => {
    assert.equal(describeRun(undefined, 0).label, "Not run yet");
  });
});

describe("timeAgo", () => {
  it("rounds to the largest unit", () => {
    assert.equal(timeAgo(0, 10_000), "just now");
    assert.equal(timeAgo(0, 5 * MINUTE), "5 min ago");
    assert.equal(timeAgo(0, 3 * 60 * MINUTE), "3 h ago");
    assert.equal(timeAgo(0, 2 * 24 * 60 * MINUTE), "2 d ago");
  });
});
