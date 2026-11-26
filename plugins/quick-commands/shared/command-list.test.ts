import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moveCommand, newCommandId, removeCommand, upsertCommand } from "./command-list.ts";
import type { Command } from "./commands.ts";

const command = (id: string): Command => ({ id, name: id, command: `echo ${id}`, confirm: false });
const ids = (commands: Command[]) => commands.map((each) => each.id);

describe("command list", () => {
  it("replaces a command in place, or appends a new one", () => {
    const list = [command("a"), command("b")];
    assert.deepEqual(upsertCommand(list, { ...command("a"), name: "renamed" })[0]?.name, "renamed");
    assert.deepEqual(ids(upsertCommand(list, command("c"))), ["a", "b", "c"]);
  });

  it("removes by ID", () => {
    assert.deepEqual(ids(removeCommand([command("a"), command("b")], "a")), ["b"]);
  });

  it("moves a command one place, and not past either end", () => {
    const list = [command("a"), command("b"), command("c")];
    assert.deepEqual(ids(moveCommand(list, "b", -1)), ["b", "a", "c"]);
    assert.deepEqual(ids(moveCommand(list, "b", 1)), ["a", "c", "b"]);
    assert.deepEqual(ids(moveCommand(list, "a", -1)), ["a", "b", "c"]);
    assert.deepEqual(ids(moveCommand(list, "c", 1)), ["a", "b", "c"]);
  });

  it("makes distinct IDs", () => {
    assert.notEqual(newCommandId(1, () => 0.1), newCommandId(1, () => 0.2));
  });
});
