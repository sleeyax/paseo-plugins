import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "./elapsed.ts";

test("counts up the way discord does", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(4_200), "00:04");
  assert.equal(formatElapsed(61_000), "01:01");
  assert.equal(formatElapsed(59 * 60_000 + 59_000), "59:59");
  assert.equal(formatElapsed(60 * 60_000), "1:00:00");
  assert.equal(formatElapsed(25 * 60 * 60_000 + 61_000), "25:01:01");
});

test("never counts backwards from a clock that jumped", () => {
  assert.equal(formatElapsed(-5_000), "00:00");
});
