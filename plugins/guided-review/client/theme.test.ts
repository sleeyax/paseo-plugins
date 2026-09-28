import assert from "node:assert/strict";
import test from "node:test";
import { tint } from "./theme.ts";

test("tints a background with a status colour, whether either is hex or rgb()", () => {
  assert.equal(tint("#00ff00", "#000000", 0.5), "#008000");
  assert.equal(tint("#0f0", "rgb(255, 255, 255)", 0.25), "#bfffbf");
  assert.equal(tint("rgba(255, 0, 0, 1)", "#101010", 0), "#101010");
});

test("leaves the background as it is when a colour cannot be read", () => {
  assert.equal(tint("hsl(120 100% 50%)", "#101010", 0.5), "#101010");
  assert.equal(tint("#00ff00", "transparent", 0.5), "transparent");
});
