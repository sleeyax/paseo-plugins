import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { settingsDocument } from "../shared/settings.ts";
import { fakeSettings } from "./fake-settings.ts";
import { mirrorSettings, snapshotOf } from "./settings-snapshot.ts";

async function snapshotFile(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-snapshot-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return path.join(directory, "state", "settings.json");
}

async function readSnapshot(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

/** A subscriber's write is queued behind the save that fired it, so one more refresh waits it out. */
async function settled(mirror: { refresh(): Promise<void> }): Promise<void> {
  await mirror.refresh();
}

test("resolves the bypass setting to a boolean, or to null when it follows the general one", () => {
  const values = (bypassAutoAccept: "inherit" | "on" | "off") => settingsDocument.schema.parse({ autoAccept: true, bypassAutoAccept });
  assert.deepEqual(snapshotOf(values("inherit")), { idleTimeoutMs: 60 * 60 * 1_000, autoAccept: true, bypassAutoAccept: null });
  assert.equal(snapshotOf(values("on")).bypassAutoAccept, true);
  assert.equal(snapshotOf(values("off")).bypassAutoAccept, false);
});

test("writes the defaults for a host that has saved nothing, so the adapter never guesses", async (t) => {
  const filePath = await snapshotFile(t);
  const mirror = mirrorSettings(fakeSettings(), filePath);
  t.after(() => mirror.stop());

  await mirror.refresh();
  assert.deepEqual(await readSnapshot(filePath), { idleTimeoutMs: 60 * 60 * 1_000, autoAccept: false, bypassAutoAccept: null });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("rewrites the snapshot when the host announces a save, which is what reaches open sessions", async (t) => {
  const filePath = await snapshotFile(t);
  const settings = fakeSettings();
  const mirror = mirrorSettings(settings, filePath);
  t.after(() => mirror.stop());
  await mirror.refresh();

  await settings.save({ idleTimeoutMs: 0, bypassAutoAccept: "on" });
  await settled(mirror);
  assert.deepEqual(await readSnapshot(filePath), { idleTimeoutMs: 0, autoAccept: false, bypassAutoAccept: true });
});

test("keeps the last good snapshot while the saved document is invalid", async (t) => {
  const filePath = await snapshotFile(t);
  const settings = fakeSettings();
  const mirror = mirrorSettings(settings, filePath);
  t.after(() => mirror.stop());
  await settings.save({ autoAccept: true });
  await settled(mirror);

  const warn = t.mock.method(console, "warn", () => {});
  await settings.corrupt();
  await settled(mirror);
  assert.deepEqual(await readSnapshot(filePath), { idleTimeoutMs: 60 * 60 * 1_000, autoAccept: true, bypassAutoAccept: null });
  assert.ok(warn.mock.callCount() > 0);
});

test("writes nothing at all for an invalid document it has no good copy of", async (t) => {
  const filePath = await snapshotFile(t);
  const settings = fakeSettings();
  t.mock.method(console, "warn", () => {});
  await settings.corrupt();

  const mirror = mirrorSettings(settings, filePath);
  t.after(() => mirror.stop());
  await mirror.refresh();
  await assert.rejects(stat(filePath), { code: "ENOENT" });
});

test("stops following the host once stopped", async (t) => {
  const filePath = await snapshotFile(t);
  const settings = fakeSettings();
  const mirror = mirrorSettings(settings, filePath);
  await mirror.refresh();
  mirror.stop();

  await settings.save({ idleTimeoutMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(((await readSnapshot(filePath)) as { idleTimeoutMs: number }).idleTimeoutMs, 60 * 60 * 1_000);
});
