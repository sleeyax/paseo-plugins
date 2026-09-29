import assert from "node:assert/strict";
import test from "node:test";
import { readGhPath, readGlabPath, readGuideAgent, type Settings } from "./settings.ts";

function settingsReading(state: Awaited<ReturnType<Settings["read"]>>): Pick<Settings, "read"> {
  return { read: async () => state };
}

test("runs the gh the settings name, and gh on the PATH when they name none", async () => {
  assert.equal(await readGhPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "/opt/gh/bin/gh", glabPath: "glab", guideAgent: "claude", guideAgentEffort: "", guideAgentMode: "", syntaxTheme: "github" } })), "/opt/gh/bin/gh");
  assert.equal(await readGhPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "  ", glabPath: "glab", guideAgent: "claude", guideAgentEffort: "", guideAgentMode: "", syntaxTheme: "github" } })), "gh");
  assert.equal(await readGhPath(settingsReading({ status: "invalid", revision: "1", error: "Invalid settings" })), "gh");
});

test("runs the glab the settings name, and glab on the PATH when they name none", async () => {
  assert.equal(
    await readGlabPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "gh", glabPath: "/usr/bin/glab", guideAgent: "claude", guideAgentEffort: "", guideAgentMode: "", syntaxTheme: "github" } })),
    "/usr/bin/glab",
  );
  assert.equal(await readGlabPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "gh", glabPath: "", guideAgent: "claude", guideAgentEffort: "", guideAgentMode: "", syntaxTheme: "github" } })), "glab");
  assert.equal(await readGlabPath(settingsReading({ status: "invalid", revision: "1", error: "Invalid settings" })), "glab");
});

test("the guide agent is the one the settings name, and Claude TTY's default model when they name none", async () => {
  const ready = (guideAgent: string, guideAgentEffort = "", guideAgentMode = "") =>
    settingsReading({ status: "ready", revision: "1", values: { ghPath: "gh", glabPath: "glab", guideAgent, guideAgentEffort, guideAgentMode, syntaxTheme: "github" } });
  assert.deepEqual(await readGuideAgent(ready("codex/gpt-5.5")), { agent: "codex/gpt-5.5", effort: "", mode: "" });
  assert.deepEqual(await readGuideAgent(ready(" ", " high ", " default ")), { agent: "claude-tty", effort: "high", mode: "default" });
  assert.deepEqual(await readGuideAgent(settingsReading({ status: "invalid", revision: "1", error: "Invalid settings" })), {
    agent: "claude-tty",
    effort: "",
    mode: "",
  });
});
