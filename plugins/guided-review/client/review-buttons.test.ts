import assert from "node:assert/strict";
import test from "node:test";
import { reconcileButtons } from "./review-buttons.ts";

type FakeButton = { workspaceId: string; removed: boolean; remove(): void };

function fakeAdd(added: FakeButton[]) {
  return (workspaceId: string) => {
    const button: FakeButton = { workspaceId, removed: false, remove: () => (button.removed = true) };
    added.push(button);
    return button;
  };
}

test("each review workspace keeps one button, and a workspace that is gone loses its button", () => {
  const added: FakeButton[] = [];
  const buttons = new Map<string, FakeButton>();

  reconcileButtons(buttons, ["wks_1", "wks_2"], fakeAdd(added));
  reconcileButtons(buttons, ["wks_2", "wks_3"], fakeAdd(added));

  assert.deepEqual(
    added.map(({ workspaceId, removed }) => ({ workspaceId, removed })),
    [
      { workspaceId: "wks_1", removed: true },
      { workspaceId: "wks_2", removed: false },
      { workspaceId: "wks_3", removed: false },
    ],
  );
  assert.deepEqual([...buttons.keys()].sort(), ["wks_2", "wks_3"]);
});
