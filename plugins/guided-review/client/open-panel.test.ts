import assert from "node:assert/strict";
import test from "node:test";
import { openPanelWhenReady } from "./open-panel.ts";

const noWait = async () => {};

test("opens the panel once the app knows the workspace", async () => {
  let calls = 0;
  const opened = await openPanelWhenReady(
    () => {
      calls += 1;
      if (calls < 3) throw new Error("Plugin panel context is unavailable");
    },
    { sleep: noWait },
  );
  assert.equal(opened, true);
  assert.equal(calls, 3);
});

test("gives up after its attempts", async () => {
  let calls = 0;
  const opened = await openPanelWhenReady(
    () => {
      calls += 1;
      throw new Error("Plugin panel context is unavailable");
    },
    { attempts: 4, sleep: noWait },
  );
  assert.equal(opened, false);
  assert.equal(calls, 4);
});
