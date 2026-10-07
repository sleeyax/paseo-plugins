import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COLUMN_WIDTHS,
  dragColumn,
  fitColumns,
  keepColumnWidths,
  MIN_DETAIL_WIDTH,
  readColumnWidths,
  REMEMBERED_WORKSPACES,
  type WidthStorage,
} from "./column-widths.ts";

function memoryStorage(): WidthStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

test("draws the widths as set when the detail pane keeps its minimum", () => {
  assert.deepEqual(fitColumns({ navigator: 400, sidebar: 500 }, 1500, "three"), { navigator: 400, sidebar: 500 });
});

test("keeps each width within its bounds", () => {
  assert.deepEqual(fitColumns({ navigator: 50, sidebar: 9000 }, 3000, "three"), { navigator: 200, sidebar: 600 });
});

test("shrinks both columns in proportion to their widths for a narrow window", () => {
  const fitted = fitColumns({ navigator: 400, sidebar: 600 }, 1280, "three");
  assert.deepEqual(fitted, { navigator: 320, sidebar: 480 });
  assert.equal(1280 - fitted.navigator - fitted.sidebar, MIN_DETAIL_WIDTH);
});

test("holds a column at its minimum and takes the rest from the other", () => {
  const fitted = fitColumns({ navigator: 200, sidebar: 600 }, 1280, "three");
  assert.deepEqual(fitted, { navigator: 200, sidebar: 600 });
  assert.deepEqual(fitColumns({ navigator: 480, sidebar: 300 }, 1000, "three"), { navigator: 240, sidebar: 280 });
});

test("fits the two-column layout's one column, the sidebar, alone", () => {
  assert.deepEqual(fitColumns({ navigator: 480, sidebar: 600 }, 1000, "two"), { navigator: 480, sidebar: 520 });
});

test("a drag stops where the detail pane would go under its minimum", () => {
  const drawn = { navigator: 300, sidebar: 400 };
  assert.deepEqual(dragColumn(drawn, "sidebar", 590, 1280, "three"), { navigator: 300, sidebar: 500 });
  assert.deepEqual(dragColumn(drawn, "navigator", 100, 1280, "three"), { navigator: 200, sidebar: 400 });
  assert.deepEqual(dragColumn(drawn, "sidebar", 590, 1280, "two"), { navigator: 300, sidebar: 590 });
});

test("a workspace never resized reads the defaults and stores nothing", () => {
  const storage = memoryStorage();
  assert.deepEqual(readColumnWidths(storage, "w1"), DEFAULT_COLUMN_WIDTHS);
  keepColumnWidths(storage, "w1", DEFAULT_COLUMN_WIDTHS);
  assert.equal(storage.items.size, 0);
});

test("remembers each workspace's widths on their own", () => {
  const storage = memoryStorage();
  keepColumnWidths(storage, "w1", { navigator: 300, sidebar: 400 });
  keepColumnWidths(storage, "w2", { navigator: 250, sidebar: 500 });
  assert.deepEqual(readColumnWidths(storage, "w1"), { navigator: 300, sidebar: 400 });
  assert.deepEqual(readColumnWidths(storage, "w2"), { navigator: 250, sidebar: 500 });
});

test("forgets a workspace reset to the defaults", () => {
  const storage = memoryStorage();
  keepColumnWidths(storage, "w1", { navigator: 300, sidebar: 400 });
  keepColumnWidths(storage, "w2", { navigator: 250, sidebar: 500 });
  keepColumnWidths(storage, "w1", DEFAULT_COLUMN_WIDTHS);
  assert.deepEqual(readColumnWidths(storage, "w1"), DEFAULT_COLUMN_WIDTHS);
  keepColumnWidths(storage, "w2", DEFAULT_COLUMN_WIDTHS);
  assert.equal(storage.items.size, 0);
});

test("keeps only the most recently resized workspaces", () => {
  const storage = memoryStorage();
  for (let index = 0; index <= REMEMBERED_WORKSPACES; index += 1) keepColumnWidths(storage, `w${index}`, { navigator: 300, sidebar: 400 });
  keepColumnWidths(storage, "w1", { navigator: 310, sidebar: 400 });
  assert.deepEqual(readColumnWidths(storage, "w0"), DEFAULT_COLUMN_WIDTHS);
  assert.deepEqual(readColumnWidths(storage, "w1"), { navigator: 310, sidebar: 400 });
  assert.deepEqual(readColumnWidths(storage, `w${REMEMBERED_WORKSPACES}`), { navigator: 300, sidebar: 400 });
});

test("reads what it cannot parse as the defaults", () => {
  const storage = memoryStorage();
  storage.setItem("guided-review.column-widths", "{not json");
  assert.deepEqual(readColumnWidths(storage, "w1"), DEFAULT_COLUMN_WIDTHS);
  storage.setItem("guided-review.column-widths", JSON.stringify([{ workspaceId: "w1", navigator: "wide" }]));
  assert.deepEqual(readColumnWidths(storage, "w1"), DEFAULT_COLUMN_WIDTHS);
});
