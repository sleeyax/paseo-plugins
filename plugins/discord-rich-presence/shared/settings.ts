import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  type DetailLevel,
  type KnownProject,
  type PresenceSettings,
  type PresenceSnapshot,
  type Project,
  type ProjectDetailLevels,
} from "./presence.ts";

/** Discord application ids are snowflakes. */
const APPLICATION_ID = /^\d{17,20}$/;

const DetailLevelSchema = z.enum(["detailed", "projects", "hidden"]);

/**
 * The host owns the store: it validates, writes atomically and tells every client and the server
 * when it changes. Every field has a default, so a host that never saved reads as `DEFAULT_SETTINGS`.
 */
export const settingsDocument = defineSettings({
  id: "settings",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(DEFAULT_SETTINGS.enabled),
    applicationId: z.string().regex(APPLICATION_ID).nullable().default(DEFAULT_SETTINGS.applicationId),
    defaultDetailLevel: DetailLevelSchema.default(DEFAULT_SETTINGS.defaultDetailLevel),
    projectDetailLevels: z
      .record(z.string().min(1), z.object({ displayName: z.string(), level: DetailLevelSchema }))
      .default(DEFAULT_SETTINGS.projectDetailLevels),
  }) satisfies z.ZodType<PresenceSettings>,
});

/** A pasted id arrives with whatever whitespace came along. */
export function coerceApplicationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return APPLICATION_ID.test(trimmed) ? trimmed : null;
}

/** A null level drops the entry, so the project goes back to following the default. */
export function withProjectDetailLevel(
  settings: PresenceSettings,
  project: Project,
  level: DetailLevel | null,
): PresenceSettings {
  const { [project.rootPath]: _previous, ...others } = settings.projectDetailLevels;
  return {
    ...settings,
    projectDetailLevels:
      level === null ? others : { ...others, [project.rootPath]: { displayName: project.displayName, level } },
  };
}

/**
 * Every project the daemon has registered, so a level can be set on one that is not running.
 * The saved settings only contribute a name for a project the daemon has since forgotten, which
 * is what keeps a level assigned to it undoable.
 */
export function knownProjects(
  levels: ProjectDetailLevels,
  snapshot: PresenceSnapshot,
): KnownProject[] {
  const saved = Object.entries(levels);
  const names = new Map<string, string>();
  for (const [rootPath, project] of saved) names.set(rootPath, project.displayName);
  for (const workspace of snapshot.workspaces) {
    names.set(workspace.projectRootPath, workspace.projectDisplayName);
  }
  for (const project of snapshot.projects) names.set(project.rootPath, project.displayName);

  const savedLevels = new Map(saved.map(([rootPath, project]) => [rootPath, project.level] as const));
  return [...names]
    .map(([rootPath, displayName]) => ({
      rootPath,
      displayName,
      level: savedLevels.get(rootPath) ?? null,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}
