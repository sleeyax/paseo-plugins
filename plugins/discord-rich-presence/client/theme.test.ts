import assert from "node:assert/strict";
import test from "node:test";
import { alpha, derivePalette, isDarkColor, parseColor } from "./theme.ts";

/** Paseo's own zinc dark and light themes, the ones the derived shades are measured against. */
const ZINC_DARK = {
  surface0: "#18181b",
  surface1: "#1f1f22",
  surface2: "#27272a",
  border: "#27272a",
  foreground: "#fafafa",
  foregroundMuted: "#a1a1aa",
  accent: "#20744A",
  accentForeground: "#ffffff",
  statusSuccess: "#6cb17b",
  statusWarning: "#c09664",
  statusDanger: "#d8847b",
};

const LIGHT = {
  ...ZINC_DARK,
  surface0: "#ffffff",
  surface1: "#fafafa",
  surface2: "#f4f4f5",
  border: "#e4e4e7",
  foreground: "#1a1a1e",
  foregroundMuted: "#71717a",
  statusSuccess: "#3e704a",
  statusWarning: "#7b5d39",
  statusDanger: "#9d433b",
};

/**
 * Distance in 0-255 channel steps, so a shade can be checked against the one paseo itself ships.
 * The step keeps the hue of surface2, while paseo's zinc shades drift towards blue as they lighten,
 * so the higher surfaces are expected to land near their counterpart rather than on it.
 */
function distance(left: string, right: string): number {
  const a = parseColor(left)!;
  const b = parseColor(right)!;
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

test("parses the color notations a theme can use", () => {
  assert.deepEqual(parseColor("#18181b"), { r: 24, g: 24, b: 27 });
  assert.deepEqual(parseColor("#abc"), { r: 170, g: 187, b: 204 });
  assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3 });
  assert.equal(parseColor("papayawhip"), null);
  assert.equal(alpha("var(--surface)", 0.5), "var(--surface)");
});

test("passes the host's own tokens straight through", () => {
  const palette = derivePalette({ colors: ZINC_DARK });
  assert.equal(palette.surface1, ZINC_DARK.surface1);
  assert.equal(palette.surface2, ZINC_DARK.surface2);
  assert.equal(palette.border, ZINC_DARK.border);
  assert.equal(palette.statusSuccess, ZINC_DARK.statusSuccess);
  assert.equal(palette.statusWarning, ZINC_DARK.statusWarning);
  assert.equal(palette.statusDanger, ZINC_DARK.statusDanger);
});

test("reproduces the shades paseo's dark theme keeps above the exposed ramp", () => {
  const palette = derivePalette({ colors: ZINC_DARK });
  assert.equal(palette.isDark, true);
  assert.ok(distance(palette.surface3, "#3f3f46") <= 8);
  assert.ok(distance(palette.surface4, "#52525b") <= 8);
  assert.ok(distance(palette.borderAccent, "#303036") <= 8);
  assert.ok(distance(palette.foregroundExtraMuted, "#71717a") <= 4);
});

test("reproduces the shades paseo's light theme keeps above the exposed ramp", () => {
  const palette = derivePalette({ colors: LIGHT });
  assert.equal(palette.isDark, false);
  assert.ok(distance(palette.surface3, "#e4e4e7") <= 8);
  assert.ok(distance(palette.surface4, "#d4d4d8") <= 8);
  assert.ok(distance(palette.borderAccent, "#ececf1") <= 8);
  assert.ok(distance(palette.foregroundExtraMuted, "#a1a1aa") <= 4);
});

test("falls back to the host's own surfaces when a color cannot be read", () => {
  const palette = derivePalette({ colors: { ...ZINC_DARK, surface2: "var(--surface)" } });
  assert.equal(palette.surface3, "var(--surface)");
  assert.equal(palette.isDark, true);
  assert.equal(palette.surface4, "var(--surface)");
  assert.equal(palette.borderAccent, ZINC_DARK.border);
  assert.equal(palette.foregroundExtraMuted, ZINC_DARK.foregroundMuted);
});

test("reads the theme's brightness off whichever surface is legible", () => {
  assert.equal(derivePalette({ colors: { ...LIGHT, surface2: "var(--surface)" } }).isDark, false);
  assert.equal(derivePalette({ colors: { ...LIGHT, surface0: "var(--surface)" } }).isDark, false);
  assert.equal(derivePalette({ colors: { ...ZINC_DARK, surface0: "var(--surface)" } }).isDark, true);
});

test("measures and tints", () => {
  assert.equal(isDarkColor({ r: 24, g: 24, b: 27 }), true);
  assert.equal(isDarkColor({ r: 250, g: 250, b: 250 }), false);
  assert.equal(alpha("#18181b", 0.4), "rgba(24, 24, 27, 0.4)");
});
