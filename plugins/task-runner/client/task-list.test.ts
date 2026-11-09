import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "../shared/task.ts";
import { filterTasks, groupTasks } from "./task-list.ts";

const task = (label: string, group = "app", source = "pnpm"): Task => ({
  id: `task: ${group}: ${label}`,
  label,
  group,
  source,
  command: source,
  args: [],
  cwd: "/repo",
  description: null,
  disabledReason: null,
});

const tasks = [task("build"), task("dev"), task("build", "web", "nx"), task("image", "web", "make")];
const shown = (query: string) => filterTasks(tasks, query).map((item) => `${item.group}/${item.label}`);

describe("filterTasks", () => {
  it("keeps everything for an empty query", () => {
    assert.equal(filterTasks(tasks, "   ").length, 4);
  });

  it("matches the label regardless of case", () => {
    assert.deepEqual(shown("BUI"), ["app/build", "web/build"]);
  });

  it("requires every word, which may match the group or source", () => {
    assert.deepEqual(shown("web build"), ["web/build"]);
    assert.deepEqual(shown("make"), ["web/image"]);
  });

  it("finds nothing when a word matches nothing", () => {
    assert.deepEqual(shown("build zzz"), []);
  });
});

describe("groupTasks", () => {
  it("keeps groups in the order they first appear", () => {
    assert.deepEqual(groupTasks(tasks).map((group) => [group.name, group.tasks.length]), [["app", 2], ["web", 2]]);
  });
});
