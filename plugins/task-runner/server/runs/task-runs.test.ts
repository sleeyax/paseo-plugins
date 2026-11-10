import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { Task } from "../../shared/task.ts";
import { createFakeTerminals } from "./fake-terminals.ts";
import { createTaskHistory } from "./task-history.ts";
import { TaskRuns } from "./task-runs.ts";

const WORKSPACE = "wks_1";
const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task: build",
  label: "build",
  group: "app",
  source: "pnpm",
  command: "pnpm",
  args: ["run", "build"],
  cwd: "/repo",
  description: null,
  disabledReason: null,
  ...overrides,
});

describe("TaskRuns", () => {
  let fake: ReturnType<typeof createFakeTerminals>;
  let now: number;
  let historyFile: string;
  let runs: TaskRuns;

  const started = async (overrides: Partial<Task> = {}) => {
    await runs.run(WORKSPACE, task(overrides));
    const terminal = fake.terminals.at(-1);
    assert.ok(terminal);
    return terminal;
  };
  const state = async () => {
    const [only] = await runs.states(WORKSPACE);
    assert.ok(only, "expected a run");
    return only;
  };

  beforeEach(() => {
    fake = createFakeTerminals();
    now = 1_000;
    historyFile = join(mkdtempSync(join(tmpdir(), "task-runner-history-")), "history.json");
    runs = new TaskRuns({ terminals: fake.port, history: createTaskHistory(historyFile), now: () => now });
  });

  describe("running a task", () => {
    it("creates one terminal named after the task, in its directory, through the sh wrapper", async () => {
      const terminal = await started();
      assert.equal(terminal.name, "task: build");
      assert.equal(terminal.cwd, "/repo");
      assert.equal(terminal.command, "sh");
      assert.equal(terminal.args[0], "-c");
      assert.equal(terminal.args.at(-1), "pnpm run build");
    });

    it("quotes arguments but leaves the command as shell text", async () => {
      const terminal = await started({ command: "npm run dev -- --host", args: ["a b", "it's"] });
      assert.equal(terminal.args.at(-1), `npm run dev -- --host 'a b' 'it'\\''s'`);
    });

    it("replaces the old terminal when run again", async () => {
      const first = await started();
      const second = await started();
      assert.notEqual(first.id, second.id);
      assert.deepEqual(fake.terminals.map((terminal) => terminal.id), [second.id]);
    });

    it("refuses a disabled task", async () => {
      await assert.rejects(runs.run(WORKSPACE, task({ disabledReason: "Needs a prompt." })), /Needs a prompt/);
      assert.equal(fake.terminals.length, 0);
    });
  });

  describe("status", () => {
    it("is running until the exit marker appears, with the latest output", async () => {
      const terminal = await started();
      terminal.lines = ["compiling", "done 1/2", "", ""];
      assert.deepEqual(await state(), {
        taskId: "task: build",
        terminalId: terminal.id,
        status: "running",
        exitCode: null,
        canForceKill: false,
        output: ["compiling", "done 1/2"],
      });
    });

    it("drops blank lines before the first output", async () => {
      const terminal = await started();
      terminal.lines = ["", "", "> build", "", "tsc"];
      assert.deepEqual((await state()).output, ["> build", "", "tsc"]);
    });

    it("keeps about fifty lines of output", async () => {
      const terminal = await started();
      terminal.lines = Array.from({ length: 80 }, (_, index) => `line ${index}`);
      const { output } = await state();
      assert.equal(output.length, 50);
      assert.equal(output[0], "line 30");
      assert.equal(output.at(-1), "line 79");
    });

    it("reports success and leaves the wrapper's lines and the leftover shell out of the output", async () => {
      const terminal = await started();
      terminal.lines = ["built", "logout", "", "::task-exit=0::", "/repo", "❯ "];
      const current = await state();
      assert.equal(current.status, "succeeded");
      assert.equal(current.exitCode, 0);
      assert.deepEqual(current.output, ["built"]);
    });

    it("reports failure with the exit code", async () => {
      const terminal = await started();
      terminal.lines = ["boom", "", "::task-exit=2::"];
      const current = await state();
      assert.equal(current.status, "failed");
      assert.equal(current.exitCode, 2);
    });

    it("stays correct after someone types into the leftover shell", async () => {
      const terminal = await started();
      terminal.lines = ["ok", "", "::task-exit=0::", "❯ echo ::task-exit=9::", "::task-exit=9::", "❯ false"];
      const current = await state();
      assert.equal(current.status, "succeeded");
      assert.deepEqual(current.output, ["ok"]);
    });

    it("does not take a marker in the middle of a line for the real one", async () => {
      const terminal = await started();
      terminal.lines = ["❯ echo ::task-exit=0::"];
      assert.equal((await state()).status, "running");
    });

    it("keeps a finished status once the marker has scrolled out of the buffer", async () => {
      const terminal = await started();
      terminal.lines = ["ok", "::task-exit=0::"];
      await state();
      terminal.lines = ["typed", "a lot", "later"];
      const current = await state();
      assert.equal(current.status, "succeeded");
      assert.deepEqual(current.output, ["ok"]);
    });

    it("finds a finished run again from the buffer alone, as after an app or plugin reload", async () => {
      const terminal = await started();
      terminal.lines = ["ok", "::task-exit=0::"];
      const fresh = new TaskRuns({ terminals: fake.port, history: createTaskHistory(historyFile) });
      assert.equal((await fresh.states(WORKSPACE))[0]?.status, "succeeded");
    });

    it("ignores terminals that are not task terminals", async () => {
      await fake.port.create({ workspaceId: WORKSPACE, name: "zsh", cwd: "/", command: "zsh", args: [] });
      assert.deepEqual(await runs.states(WORKSPACE), []);
    });

    it("leaves out a terminal that closes while it is being read", async () => {
      const terminal = await started();
      fake.port.capture = async () => {
        throw new Error(`Terminal ${terminal.id} is gone.`);
      };
      assert.deepEqual(await runs.states(WORKSPACE), []);
    });
  });

  describe("stopping", () => {
    it("sends C-c and shows the row stopping until the task exits", async () => {
      const terminal = await started();
      await runs.stop(WORKSPACE, terminal.id);
      assert.deepEqual(fake.interrupted, [terminal.id]);
      assert.equal((await state()).status, "stopping");
    });

    it("shows stopped whatever exit code the task chose, keeping the output", async () => {
      const terminal = await started();
      await runs.stop(WORKSPACE, terminal.id);
      terminal.lines = ["serving", "^C", "", "::task-exit=1::", "❯ "];
      const current = await state();
      assert.equal(current.status, "stopped");
      assert.deepEqual(current.output, ["serving"]);
      assert.deepEqual(fake.terminals.map((candidate) => candidate.id), [terminal.id]);
    });

    it("shows stopped when C-c was typed into the terminal directly", async () => {
      const terminal = await started();
      terminal.lines = ["^C", "", "::task-exit=130::"];
      assert.equal((await state()).status, "stopped");
    });

    it("offers force kill only after five seconds", async () => {
      const terminal = await started();
      await runs.stop(WORKSPACE, terminal.id);
      now += 4_999;
      assert.equal((await state()).canForceKill, false);
      now += 1;
      assert.equal((await state()).canForceKill, true);
    });

    it("force kill removes the terminal", async () => {
      const terminal = await started();
      await runs.forceKill(terminal.id);
      assert.deepEqual(await runs.states(WORKSPACE), []);
    });

    it("does not send C-c to the leftover shell of a finished task", async () => {
      const terminal = await started();
      terminal.lines = ["::task-exit=0::"];
      await state();
      await runs.stop(WORKSPACE, terminal.id);
      assert.deepEqual(fake.interrupted, []);
    });

    it("does not record a stop for a task that finished since the last poll", async () => {
      const terminal = await started();
      terminal.lines = ["ok", "::task-exit=0::"];
      await runs.stop(WORKSPACE, terminal.id);
      assert.deepEqual(fake.interrupted, []);
      assert.equal((await state()).status, "succeeded");
    });

    it("forgets a stop when the task is restarted", async () => {
      const first = await started();
      await runs.stop(WORKSPACE, first.id);
      const second = await started();
      second.lines = ["::task-exit=0::"];
      assert.equal((await state()).status, "succeeded");
    });
  });

  describe("recent tasks", () => {
    it("lists the tasks run in a workspace, most recent first, each once", async () => {
      await runs.run(WORKSPACE, task({ id: "task: a" }));
      await runs.run(WORKSPACE, task({ id: "task: b" }));
      await runs.run(WORKSPACE, task({ id: "task: a" }));
      assert.deepEqual(await runs.recent(WORKSPACE), ["task: a", "task: b"]);
    });

    it("keeps each workspace's history apart", async () => {
      await runs.run(WORKSPACE, task({ id: "task: a" }));
      await runs.run("wks_2", task({ id: "task: b" }));
      assert.deepEqual(await runs.recent(WORKSPACE), ["task: a"]);
    });

    it("keeps the ten most recent", async () => {
      for (let index = 0; index < 12; index += 1) await runs.run(WORKSPACE, task({ id: `task: ${index}` }));
      const recent = await runs.recent(WORKSPACE);
      assert.equal(recent.length, 10);
      assert.equal(recent[0], "task: 11");
      assert.equal(recent.at(-1), "task: 2");
    });

    it("does not record a disabled task", async () => {
      await assert.rejects(runs.run(WORKSPACE, task({ disabledReason: "No." })));
      assert.deepEqual(await runs.recent(WORKSPACE), []);
    });

    it("survives a plugin reload", async () => {
      await runs.run(WORKSPACE, task({ id: "task: a" }));
      const fresh = new TaskRuns({ terminals: fake.port, history: createTaskHistory(historyFile) });
      assert.deepEqual(await fresh.recent(WORKSPACE), ["task: a"]);
    });

    it("starts empty when the history file is unreadable", async () => {
      const broken = join(mkdtempSync(join(tmpdir(), "task-runner-history-")), "history.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(broken, "{ nope");
      const fresh = new TaskRuns({ terminals: fake.port, history: createTaskHistory(broken) });
      assert.deepEqual(await fresh.recent(WORKSPACE), []);
      await fresh.run(WORKSPACE, task());
      assert.deepEqual(await fresh.recent(WORKSPACE), ["task: build"]);
    });
  });

  describe("rerunning the last task", () => {
    it("runs the most recent task again, replacing its terminal", async () => {
      await runs.run(WORKSPACE, task({ id: "task: a", command: "first" }));
      const ran = await runs.rerunLast(WORKSPACE);
      assert.equal(ran?.id, "task: a");
      assert.deepEqual(fake.terminals.map((terminal) => [terminal.name, terminal.args.at(-1)]), [["task: a", "first run build"]]);
    });

    it("answers null when nothing has run in the workspace", async () => {
      assert.equal(await runs.rerunLast(WORKSPACE), null);
      assert.equal(fake.terminals.length, 0);
    });
  });
});
