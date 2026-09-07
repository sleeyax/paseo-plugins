import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { watchWorkingDirectory } from "./workspace-watchdog.ts";

const settle = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

test("stops the adapter once its working directory has stayed gone", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-workspace-"));
  let removed = 0;
  const stop = watchWorkingDirectory(directory, () => {
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
  // Four misses are asked for and the directory is back well inside them, so the checks that miss
  // it are real ones — the count has to be reset by its return rather than never reached.
  const stop = watchWorkingDirectory(directory, () => {
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
