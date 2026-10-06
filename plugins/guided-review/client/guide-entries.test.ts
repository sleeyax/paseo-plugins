import assert from "node:assert/strict";
import test from "node:test";
import type { LinkedDraft } from "../shared/drafts.ts";
import type { LayeredGuide, LayeredNode } from "../shared/guide.ts";
import { summariseProgress, type Understood } from "../shared/progress.ts";
import {
  draftCounts,
  draftEntry,
  entryOrder,
  firstOpenInGroup,
  guideGroups,
  layoutFor,
  nextNotUnderstood,
  resolveSelection,
  startEntry,
  stepEntry,
} from "./guide-entries.ts";

function node(id: string, layer: number): LayeredNode {
  return {
    id,
    title: id,
    summary: id,
    why: id,
    behaviour: [],
    covers: [{ path: `src/${id}.ts`, hunks: [], lines: [] }],
    decisions: [],
    dependencies: [],
    layer,
    leaf: false,
  };
}

const guide: LayeredGuide = {
  overview: { idea: "idea", needToKnows: [], decisions: [], attention: [{ nodeId: "store", reason: "why" }] },
  nodes: [node("store", 0), node("api", 1), node("cache", 1)],
  supporting: [
    { path: "pnpm-lock.yaml", category: "lockfile" },
    { path: "src/store.test.ts", category: "test" },
    { path: "README.md", category: "docs" },
  ],
  unsorted: ["src/stray.ts"],
};

const groups = guideGroups(guide);

function progress(marks: Partial<Understood>) {
  return summariseProgress(guide, "head", { nodes: [], files: [], ...marks });
}

function draft(from: LinkedDraft["from"], location: LinkedDraft["location"] = { kind: "general" }): LinkedDraft {
  return { id: "1", body: "body", location, from, quote: null };
}

test("orders the groups trunk first, with Tests and Documentation split from Supporting", () => {
  assert.deepEqual(
    groups.map((group) => [group.title, group.entries.map((entry) => entry.key)]),
    [
      ["Layer 1", ["node:store"]],
      ["Layer 2", ["node:api", "node:cache"]],
      ["Tests", ["file:src/store.test.ts"]],
      ["Documentation", ["file:README.md"]],
      ["Supporting", ["file:pnpm-lock.yaml"]],
      ["Unsorted", ["file:src/stray.ts"]],
    ],
  );
  assert.deepEqual(entryOrder(groups).slice(0, 3), ["description", "overview", "node:store"]);
});

test("leaves out an empty group", () => {
  const titles = guideGroups({ ...guide, supporting: [], unsorted: [] }).map((group) => group.title);
  assert.deepEqual(titles, ["Layer 1", "Layer 2"]);
});

test("starts on the description while nothing is marked, else on the first entry not yet understood", () => {
  assert.equal(startEntry(groups, null), "description");
  assert.equal(startEntry(groups, progress({})), "description");
  assert.equal(startEntry([], null), "description");
  assert.equal(startEntry(groups, progress({ nodes: ["store", "api"] })), "node:cache");
  const everything = progress({ nodes: ["store", "api", "cache"], files: ["pnpm-lock.yaml", "src/store.test.ts", "README.md", "src/stray.ts"] });
  assert.equal(startEntry(groups, everything), "overview");
});

test("keeps a selection the guide still has, and falls back for one it lost", () => {
  const marked = progress({ nodes: ["store"] });
  assert.equal(resolveSelection("node:cache", groups, marked), "node:cache");
  assert.equal(resolveSelection("node:gone", groups, marked), "node:api");
  assert.equal(resolveSelection(null, groups, marked), "node:api");
  assert.equal(resolveSelection("finish", groups, marked, ["finish"]), "finish");
});

test("steps through the entries in navigator order", () => {
  assert.equal(stepEntry(groups, "description", -1), null);
  assert.equal(stepEntry(groups, "overview", -1), "description");
  assert.equal(stepEntry(groups, "overview", 1), "node:store");
  assert.equal(stepEntry(groups, "node:cache", 1), "file:src/store.test.ts");
  assert.equal(stepEntry(groups, "file:src/stray.ts", 1), null);
  assert.equal(stepEntry(groups, "finish", 1), null);
});

test("finds the next entry not yet understood, wrapping round", () => {
  const marked = progress({ nodes: ["api"], files: ["src/store.test.ts"] });
  assert.equal(nextNotUnderstood(groups, "node:store", marked), "node:cache");
  assert.equal(nextNotUnderstood(groups, "node:cache", marked), "file:README.md");
  assert.equal(nextNotUnderstood(groups, "file:src/stray.ts", marked), "node:store");
  assert.equal(nextNotUnderstood(groups, "overview", marked), "node:store");
  assert.equal(nextNotUnderstood(groups, "description", marked), "node:store");
  const allButStray = progress({ nodes: ["store", "api", "cache"], files: ["pnpm-lock.yaml", "src/store.test.ts", "README.md"] });
  assert.equal(nextNotUnderstood(groups, "file:src/stray.ts", allButStray), null);
});

test("opens a group at its first entry not yet understood", () => {
  const layer2 = groups[1]!;
  assert.equal(firstOpenInGroup(layer2, progress({ nodes: ["api"] })), "node:cache");
  assert.equal(firstOpenInGroup(layer2, progress({ nodes: ["api", "cache"] })), "node:api");
});

test("finds the entry a draft was written from", () => {
  assert.equal(draftEntry(groups, draft({ kind: "overview" })), "overview");
  assert.equal(draftEntry(groups, draft({ kind: "node", nodeId: "api" })), "node:api");
  assert.equal(draftEntry(groups, draft(null, { kind: "file", path: "src/stray.ts" })), "file:src/stray.ts");
  assert.equal(draftEntry(groups, draft({ kind: "node", nodeId: "gone" }, { kind: "file", path: "README.md" })), "file:README.md");
  assert.equal(draftEntry(groups, draft(null)), null);
  assert.equal(draftEntry(groups, draft(null, { kind: "file", path: "src/api.ts" })), null);
});

test("counts the drafts of each entry", () => {
  const counts = draftCounts(groups, [draft({ kind: "node", nodeId: "api" }), draft({ kind: "node", nodeId: "api" }), draft({ kind: "overview" }), draft(null)]);
  assert.deepEqual([...counts], [
    ["node:api", 2],
    ["overview", 1],
  ]);
});

test("lays the panel out by its width, and always stacks in the phone apps", () => {
  assert.equal(layoutFor(999, "web"), "stack");
  assert.equal(layoutFor(1000, "web"), "two");
  assert.equal(layoutFor(1280, "web"), "three");
  assert.equal(layoutFor(2000, "ios"), "stack");
});
