import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type PresenceSnapshot } from "./presence.ts";
import {
  coerceApplicationId,
  coerceSettings,
  knownProjects,
  withProjectDetailLevel,
} from "./settings.ts";

test("an empty file yields the defaults", () => {
  assert.deepEqual(coerceSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(coerceSettings({}), DEFAULT_SETTINGS);
});

test("keeps an application id the user cleared", () => {
  assert.equal(coerceSettings({ applicationId: null }).applicationId, null);
});

test("reads the settings out of the stored envelope", () => {
  const stored = { version: 1, settings: { enabled: false, defaultDetailLevel: "hidden" } };
  const settings = coerceSettings(stored);
  assert.equal(settings.enabled, false);
  assert.equal(settings.defaultDetailLevel, "hidden");
});

test("rejects a detail level it does not know", () => {
  assert.equal(coerceSettings({ defaultDetailLevel: "verbose" }).defaultDetailLevel, "detailed");
});

test("accepts a snowflake application id and trims it", () => {
  assert.equal(coerceApplicationId("  1234567890123456789 "), "1234567890123456789");
});

test("rejects anything that is not a snowflake", () => {
  assert.equal(coerceApplicationId("not-an-id"), null);
  assert.equal(coerceApplicationId("1234"), null);
  assert.equal(coerceApplicationId(1234567890123456789), null);
});

test("drops project entries with no path and de-duplicates the rest", () => {
  const settings = coerceSettings({
    projectDetailLevels: [
      { rootPath: "/work/client", displayName: "client", level: "hidden" },
      { rootPath: "/work/client", displayName: "client again", level: "detailed" },
      { displayName: "nowhere", level: "hidden" },
    ],
  });
  assert.deepEqual(settings.projectDetailLevels, [
    { rootPath: "/work/client", displayName: "client", level: "hidden" },
  ]);
});

test("drops a project entry whose level it cannot read rather than defaulting it", () => {
  const settings = coerceSettings({
    projectDetailLevels: [{ rootPath: "/work/client", displayName: "client", level: "verbose" }],
  });
  assert.deepEqual(settings.projectDetailLevels, []);
});

test("names a project after its path when it has no display name", () => {
  const settings = coerceSettings({
    projectDetailLevels: [{ rootPath: "/work/client", level: "hidden" }],
  });
  assert.equal(settings.projectDetailLevels[0]?.displayName, "/work/client");
});

test("setting a level and going back to the default round-trips", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  const hidden = withProjectDetailLevel(DEFAULT_SETTINGS, project, "hidden");
  assert.deepEqual(hidden.projectDetailLevels, [{ ...project, level: "hidden" }]);
  assert.deepEqual(withProjectDetailLevel(hidden, project, null).projectDetailLevels, []);
});

test("setting a level twice replaces it rather than stacking it", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  const once = withProjectDetailLevel(DEFAULT_SETTINGS, project, "hidden");
  const twice = withProjectDetailLevel(once, project, "projects");
  assert.deepEqual(twice.projectDetailLevels, [{ ...project, level: "projects" }]);
});

test("a project set to the level the default already has keeps its own entry", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  const settings = withProjectDetailLevel(DEFAULT_SETTINGS, project, "detailed");
  assert.equal(settings.projectDetailLevels.length, 1);
});

function snapshotOf(
  workspaces: { rootPath: string; displayName: string }[],
  projects: { rootPath: string; displayName: string }[],
): PresenceSnapshot {
  return {
    workspaces: workspaces.map((project, index) => ({
      id: `ws_${index}`,
      projectRootPath: project.rootPath,
      projectDisplayName: project.displayName,
      workspaceName: "main",
      status: "running",
      activityAt: null,
      statusEnteredAt: null,
    })),
    agents: [],
    projects,
  };
}

test("lists a registered project with no workspace open, sorted by name", () => {
  const snapshot = snapshotOf(
    [{ rootPath: "/work/zeta", displayName: "zeta" }],
    [
      { rootPath: "/work/zeta", displayName: "zeta" },
      { rootPath: "/work/alpha", displayName: "alpha" },
    ],
  );
  assert.deepEqual(knownProjects(DEFAULT_SETTINGS, snapshot), [
    { rootPath: "/work/alpha", displayName: "alpha", level: null },
    { rootPath: "/work/zeta", displayName: "zeta", level: null },
  ]);
});

test("carries the saved level onto the project the daemon reports", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  const settings = withProjectDetailLevel(DEFAULT_SETTINGS, project, "hidden");
  assert.deepEqual(knownProjects(settings, snapshotOf([], [project])), [{ ...project, level: "hidden" }]);
});

/** A level the user can no longer see is a level the user can no longer undo. */
test("keeps a project the daemon has forgotten but the settings still name", () => {
  const settings = withProjectDetailLevel(
    DEFAULT_SETTINGS,
    { rootPath: "/work/gone", displayName: "gone" },
    "hidden",
  );
  assert.deepEqual(knownProjects(settings, snapshotOf([], [])), [
    { rootPath: "/work/gone", displayName: "gone", level: "hidden" },
  ]);
});

test("prefers the daemon's name over the one saved with the level", () => {
  const settings = withProjectDetailLevel(
    DEFAULT_SETTINGS,
    { rootPath: "/work/client", displayName: "client" },
    "projects",
  );
  const snapshot = snapshotOf([], [{ rootPath: "/work/client", displayName: "Acme" }]);
  assert.deepEqual(knownProjects(settings, snapshot), [
    { rootPath: "/work/client", displayName: "Acme", level: "projects" },
  ]);
});

test("lists a project only once when a workspace and the daemon both name it", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  assert.equal(knownProjects(DEFAULT_SETTINGS, snapshotOf([project], [project])).length, 1);
});
