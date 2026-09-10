import assert from "node:assert/strict";
import test from "node:test";
import { isAdapterCommand, lockOwnerRefusal, ownsLock, type ProcessIdentity } from "./lock-owner.ts";
import { adapterBinaryPath, adapterEntryPath } from "./paths.ts";
import type { SessionLock } from "../shared/sessions.ts";

test("recognises the command the adapter is actually launched with", () => {
  // The bin wrapper execs the entry through a relative path, which is what shows up in /proc.
  assert.ok(isAdapterCommand("node /home/me/paseo-plugins/apps/claude-tty-acp/bin/../dist/cli.js"));
  assert.ok(isAdapterCommand("node /home/me/paseo-plugins/apps/claude-tty-acp/dist/cli.js --verbose"));
  // Tied to the paths the plugin itself would register, so a rename cannot quietly disarm the guard.
  assert.ok(adapterBinaryPath("/srv/checkout").includes("claude-tty-acp"));
  assert.ok(isAdapterCommand(`node ${adapterEntryPath("/srv/checkout")}`));
});

test("does not mistake Claude itself for the adapter", () => {
  // A native Claude carries the adapter's name only in the settings path it is handed.
  assert.ok(!isAdapterCommand("claude --session-id a --settings /tmp/claude-tty-acp-OQkDy5/settings.json"));
  // Installed as a bundle, Claude is itself `node <...>/cli.js` — both halves of the old substring test.
  assert.ok(
    !isAdapterCommand(
      "node /home/me/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js --settings /tmp/claude-tty-acp-OQkDy5/settings.json",
    ),
  );
  assert.ok(!isAdapterCommand("node /home/me/other/dist/cli.js"));
  assert.ok(!isAdapterCommand(""));
});

test("matches the entry file literally rather than as a pattern", () => {
  // The name is spliced into a regex, so its dot has to stay a dot.
  assert.ok(!isAdapterCommand("node /srv/apps/claude-tty-acp/dist/cliXjs"));
});

const LOCK: SessionLock = { pid: 4242, createdAt: 10_000, live: true };
function identity(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return { command: "node /srv/apps/claude-tty-acp/dist/cli.js", startedAt: 9_000, zombie: false, ...overrides };
}

test("accepts only the process that can have written the lock", () => {
  assert.ok(ownsLock(identity(), LOCK));
  // Started within the slack that a truncated or drifting clock reading costs.
  assert.ok(ownsLock(identity({ startedAt: 12_000 }), LOCK));
});

test("refuses a process that cannot be the lock's owner", () => {
  // A second adapter that inherited the PID: same command, but it started long after the lock.
  assert.ok(!ownsLock(identity({ startedAt: 900_000 }), LOCK));
  // A bystander whose arguments merely name the adapter's own entry file.
  assert.ok(!ownsLock(identity({ command: "tail -f /srv/apps/claude-tty-acp/dist/cli.js", startedAt: 900_000 }), LOCK));
  assert.ok(!ownsLock(identity({ zombie: true }), LOCK));
  assert.ok(!ownsLock(identity({ startedAt: null }), LOCK));
  assert.ok(!ownsLock(identity({ command: "claude --session-id a" }), LOCK));
});


test("says which check refused the process, not just that one did", () => {
  assert.equal(lockOwnerRefusal(identity(), LOCK), null);
  assert.equal(lockOwnerRefusal(identity({ zombie: true }), LOCK), "zombie");
  assert.equal(lockOwnerRefusal(identity({ command: "claude --session-id a" }), LOCK), "not-adapter");
  assert.equal(lockOwnerRefusal(identity({ startedAt: 900_000 }), LOCK), "started-after-lock");
  // A host that will not give a start time has not found a stranger; it has failed to look.
  assert.equal(lockOwnerRefusal(identity({ startedAt: null }), LOCK), "unknown-start");
});

test("reads a zombie as a zombie whatever its command line says", () => {
  // /proc leaves a reaped process with no command line of its own.
  assert.equal(lockOwnerRefusal(identity({ command: "", zombie: true }), LOCK), "zombie");
});
