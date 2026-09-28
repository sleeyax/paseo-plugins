import assert from "node:assert/strict";
import test from "node:test";
import { readGhPath, readGlabPath, type Settings } from "./settings.ts";

function settingsReading(state: Awaited<ReturnType<Settings["read"]>>): Pick<Settings, "read"> {
  return { read: async () => state };
}

test("runs the gh the settings name, and gh on the PATH when they name none", async () => {
  assert.equal(await readGhPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "/opt/gh/bin/gh", glabPath: "glab" } })), "/opt/gh/bin/gh");
  assert.equal(await readGhPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "  ", glabPath: "glab" } })), "gh");
  assert.equal(await readGhPath(settingsReading({ status: "invalid", revision: "1", error: "Invalid settings" })), "gh");
});

test("runs the glab the settings name, and glab on the PATH when they name none", async () => {
  assert.equal(
    await readGlabPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "gh", glabPath: "/usr/bin/glab" } })),
    "/usr/bin/glab",
  );
  assert.equal(await readGlabPath(settingsReading({ status: "ready", revision: "1", values: { ghPath: "gh", glabPath: "" } })), "glab");
  assert.equal(await readGlabPath(settingsReading({ status: "invalid", revision: "1", error: "Invalid settings" })), "glab");
});
