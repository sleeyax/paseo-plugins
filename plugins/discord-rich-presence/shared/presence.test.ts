import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANONYMOUS_DETAILS,
  DEFAULT_SETTINGS,
  renderActivity,
  STALE_AFTER_MS,
  type AgentActivity,
  type PresenceSettings,
  type PresenceSnapshot,
  type WorkspaceActivity,
} from "./presence.ts";

const START = 1_700_000_000_000;
const NOW = START + 60_000;

function workspace(overrides: Partial<WorkspaceActivity> = {}): WorkspaceActivity {
  return {
    id: "wks_main",
    projectRootPath: "/home/dev/paseo-plugins",
    projectDisplayName: "paseo-plugins",
    workspaceName: "main",
    status: "done",
    activityAt: null,
    statusEnteredAt: START,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PresenceSnapshot> = {}): PresenceSnapshot {
  return {
    workspaces: [workspace()],
    agents: [],
    projects: [],
    ...overrides,
  };
}

/** Agents are counted through the workspace they sit in, so a fixture has to name one. */
function agents(
  tally: { running?: number; needsAttention?: number },
  workspaceId = "wks_main",
): AgentActivity[] {
  const list: AgentActivity[] = [];
  for (let index = 0; index < (tally.running ?? 0); index += 1) {
    list.push({ workspaceId, running: true, needsAttention: false });
  }
  for (let index = 0; index < (tally.needsAttention ?? 0); index += 1) {
    list.push({ workspaceId, running: false, needsAttention: true });
  }
  return list;
}

function settings(overrides: Partial<PresenceSettings> = {}): PresenceSettings {
  return { ...DEFAULT_SETTINGS, applicationId: "1234", ...overrides };
}

function hiding(rootPath: string): PresenceSettings {
  return settings({ projectDetailLevels: [{ rootPath, displayName: rootPath, level: "hidden" }] });
}

test("renders nothing until an application id is configured", () => {
  assert.equal(renderActivity(snapshot(), settings({ applicationId: null }), START, NOW), null);
});

test("renders nothing while switched off", () => {
  assert.equal(renderActivity(snapshot(), settings({ enabled: false }), START, NOW), null);
});

test("names the project and the workspace", () => {
  const activity = renderActivity(snapshot(), settings(), START, NOW);
  assert.equal(activity?.details, "paseo-plugins — main");
});

test("drops a workspace name that only repeats the project", () => {
  const only = snapshot({ workspaces: [workspace({ workspaceName: "paseo-plugins" })] });
  assert.equal(renderActivity(only, settings(), START, NOW)?.details, "paseo-plugins");
});

test("takes the most recently active workspace, whatever order the daemon returned", () => {
  const many = snapshot({
    workspaces: [
      workspace({ projectDisplayName: "older", projectRootPath: "/b", statusEnteredAt: START - 60_000 }),
      workspace({ projectDisplayName: "newest", projectRootPath: "/a", statusEnteredAt: START }),
    ],
  });
  assert.match(renderActivity(many, settings(), START, NOW)?.details ?? "", /^newest/);
});

test("prefers the daemon's activity stamp over the status stamp", () => {
  const many = snapshot({
    workspaces: [
      workspace({ projectDisplayName: "stale", projectRootPath: "/b", statusEnteredAt: START }),
      workspace({ projectDisplayName: "touched", projectRootPath: "/a", statusEnteredAt: START - 60_000, activityAt: START + 1 }),
    ],
  });
  assert.match(renderActivity(many, settings(), START, NOW)?.details ?? "", /^touched/);
});

test("a workspace still running outranks one that merely finished more recently", () => {
  const many = snapshot({
    workspaces: [
      workspace({ projectDisplayName: "just-finished", projectRootPath: "/b", statusEnteredAt: NOW - 1 }),
      workspace({ projectDisplayName: "still-running", projectRootPath: "/a", status: "running", statusEnteredAt: START - 3_600_000 }),
    ],
  });
  assert.match(renderActivity(many, settings(), START, NOW)?.details ?? "", /^still-running/);
});

test("counts only the workspaces of the project it names", () => {
  const many = snapshot({
    workspaces: [
      workspace({ id: "wks_a", projectRootPath: "/a" }),
      workspace({ id: "wks_b", projectRootPath: "/a" }),
      workspace({ id: "wks_c", projectRootPath: "/b" }),
    ],
  });
  assert.equal(renderActivity(many, settings(), START, NOW)?.state, "2 workspaces · idle");
});

test("leaves out an agent working in another project", () => {
  const many = snapshot({
    workspaces: [workspace(), workspace({ id: "wks_other", projectRootPath: "/b" })],
    agents: agents({ running: 3 }, "wks_other"),
  });
  assert.equal(renderActivity(many, settings(), START, NOW)?.state, "1 workspace · idle");
});

test("leaves out an agent it cannot place in any workspace", () => {
  const orphaned = snapshot({ agents: [{ workspaceId: null, running: true, needsAttention: false }] });
  assert.equal(renderActivity(orphaned, settings(), START, NOW)?.state, "1 workspace · idle");
});

test("reports running agents", () => {
  const busy = snapshot({ agents: agents({ running: 2 }) });
  assert.equal(renderActivity(busy, settings(), START, NOW)?.state, "1 workspace · 2 agents running");
});

test("a permission prompt outranks work in flight", () => {
  const blocked = snapshot({
    workspaces: [workspace({ status: "needs_input" })],
    agents: agents({ running: 1 }),
  });
  assert.equal(renderActivity(blocked, settings(), START, NOW)?.state, "1 workspace · 1 waiting for permission");
});

test("work in flight outranks a turn that has merely ended", () => {
  const busy = snapshot({
    workspaces: [workspace({ status: "running" })],
    agents: agents({ running: 1, needsAttention: 1 }),
  });
  assert.equal(renderActivity(busy, settings(), START, NOW)?.state, "1 workspace · 1 agent running");
});

test("reports a finished turn once nothing is still running", () => {
  const finished = snapshot({
    workspaces: [workspace({ status: "attention" })],
    agents: agents({ needsAttention: 2 }),
  });
  assert.equal(renderActivity(finished, settings(), START, NOW)?.state, "1 workspace · 2 waiting for you");
});

test("reports a failed workspace", () => {
  const broken = snapshot({ workspaces: [workspace({ status: "failed" })] });
  assert.equal(renderActivity(broken, settings(), START, NOW)?.state, "1 workspace · 1 failed");
});

test("gives every workspace status its own badge", () => {
  const badges = {
    needs_input: ["needs_input", "Waiting for permission"],
    failed: ["failed", "Failed"],
    running: ["running", "Running"],
    attention: ["attention", "Finished — your turn"],
    done: ["idle", "Idle"],
  } as const;
  for (const [status, [key, text]] of Object.entries(badges)) {
    const only = snapshot({
      workspaces: [workspace({ status: status as WorkspaceActivity["status"] })],
    });
    const activity = renderActivity(only, settings(), START, NOW);
    assert.equal(activity?.smallImageKey, key, status);
    assert.equal(activity?.smallImageText, text, status);
  }
});

test("the badge follows the named workspace, not a tally across hidden projects", () => {
  const many = snapshot({
    workspaces: [
      workspace({ id: "wks_client", projectRootPath: "/work/client", projectDisplayName: "client-work", status: "needs_input" }),
      workspace({ projectRootPath: "/home/dev/paseo-plugins", status: "running" }),
    ],
    agents: agents({ running: 1, needsAttention: 3 }, "wks_client"),
  });
  const activity = renderActivity(many, hiding("/work/client"), START, NOW);
  assert.equal(activity?.details, "paseo-plugins — main");
  assert.equal(activity?.smallImageKey, "running");
});

test("the projects level keeps the project name and drops the rest", () => {
  const quiet = settings({ defaultDetailLevel: "projects" });
  const activity = renderActivity(snapshot(), quiet, START, NOW);
  assert.equal(activity?.details, "paseo-plugins");
  assert.equal(activity?.state, "1 workspace");
});

test("the projects level still badges the workspace it named", () => {
  const only = snapshot({ workspaces: [workspace({ status: "running" })] });
  const quiet = settings({ defaultDetailLevel: "projects" });
  assert.equal(renderActivity(only, quiet, START, NOW)?.smallImageKey, "running");
});

test("a project renders at its own level, not the default", () => {
  const quiet = settings({
    defaultDetailLevel: "projects",
    projectDetailLevels: [
      { rootPath: "/home/dev/paseo-plugins", displayName: "paseo-plugins", level: "detailed" },
    ],
  });
  assert.equal(renderActivity(snapshot(), quiet, START, NOW)?.details, "paseo-plugins — main");
});

test("hiding every project names nothing at all", () => {
  const activity = renderActivity(snapshot(), settings({ defaultDetailLevel: "hidden" }), START, NOW);
  assert.deepEqual(activity, {
    details: ANONYMOUS_DETAILS,
    largeImageKey: "paseo",
    largeImageText: "Paseo",
    startTimestamp: START,
  });
});

test("a hidden project falls through to work that is live", () => {
  const many = snapshot({
    workspaces: [
      workspace({ projectRootPath: "/work/client", projectDisplayName: "client-work" }),
      workspace({ projectRootPath: "/home/dev/paseo-plugins", status: "running" }),
    ],
  });
  assert.equal(renderActivity(many, hiding("/work/client"), START, NOW)?.details, "paseo-plugins — main");
});

test("the project promoted past a hidden one is rendered at its own level", () => {
  const many = snapshot({
    workspaces: [
      workspace({ projectRootPath: "/work/client", projectDisplayName: "client-work" }),
      workspace({ projectRootPath: "/home/dev/paseo-plugins", status: "running" }),
    ],
  });
  const mixed = settings({
    projectDetailLevels: [
      { rootPath: "/work/client", displayName: "client-work", level: "hidden" },
      { rootPath: "/home/dev/paseo-plugins", displayName: "paseo-plugins", level: "projects" },
    ],
  });
  assert.equal(renderActivity(many, mixed, START, NOW)?.details, "paseo-plugins");
});

test("a hidden project does not promote a workspace that is merely the next most recent", () => {
  const many = snapshot({
    workspaces: [
      workspace({ projectRootPath: "/work/client", projectDisplayName: "client-work" }),
      workspace({ projectRootPath: "/home/dev/paseo-plugins", statusEnteredAt: START - 1 }),
    ],
  });
  assert.equal(renderActivity(many, hiding("/work/client"), START, NOW)?.details, ANONYMOUS_DETAILS);
});

test("hiding every open project redacts rather than going dark", () => {
  const hidden = hiding("/home/dev/paseo-plugins");
  assert.equal(renderActivity(snapshot(), hidden, START, NOW)?.details, ANONYMOUS_DETAILS);
});

test("stops naming a workspace nobody has touched in half an hour", () => {
  const stale = snapshot({ workspaces: [workspace({ statusEnteredAt: START - STALE_AFTER_MS })] });
  assert.equal(renderActivity(stale, settings(), START, NOW)?.details, ANONYMOUS_DETAILS);
});

test("keeps naming a workspace that has only just gone quiet", () => {
  const recent = snapshot({ workspaces: [workspace({ statusEnteredAt: NOW - 60_000 })] });
  assert.equal(renderActivity(recent, settings(), START, NOW)?.details, "paseo-plugins — main");
});

test("live work never goes stale, however old its stamp", () => {
  const live = snapshot({
    workspaces: [workspace({ status: "running", statusEnteredAt: START - STALE_AFTER_MS * 4 })],
  });
  assert.equal(renderActivity(live, settings(), START, NOW)?.details, "paseo-plugins — main");
});

test("stays visible with no workspaces open", () => {
  const empty = snapshot({ workspaces: [] });
  assert.equal(renderActivity(empty, settings(), START, NOW)?.details, ANONYMOUS_DETAILS);
});

test("counts elapsed time from the moment the plugin started", () => {
  assert.equal(renderActivity(snapshot(), settings(), START, NOW)?.startTimestamp, START);
});
