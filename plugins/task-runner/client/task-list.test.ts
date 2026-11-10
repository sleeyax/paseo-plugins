import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "../shared/task.ts";
import { buildSections, filterTasks, groupTasks } from "./task-list.ts";

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

describe("buildSections", () => {
  const layout = (options: Partial<Parameters<typeof buildSections>[1]> = {}) =>
    buildSections(tasks, { query: "", recentIds: [], collapsed: new Set(), ...options });
  const rows = (result: ReturnType<typeof buildSections>) =>
    result.sections.map((section) => [section.title, section.rows.map((row) => `${row.index}:${row.task.group}/${row.task.label}`)]);

  it("numbers the rows of every group in order for the keyboard", () => {
    assert.deepEqual(rows(layout()), [
      ["app", ["0:app/build", "1:app/dev"]],
      ["web", ["2:web/build", "3:web/image"]],
    ]);
    assert.deepEqual(layout().navigable.map((item) => item.label), ["build", "dev", "build", "image"]);
  });

  it("puts recently run tasks first, under Recent, with their group shown", () => {
    const result = layout({ recentIds: ["task: web: image", "task: app: dev"] });
    assert.deepEqual(rows(result)[0], ["Recent", ["0:web/image", "1:app/dev"]]);
    assert.equal(result.sections[0]?.rows[0]?.showGroup, true);
    assert.equal(result.sections[1]?.rows[0]?.index, 2);
  });

  it("filters recent tasks too, and skips ones no longer listed", () => {
    const result = layout({ query: "image", recentIds: ["task: gone: x", "task: web: image", "task: app: dev"] });
    assert.deepEqual(rows(result), [
      ["Recent", ["0:web/image"]],
      ["web", ["1:web/image"]],
    ]);
  });

  it("shows at most five recent tasks", () => {
    const many = Array.from({ length: 7 }, (_, index) => task(`t${index}`));
    const result = buildSections(many, { query: "", recentIds: many.map((item) => item.id), collapsed: new Set() });
    assert.equal(result.sections[0]?.rows.length, 5);
  });

  it("leaves a collapsed group's rows out of the keyboard order, unless searching", () => {
    assert.deepEqual(rows(layout({ collapsed: new Set(["app"]) })), [
      ["app", []],
      ["web", ["0:web/build", "1:web/image"]],
    ]);
    assert.equal(layout({ collapsed: new Set(["app"]) }).sections[0]?.open, false);
    assert.equal(layout({ collapsed: new Set(["app"]), query: "dev" }).sections[0]?.open, true);
  });

  it("gives a single group no title", () => {
    const result = buildSections([task("a"), task("b")], { query: "", recentIds: [], collapsed: new Set() });
    assert.deepEqual(result.sections.map((section) => section.title), [null]);
  });
});
