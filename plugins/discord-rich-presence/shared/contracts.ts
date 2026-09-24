import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const DetailLevelSchema = z.enum(["detailed", "projects", "hidden"]);

const ProjectSchema = z.object({
  rootPath: z.string(),
  displayName: z.string(),
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
