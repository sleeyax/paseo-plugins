import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsDocument = defineSettings({
  id: "task-runner",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Workspaces whose user chose to run the repo's own nx to list inferred targets. */
    inferredTargetWorkspaces: z.array(z.string()).default([]),
  }),
});
