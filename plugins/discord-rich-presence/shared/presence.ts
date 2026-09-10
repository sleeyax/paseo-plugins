export type DetailLevel = "detailed" | "projects" | "hidden";

export type WorkspaceStatus = "needs_input" | "failed" | "running" | "attention" | "done";

export type WorkspaceActivity = {
  id: string;
  projectRootPath: string;
  projectDisplayName: string;
  workspaceName: string;
  status: WorkspaceStatus;
  /** Epoch ms of the daemon's own activity stamp, which older daemons never fill in. */
  activityAt: number | null;
  statusEnteredAt: number | null;
};

export type AgentTally = {
  running: number;
  needsAttention: number;
};

/** An agent still doing something, carrying the workspace that places it in a project. */
export type AgentActivity = {
  workspaceId: string | null;
  running: boolean;
  needsAttention: boolean;
};

export type Project = {
  rootPath: string;
  displayName: string;
};

/** A project told to ignore the default and use this level instead. */
export type ProjectDetailLevel = Project & {
  level: DetailLevel;
};

/** A project the settings surface can assign a level to. */
export type KnownProject = Project & {
  /** null when the project follows the default level. */
  level: DetailLevel | null;
};

export type PresenceSettings = {
  enabled: boolean;
  applicationId: string | null;
  defaultDetailLevel: DetailLevel;
  projectDetailLevels: ProjectDetailLevel[];
};

export type PresenceSnapshot = {
  workspaces: WorkspaceActivity[];
  agents: AgentActivity[];
  /** Every project the daemon has registered. The presence itself is computed from activity, so this only feeds the settings listing. */
  projects: Project[];
};

/**
 * An agent whose workspace is not among the ones counted is left out rather than assumed: the
 * presence speaks for one project, and an agent it cannot place might belong to a hidden one.
 */
export function tallyAgents(
  agents: readonly AgentActivity[],
  workspaceIds: ReadonlySet<string>,
): AgentTally {
  let running = 0;
  let needsAttention = 0;
  for (const agent of agents) {
    if (agent.workspaceId === null || !workspaceIds.has(agent.workspaceId)) continue;
    if (agent.running) running += 1;
    if (agent.needsAttention) needsAttention += 1;
  }
  return { running, needsAttention };
}

export type PresenceActivity = {
  details: string;
  state?: string;
  largeImageKey: string;
  largeImageText: string;
  smallImageKey?: string;
  smallImageText?: string;
  startTimestamp: number;
};

export const LARGE_IMAGE_KEY = "paseo";
export const LARGE_IMAGE_TEXT = "Paseo";
export const ANONYMOUS_DETAILS = "Using Paseo";

export const DETAIL_LEVELS: readonly DetailLevel[] = ["detailed", "projects", "hidden"];

export const DETAIL_LEVEL_LABELS: Record<DetailLevel, string> = {
  detailed: "Detailed",
  projects: "Projects only",
  hidden: "Hidden",
};

/** The application the plugin ships against, so an install shows a presence without a trip to the developer portal. */
export const MANAGED_APPLICATION_ID = "1542167510986653787";

export const DEFAULT_SETTINGS: PresenceSettings = {
  enabled: true,
  applicationId: MANAGED_APPLICATION_ID,
  defaultDetailLevel: "detailed",
  projectDetailLevels: [],
};

/** The level set on a project, or null when it follows the default. */
export function levelSetOn(settings: PresenceSettings, projectRootPath: string): DetailLevel | null {
  return (
    settings.projectDetailLevels.find((project) => project.rootPath === projectRootPath)?.level ??
    null
  );
}

export function detailLevelFor(settings: PresenceSettings, projectRootPath: string): DetailLevel {
  return levelSetOn(settings, projectRootPath) ?? settings.defaultDetailLevel;
}

function isLive(status: WorkspaceStatus): boolean {
  return status !== "done";
}

/** A workspace that has not finished is active now, whatever its last stamp says. */
function activeAt(workspace: WorkspaceActivity, now: number): number {
  if (isLive(workspace.status)) return now;
  return Math.max(workspace.activityAt ?? 0, workspace.statusEnteredAt ?? 0);
}

export function rankWorkspaces(
  workspaces: readonly WorkspaceActivity[],
  now: number,
): WorkspaceActivity[] {
  return [...workspaces].sort((left, right) => activeAt(right, now) - activeAt(left, now));
}

/** Past this, the last workspace is what you were doing rather than what you are doing. */
export const STALE_AFTER_MS = 30 * 60_000;

/** The workspace the presence speaks for, carrying the level its project asked to be shown at. */
type ActiveWorkspace = {
  workspace: WorkspaceActivity;
  level: DetailLevel;
};

