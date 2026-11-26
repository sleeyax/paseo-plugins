import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Command } from "../shared/commands.ts";
import { commandCenterItems, type CommandCenterItem } from "./command-center.ts";

const command = (id: string, overrides: Partial<Command> = {}): Command => ({ id, name: id, command: "true", confirm: false, ...overrides });

function fakeCommandCenter() {
  const items = new Map<string, CommandCenterItem>();
  let registrations = 0;
  const add = (item: CommandCenterItem) => {
    registrations += 1;
    items.set(item.id, item);
    return () => void items.delete(item.id);
  };
  return { items, add, registrations: () => registrations };
}

describe("commandCenterItems", () => {
  it("adds an item per command and removes deleted ones", () => {
    const center = fakeCommandCenter();
    const { sync } = commandCenterItems(center.add);
    sync([command("a"), command("b")]);
    assert.deepEqual([...center.items.keys()], ["run-a", "run-b"]);
    sync([command("b")]);
    assert.deepEqual([...center.items.keys()], ["run-b"]);
  });

  it("re-registers only items whose title, icon or confirmation changed", () => {
    const center = fakeCommandCenter();
    const { sync } = commandCenterItems(center.add);
    sync([command("a")]);
    sync([command("a", { command: "false" })]);
    assert.equal(center.registrations(), 1);
    sync([command("a", { name: "Renamed" })]);
    assert.equal(center.registrations(), 2);
    assert.equal(center.items.get("run-a")?.title, "Run: Renamed");
  });

  it("hands a command that asks first to the screen without running it", async () => {
    const center = fakeCommandCenter();
    commandCenterItems(center.add).sync([command("a", { confirm: true })]);
    const opened: unknown[] = [];
    await center.items.get("run-a")?.onSelect({
      context: "global",
      rpc: async () => assert.fail("must not run"),
      openScreen: (input: unknown) => void opened.push(input),
    } as never);
    assert.equal((opened[0] as { params: { confirm: string } }).params.confirm, "a");
  });

  it("clears every item", () => {
    const center = fakeCommandCenter();
    const { sync, clear } = commandCenterItems(center.add);
    sync([command("a"), command("b")]);
    clear();
    assert.equal(center.items.size, 0);
  });
});
