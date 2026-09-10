import type {
  AgentActivity,
  PresenceSnapshot,
  Project,
  WorkspaceActivity,
  WorkspaceStatus,
} from "./presence.ts";

const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = [
  "needs_input",
  "failed",
  "running",
  "attention",
  "done",
];

function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function coerceStatus(raw: unknown): WorkspaceStatus {
  return WORKSPACE_STATUSES.includes(raw as WorkspaceStatus) ? (raw as WorkspaceStatus) : "done";
}

/**
 * The daemon's payload types reach us as `any`, the protocol package not being installed
 * alongside the client SDK, so every field is checked here rather than trusted.
 */
export function toWorkspaceActivity(entry: unknown): WorkspaceActivity | null {
  const workspace = entry as Record<string, unknown> | null;
  if (!workspace || typeof workspace.projectRootPath !== "string") return null;
  return {
    id: typeof workspace.id === "string" ? workspace.id : "",
    projectRootPath: workspace.projectRootPath,
    projectDisplayName:
      typeof workspace.projectDisplayName === "string" && workspace.projectDisplayName.length > 0
        ? workspace.projectDisplayName
        : workspace.projectRootPath,
    workspaceName: typeof workspace.name === "string" ? workspace.name : "",
    status: coerceStatus(workspace.status),
    activityAt: parseTimestamp(workspace.activityAt),
    statusEnteredAt: parseTimestamp(workspace.statusEnteredAt),
  };
}

/** Closed and archived sessions are not activity, so they never reach the tally. */
export function toAgentActivities(entries: readonly unknown[]): AgentActivity[] {
  const activities: AgentActivity[] = [];
  for (const entry of entries) {
    const agent = (entry as { agent?: Record<string, unknown> } | null)?.agent;
    if (!agent) continue;
    if (agent.archivedAt) continue;
    if (agent.status === "closed") continue;
    activities.push({
      workspaceId: typeof agent.workspaceId === "string" ? agent.workspaceId : null,
      running: agent.status === "running",
      needsAttention: agent.requiresAttention === true,
    });
  }
  return activities;
}

/** A project with no workspace open is still assignable a detail level, so it is read the same way. */
export function toProjects(entries: readonly unknown[]): Project[] {
  const projects: Project[] = [];
  for (const entry of entries) {
    const project = entry as Record<string, unknown> | null;
    if (!project || typeof project.projectRootPath !== "string") continue;
    projects.push({
      rootPath: project.projectRootPath,
      displayName:
        typeof project.projectDisplayName === "string" && project.projectDisplayName.length > 0
          ? project.projectDisplayName
          : project.projectRootPath,
    });
  }
  return projects;
}

export function toPresenceSnapshot(
  workspaceEntries: readonly unknown[],
  agentEntries: readonly unknown[],
  projectEntries: readonly unknown[],
): PresenceSnapshot {
  const workspaces: WorkspaceActivity[] = [];
  for (const entry of workspaceEntries) {
    const workspace = toWorkspaceActivity(entry);
    if (workspace) workspaces.push(workspace);
  }
  return {
    workspaces,
    agents: toAgentActivities(agentEntries),
    projects: toProjects(projectEntries),
  };
}