/**
 * The workspace the presence speaks for, or null when it should fall back to the anonymous
 * rendering. A hidden workspace is only ever replaced by live work: promoting whatever merely ranks
 * behind it puts a project you are not in front of on your profile, which is what hiding was for.
 */
function pickActive(
  workspaces: readonly WorkspaceActivity[],
  settings: PresenceSettings,
  now: number,
): ActiveWorkspace | null {
  const ranked = rankWorkspaces(workspaces, now);
  const first = ranked[0];
  if (!first) return null;
  const level = detailLevelFor(settings, first.projectRootPath);
  if (level !== "hidden") {
    return activeAt(first, now) >= now - STALE_AFTER_MS ? { workspace: first, level } : null;
  }
  for (const workspace of ranked) {
    if (!isLive(workspace.status)) continue;
    const fallback = detailLevelFor(settings, workspace.projectRootPath);
    if (fallback !== "hidden") return { workspace, level: fallback };
  }
  return null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function countStatus(workspaces: readonly WorkspaceActivity[], status: WorkspaceStatus): number {
  return workspaces.filter((workspace) => workspace.status === status).length;
}

/**
 * Paseo's own order of demand: a permission prompt outranks a failure, which outranks work still in
 * flight, which outranks a turn that has merely ended.
 */
function activityClause(workspaces: readonly WorkspaceActivity[], agents: AgentTally): string {
  const blocked = countStatus(workspaces, "needs_input");
  if (blocked > 0) return `${blocked} waiting for permission`;
  const failed = countStatus(workspaces, "failed");
  if (failed > 0) return `${failed} failed`;
  if (agents.running > 0) return `${plural(agents.running, "agent")} running`;
  if (agents.needsAttention > 0) return `${agents.needsAttention} waiting for you`;
  return "idle";
}

/**
 * The badge speaks for the workspace on the first line and nothing else, which is why it survives
 * the projects level while the activity clause does not.
 */
const BADGES: Record<WorkspaceStatus, { key: string; text: string }> = {
  needs_input: { key: "needs_input", text: "Waiting for permission" },
  failed: { key: "failed", text: "Failed" },
  running: { key: "running", text: "Running" },
  attention: { key: "attention", text: "Finished — your turn" },
  done: { key: "idle", text: "Idle" },
};

/** The colours `scripts/render-assets.sh` fills the small images with, so the preview shows the badge Discord does. */
export const BADGE_COLORS: Record<string, string> = {
  needs_input: "#db932e",
  failed: "#f7796d",
  running: "#5caaf6",
  attention: "#35c264",
  idle: "#6b7280",
};

function idsOf(workspaces: readonly WorkspaceActivity[]): Set<string> {
  return new Set(workspaces.map((workspace) => workspace.id).filter((id) => id.length > 0));
}

function describeWorkspace(active: WorkspaceActivity): string {
  const { projectDisplayName, workspaceName } = active;
  if (!workspaceName || workspaceName === projectDisplayName) return projectDisplayName;
  return `${projectDisplayName} — ${workspaceName}`;
}

function anonymousActivity(startTimestamp: number): PresenceActivity {
  return {
    details: ANONYMOUS_DETAILS,
    largeImageKey: LARGE_IMAGE_KEY,
    largeImageText: LARGE_IMAGE_TEXT,
    startTimestamp,
  };
}

/**
 * Returns what Discord should show, or null when the plugin has nothing to say and the socket
 * should be closed rather than left holding a stale activity.
 */
export function renderActivity(
  snapshot: PresenceSnapshot,
  settings: PresenceSettings,
  startTimestamp: number,
  now: number,
): PresenceActivity | null {
  if (!settings.enabled || !settings.applicationId) return null;

  const active = pickActive(snapshot.workspaces, settings, now);
  if (!active) return anonymousActivity(startTimestamp);

  const { workspace, level } = active;
  const badge = BADGES[workspace.status];
  const siblings = snapshot.workspaces.filter(
    (entry) => entry.projectRootPath === workspace.projectRootPath,
  );
  const count = plural(siblings.length, "workspace");
  return {
    details: level === "projects" ? workspace.projectDisplayName : describeWorkspace(workspace),
    state:
      level === "projects"
        ? count
        : `${count} · ${activityClause(siblings, tallyAgents(snapshot.agents, idsOf(siblings)))}`,
    largeImageKey: LARGE_IMAGE_KEY,
    largeImageText: LARGE_IMAGE_TEXT,
    smallImageKey: badge.key,
    smallImageText: badge.text,
    startTimestamp,
  };
}
