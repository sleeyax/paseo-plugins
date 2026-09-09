import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceWatchdog, watchDirectory } from "./workspace-watchdog.ts";

const settle = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

test("stops the adapter once a session's directory has stayed gone", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspace-"));
  let removed = 0;
  const stop = watchDirectory(directory, () => {
    removed += 1;
  }, 10);
  try {
    await settle(60);
    assert.equal(removed, 0, "gave up on a directory that was still there");

    await rm(directory, { force: true, recursive: true });
    await settle(120);
    assert.equal(removed, 1, "did not stop for a directory that had gone");

    // The watch is over: a directory that stays gone reports it once, not on every check after.
    await settle(60);
    assert.equal(removed, 1);
  } finally {
    stop();
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps a session whose directory is replaced rather than removed", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspace-replaced-"));
  const directory = path.join(parent, "workspace");
  await mkdir(directory);
  let removed = 0;
  // Four misses are asked for and the directory is back well inside them, so the checks that miss it are real ones — the count has to be reset by its return rather than never reached.
  const stop = watchDirectory(directory, () => {
    removed += 1;
  }, 50, 4);
  try {
    await rm(directory, { force: true, recursive: true });
    await settle(120);
    await mkdir(directory);
    await settle(300);
    assert.equal(removed, 0, "stopped a session whose workspace was only replaced");
  } finally {
    stop();
    await rm(parent, { force: true, recursive: true });
  }
});

test("keeps a session whose directory cannot be read for any other reason", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspace-unreadable-"));
  const file = path.join(parent, "not-a-directory");
  await writeFile(file, "");
  let removed = 0;
  // Anything under a regular file fails with ENOTDIR rather than ENOENT, which is a failure to look and not a directory that has gone.
  const stop = watchDirectory(path.join(file, "workspace"), () => {
    removed += 1;
  }, 10);
  try {
    await settle(120);
    assert.equal(removed, 0, "stopped a session over a directory it could not read");
  } finally {
    stop();
    await rm(parent, { force: true, recursive: true });
  }
});

test("waits for every session's directory to go before stopping the adapter", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspaces-"));
  const first = path.join(parent, "first");
  const second = path.join(parent, "second");
  await mkdir(first);
  await mkdir(second);
  let stopped = 0;
  const watchdog = new WorkspaceWatchdog(() => {
    stopped += 1;
  }, 10);
  try {
    watchdog.watch("session-1", first);
    watchdog.watch("session-2", second);

    await rm(first, { force: true, recursive: true });
    await settle(120);
    assert.equal(stopped, 0, "stopped an adapter that still had a session to serve");

    await rm(second, { force: true, recursive: true });
    await settle(120);
    assert.equal(stopped, 1, "did not stop an adapter whose every session had gone");
  } finally {
    watchdog.stop();
    await rm(parent, { force: true, recursive: true });
  }
});
