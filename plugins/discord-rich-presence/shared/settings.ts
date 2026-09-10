import {
  DEFAULT_SETTINGS,
  DETAIL_LEVELS,
  type DetailLevel,
  type KnownProject,
  type PresenceSettings,
  type PresenceSnapshot,
  type Project,
  type ProjectDetailLevel,
} from "./presence.ts";

export type StoredState = {
  version: 1;
  settings: PresenceSettings;
};

function asDetailLevel(raw: unknown): DetailLevel | null {
  return DETAIL_LEVELS.includes(raw as DetailLevel) ? (raw as DetailLevel) : null;
}

/** Discord application ids are snowflakes, and a pasted one arrives with whatever whitespace came along. */
export function coerceApplicationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null;
}

/**
 * An entry whose level is unreadable is dropped rather than filled in with the default: a project
 * set to the same level as the default still has to stop following it when the default changes.
 */
function coerceProjectDetailLevels(raw: unknown): ProjectDetailLevel[] {
  if (!Array.isArray(raw)) return [];
  const projects: ProjectDetailLevel[] = [];
  for (const entry of raw) {
    const project = entry as Partial<ProjectDetailLevel> | null;
    if (!project || typeof project.rootPath !== "string" || project.rootPath.length === 0) continue;
    const level = asDetailLevel(project.level);
    if (level === null) continue;
    if (projects.some((existing) => existing.rootPath === project.rootPath)) continue;
    projects.push({
      rootPath: project.rootPath,
      displayName: typeof project.displayName === "string" ? project.displayName : project.rootPath,
      level,
    });
  }
  return projects;
}

export function coerceSettings(raw: unknown): PresenceSettings {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const settings = (
    typeof record.settings === "object" && record.settings !== null ? record.settings : record
  ) as Record<string, unknown>;
  return {
    enabled: typeof settings.enabled === "boolean" ? settings.enabled : DEFAULT_SETTINGS.enabled,
    applicationId:
      "applicationId" in settings ? coerceApplicationId(settings.applicationId) : DEFAULT_SETTINGS.applicationId,
    defaultDetailLevel:
      asDetailLevel(settings.defaultDetailLevel) ?? DEFAULT_SETTINGS.defaultDetailLevel,
    projectDetailLevels: coerceProjectDetailLevels(settings.projectDetailLevels),
  };
}

/** A null level drops the entry, so the project goes back to following the default. */
export function withProjectDetailLevel(
  settings: PresenceSettings,
  project: Project,
  level: DetailLevel | null,
): PresenceSettings {
  const without = settings.projectDetailLevels.filter(
    (entry) => entry.rootPath !== project.rootPath,
  );
  return {
    ...settings,
    projectDetailLevels: level === null ? without : [...without, { ...project, level }],
  };
}

/**
 * Every project the daemon has registered, so a level can be set on one that is not running.
 * The saved settings only contribute a name for a project the daemon has since forgotten, which
 * is what keeps a level assigned to it undoable.
 */
export function knownProjects(
  settings: PresenceSettings,
  snapshot: PresenceSnapshot,
): KnownProject[] {
  const names = new Map<string, string>();
  for (const project of settings.projectDetailLevels) names.set(project.rootPath, project.displayName);
  for (const workspace of snapshot.workspaces) {
    names.set(workspace.projectRootPath, workspace.projectDisplayName);
  }
  for (const project of snapshot.projects) names.set(project.rootPath, project.displayName);

  const levels = new Map(
    settings.projectDetailLevels.map((project) => [project.rootPath, project.level] as const),
  );
  return [...names]
    .map(([rootPath, displayName]) => ({
      rootPath,
      displayName,
      level: levels.get(rootPath) ?? null,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}
