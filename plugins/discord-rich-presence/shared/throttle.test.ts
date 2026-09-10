import assert from "node:assert/strict";
import { test } from "node:test";
import { decideWrite, MIN_WRITE_INTERVAL_MS } from "./throttle.ts";

const NOW = 1_700_000_000_000;

test("writes the first payload immediately", () => {
  assert.deepEqual(
    decideWrite({ payload: "a", lastPayload: null, lastSentAt: null, now: NOW }),
    { send: true },
  );
});

test("skips a payload identical to the one Discord already shows", () => {
  assert.deepEqual(
    decideWrite({ payload: "a", lastPayload: "a", lastSentAt: NOW - 60_000, now: NOW }),
    { send: false, retryInMs: null },
  );
});

test("holds a changed payload back until the interval has passed", () => {
  assert.deepEqual(
    decideWrite({ payload: "b", lastPayload: "a", lastSentAt: NOW - 1_000, now: NOW }),
    { send: false, retryInMs: MIN_WRITE_INTERVAL_MS - 1_000 },
  );
});

test("writes once the interval has passed", () => {
  assert.deepEqual(
    decideWrite({ payload: "b", lastPayload: "a", lastSentAt: NOW - MIN_WRITE_INTERVAL_MS, now: NOW }),
    { send: true },
  );
});

test("treats clearing the activity as a payload of its own", () => {
  assert.deepEqual(
    decideWrite({ payload: null, lastPayload: "a", lastSentAt: null, now: NOW }),
    { send: true },
  );
  assert.deepEqual(
    decideWrite({ payload: null, lastPayload: null, lastSentAt: NOW, now: NOW }),
    { send: false, retryInMs: null },
  );
});
