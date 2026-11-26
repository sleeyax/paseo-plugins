import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import type { LastRuns } from "../shared/runs.ts";
import { CommandRuns, type Launch } from "./command-runs.ts";
import type { RunStore } from "./run-store.ts";

const launch: Launch = (command) => spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], detached: true });

function memoryStore(initial: LastRuns = {}): RunStore & { saved: LastRuns[] } {
  const saved: LastRuns[] = [];
  return {
    saved,
    load: async () => structuredClone(initial),
    save: async (runs) => void saved.push(structuredClone(runs)),
  };
}

async function settled(runs: CommandRuns, id: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (runs.isRunning(id)) {
    if (Date.now() > deadline) throw new Error(`${id} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("CommandRuns", () => {
  it("records a successful run with its output", async () => {
    const store = memoryStore();
    const runs = new CommandRuns({ launch, store });
    await runs.load();

    runs.start({ id: "a", command: "echo one; echo two >&2" });
    assert.equal(runs.snapshot().a?.status, "running");
    await settled(runs, "a");
    await runs.flush();

    const run = runs.snapshot().a;
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.exitCode, 0);
    assert.notEqual(run?.finishedAt, null);
    assert.deepEqual([...(run?.output ?? [])].sort(), ["one", "two"]);
    assert.equal(store.saved.at(-1)?.a?.status, "succeeded");
  });

  it("records a non-zero exit as failed", async () => {
    const runs = new CommandRuns({ launch, store: memoryStore() });
    await runs.load();
    runs.start({ id: "a", command: "exit 3" });
    await settled(runs, "a");
    assert.equal(runs.snapshot().a?.status, "failed");
    assert.equal(runs.snapshot().a?.exitCode, 3);
  });

  it("refuses a second run of a running command", async () => {
    const runs = new CommandRuns({ launch, store: memoryStore() });
    await runs.load();
    runs.start({ id: "a", command: "sleep 5" });
    assert.throws(() => runs.start({ id: "a", command: "sleep 5" }), /already running/);
    runs.stop("a");
    await settled(runs, "a");
  });

  it("stops the whole process group and records the run as stopped", async () => {
    const runs = new CommandRuns({ launch, store: memoryStore() });
    await runs.load();
    runs.start({ id: "a", command: "sleep 30 & sleep 30; wait" });
    runs.stop("a");
    await settled(runs, "a");
    assert.equal(runs.snapshot().a?.status, "stopped");
  });

  it("loads a run left running by an earlier process as interrupted", async () => {
    const store = memoryStore({ a: { status: "running", exitCode: null, startedAt: 1, finishedAt: null, output: ["half"] } });
    const runs = new CommandRuns({ launch, store });
    await runs.load();
    assert.equal(runs.snapshot().a?.status, "interrupted");
    assert.deepEqual(runs.snapshot().a?.output, ["half"]);
  });

  it("forgets the runs of deleted commands, waiting for one still running to finish", async () => {
    const store = memoryStore({ gone: { status: "succeeded", exitCode: 0, startedAt: 1, finishedAt: 2, output: [] } });
    const runs = new CommandRuns({ launch, store });
    await runs.load();
    runs.start({ id: "running", command: "sleep 0.2" });

    runs.retain(["kept"]);
    assert.equal(runs.snapshot().gone, undefined);
    assert.equal(runs.snapshot().running?.status, "running");

    await settled(runs, "running");
    assert.equal(runs.snapshot().running, undefined);
  });

  it("records a shell that cannot start as failed", async () => {
    const runs = new CommandRuns({
      launch: () => spawn("/nonexistent/shell", [], { stdio: ["ignore", "pipe", "pipe"] }),
      store: memoryStore(),
    });
    await runs.load();
    runs.start({ id: "a", command: "true" });
    await settled(runs, "a");
    assert.equal(runs.snapshot().a?.status, "failed");
    assert.match(runs.snapshot().a?.output.join("\n") ?? "", /ENOENT/);
  });
});
