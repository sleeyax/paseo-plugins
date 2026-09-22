import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import { DEFAULT_SETTINGS } from "../shared/presence.ts";
import { updateSettings } from "./settings-writes.ts";

type Write = { revision: string; values: unknown };

/** The host's settings RPCs, answering writes from a script and recording what they were sent. */
function fakeStore(writeResults: Array<"saved" | "conflict" | "invalid">) {
  let revision = 0;
  const writes: Write[] = [];
  const rpc = (async (contract: { name: string }, input: unknown) => {
    if (contract.name.endsWith(".read")) {
      return { status: "ready", revision: String(++revision), values: DEFAULT_SETTINGS };
    }
    writes.push(input as Write);
    const status = writeResults.shift() ?? "saved";
    if (status === "saved") return { status, revision: String(++revision), values: (input as Write).values };
    return { status, error: `write was ${status}` };
  }) as PluginCommandCapabilities["rpc"];
  return { rpc, writes };
}

test("writes the change against the revision it read", async () => {
  const store = fakeStore(["saved"]);
  await updateSettings(store.rpc, (settings) => ({ ...settings, enabled: false }));
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0]!.revision, "1");
  assert.equal((store.writes[0]!.values as { enabled: boolean }).enabled, false);
});

test("reads again and retries once when another client saved in between", async () => {
  const store = fakeStore(["conflict", "saved"]);
  await updateSettings(store.rpc, (settings) => ({ ...settings, enabled: false }));
  assert.deepEqual(store.writes.map((write) => write.revision), ["1", "2"]);
});

test("gives up rather than looping when the conflicts keep coming", async () => {
  const store = fakeStore(["conflict", "conflict", "saved"]);
  await assert.rejects(updateSettings(store.rpc, (settings) => settings), /kept changing/);
  assert.equal(store.writes.length, 2);
});

test("reports a change the host refused instead of retrying it", async () => {
  const store = fakeStore(["invalid"]);
  await assert.rejects(updateSettings(store.rpc, (settings) => settings), /write was invalid/);
  assert.equal(store.writes.length, 1);
});
