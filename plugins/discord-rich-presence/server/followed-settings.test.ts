import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type PresenceSettings } from "../shared/presence.ts";
import { followedSettings } from "./followed-settings.ts";

const hidden: PresenceSettings = { ...DEFAULT_SETTINGS, defaultDetailLevel: "hidden" };

test("takes a valid document", () => {
  assert.deepEqual(followedSettings(hidden, { status: "ready", revision: "2", values: DEFAULT_SETTINGS }), DEFAULT_SETTINGS);
});

test("keeps the current settings when the document is invalid", () => {
  assert.equal(followedSettings(hidden, { status: "invalid", revision: "2", error: "bad" }), hidden);
});

test("has nothing to show until a valid document arrives", () => {
  assert.equal(followedSettings(null, { status: "invalid", revision: "1", error: "bad" }), null);
});
