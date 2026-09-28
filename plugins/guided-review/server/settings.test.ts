import assert from "node:assert/strict";
import test from "node:test";
import { readGhPath, type Settings } from "./settings.ts";

function settingsReading(state: Awaited<ReturnType<Settings["read"]>>): Pick<Settings, "read"> {
  return { read: async () => state };
}

test("runs the gh the settings name, and gh on the PATH when they name none", async () => {
  assert.equal(await readGhPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "/opt/gh/bin/gh" } })), "/opt/gh/bin/gh");
  assert.equal(await readGhPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "  " } })), "gh");
  assert.equal(await readGhPath(settingsReading({ status: "invalid", revision: "1", error: "Invalid settings" })), "gh");
});
