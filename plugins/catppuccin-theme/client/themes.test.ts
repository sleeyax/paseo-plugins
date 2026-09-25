import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.client.ts";

test("registers all four flavours", () => {
  const added: PluginThemeContribution[] = [];
  const client = { addTheme: (theme: PluginThemeContribution) => added.push(theme) };

  contribute(client as unknown as PluginClientContext);

  assert.deepEqual(
    added.map((theme) => theme.id),
    ["latte", "frappe", "macchiato", "mocha"],
  );
});
