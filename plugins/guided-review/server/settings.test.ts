import assert from "node:assert/strict";
import test from "node:test";
import { readGhPath, readGuideAgent, type Settings } from "./settings.ts";

function settingsReading(state: Awaited<ReturnType<Settings["read"]>>): Pick<Settings, "read"> {
  return { read: async () => state };
}

test("runs the gh the settings name, and gh on the PATH when they name none", async () => {
  assert.equal(await readGhPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "/opt/gh/bin/gh", guideAgent: "claude" } })), "/opt/gh/bin/gh");
  assert.equal(await readGhPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "  ", guideAgent: "claude" } })), "gh");
  assert.equal(await readGhPath(settingsReading({ status: "invalid", revision: "1", error: "Invalid settings" })), "gh");
});

test("the guide agent is the one the settings name, and Claude's default model when they name none", async () => {
  const ready = (guideAgent: string) => settingsReading({ status: "ready", revision: "1", values: { ghPath: "gh", guideAgent } });
  assert.equal(await readGuideAgent(ready("codex/gpt-5.5")), "codex/gpt-5.5");
  assert.equal(await readGuideAgent(ready(" ")), "claude");
  assert.equal(await readGuideAgent(settingsReading({ status: "invalid", revision: "1", error: "Invalid settings" })), "claude");
});
