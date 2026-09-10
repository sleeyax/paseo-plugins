import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const DetailLevelSchema = z.enum(["detailed", "projects", "hidden"]);

const ProjectSchema = z.object({
  rootPath: z.string(),
  displayName: z.string(),
});

export const SettingsSchema = z.object({
  enabled: z.boolean(),
  applicationId: z.string().nullable(),
  defaultDetailLevel: DetailLevelSchema,
  projectDetailLevels: z.array(ProjectSchema.extend({ level: DetailLevelSchema })),
});

const ActivitySchema = z.object({
  details: z.string(),
  state: z.string().optional(),
  largeImageKey: z.string(),
  largeImageText: z.string(),
  smallImageKey: z.string().optional(),
  smallImageText: z.string().optional(),
  startTimestamp: z.number(),
});

const StatusSchema = z.object({
  settings: SettingsSchema,
  discord: z.object({
    status: z.enum(["idle", "connecting", "connected", "unavailable", "rejected"]),
    error: z.string().optional(),
  }),
  daemon: z.object({
    status: z.enum(["connecting", "connected", "failed"]),
    error: z.string().optional(),
  }),
  activity: ActivitySchema.nullable(),
  projects: z.array(ProjectSchema.extend({ level: DetailLevelSchema.nullable() })),
});

export type PresenceStatusPayload = z.output<typeof StatusSchema>;

export const getStatus = defineRpc({
  name: "presence.status",
  input: z.object({}),
  output: StatusSchema,
});

export const setSettings = defineRpc({
  name: "presence.settings.set",
  input: SettingsSchema,
  output: StatusSchema,
});

export const setEnabled = defineRpc({
  name: "presence.enabled.set",
  input: z.object({ enabled: z.boolean() }),
  output: StatusSchema,
});

export const setProjectLevel = defineRpc({
  name: "presence.project.level",
  input: ProjectSchema.extend({ level: DetailLevelSchema.nullable() }),
  output: StatusSchema,
});
