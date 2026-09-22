import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, MANAGED_APPLICATION_ID, type PresenceSnapshot } from "./presence.ts";
import {
  coerceApplicationId,
  knownProjects,
  settingsDocument,
  withProjectDetailLevel,
} from "./settings.ts";

test("a host that never saved reads as the defaults", () => {
  assert.deepEqual(settingsDocument.schema.parse({}), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.applicationId, MANAGED_APPLICATION_ID);
});

test("keeps an application id the user cleared", () => {
  assert.equal(settingsDocument.schema.parse({ applicationId: null }).applicationId, null);
});

test("refuses a document the plugin would have to guess at", () => {
  for (const values of [
    { defaultDetailLevel: "verbose" },
    { applicationId: "not-an-id" },
    { projectDetailLevels: { "/work/client": { displayName: "client", level: "verbose" } } },
    { projectDetailLevels: { "": { displayName: "nowhere", level: "hidden" } } },
    { projectDetailLevels: [{ rootPath: "/work/client", displayName: "client", level: "hidden" }] },
  ]) {
    assert.equal(settingsDocument.schema.safeParse(values).success, false, JSON.stringify(values));
  }
});

test("accepts a snowflake application id and trims it", () => {
  assert.equal(coerceApplicationId("  1234567890123456789 "), "1234567890123456789");
});

test("rejects anything that is not a snowflake", () => {
  assert.equal(coerceApplicationId("not-an-id"), null);
  assert.equal(coerceApplicationId("1234"), null);
  assert.equal(coerceApplicationId(1234567890123456789), null);
});

test("setting a level and going back to the default round-trips", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  const hidden = withProjectDetailLevel(DEFAULT_SETTINGS, project, "hidden");
  assert.deepEqual(hidden.projectDetailLevels, { "/work/client": { displayName: "client", level: "hidden" } });
  assert.deepEqual(withProjectDetailLevel(hidden, project, null).projectDetailLevels, {});
});

test("setting a level twice replaces it rather than stacking it", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  const once = withProjectDetailLevel(DEFAULT_SETTINGS, project, "hidden");
  const twice = withProjectDetailLevel(once, project, "projects");
  assert.deepEqual(twice.projectDetailLevels, { "/work/client": { displayName: "client", level: "projects" } });
});

test("a project set to the level the default already has keeps its own entry", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  const settings = withProjectDetailLevel(DEFAULT_SETTINGS, project, "detailed");
  assert.equal(Object.keys(settings.projectDetailLevels).length, 1);
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
  assert.deepEqual(knownProjects(DEFAULT_SETTINGS.projectDetailLevels, snapshot), [
    { rootPath: "/work/alpha", displayName: "alpha", level: null },
    { rootPath: "/work/zeta", displayName: "zeta", level: null },
  ]);
});

test("carries the saved level onto the project the daemon reports", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  const settings = withProjectDetailLevel(DEFAULT_SETTINGS, project, "hidden");
  assert.deepEqual(knownProjects(settings.projectDetailLevels, snapshotOf([], [project])), [{ ...project, level: "hidden" }]);
});

/** A level the user can no longer see is a level the user can no longer undo. */
test("keeps a project the daemon has forgotten but the settings still name", () => {
  const settings = withProjectDetailLevel(
    DEFAULT_SETTINGS,
    { rootPath: "/work/gone", displayName: "gone" },
    "hidden",
  );
  assert.deepEqual(knownProjects(settings.projectDetailLevels, snapshotOf([], [])), [
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
  assert.deepEqual(knownProjects(settings.projectDetailLevels, snapshot), [
    { rootPath: "/work/client", displayName: "Acme", level: "projects" },
  ]);
});

test("lists a project only once when a workspace and the daemon both name it", () => {
  const project = { rootPath: "/work/client", displayName: "client" };
  assert.equal(knownProjects(DEFAULT_SETTINGS.projectDetailLevels, snapshotOf([project], [project])).length, 1);
});
