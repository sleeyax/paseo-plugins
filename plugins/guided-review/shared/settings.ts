import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SETTINGS_ID = "settings";

export const DEFAULT_GH_PATH = "gh";

/**
 * Host settings, owned by the host's store. Every field has a default, so `schema.parse({})` is the
 * defaults document and a field added later reads as its default from a document saved before it.
 */
export const settingsDocument = defineSettings({
  id: SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: z.object({
    /**
     * The `gh` executable, a bare name looked up on the daemon's `PATH` or an absolute path. Not
     * validated beyond being a string: whether it runs is a question about the host, and a failing
     * call says so in a sentence naming this setting.
     */
    ghPath: z.string().default(DEFAULT_GH_PATH),
  }),
});

/** What the setting amounts to once read: blank means the default name. */
export function configuredGhPath(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_GH_PATH;
  const trimmed = raw.trim();
  return trimmed === "" ? DEFAULT_GH_PATH : trimmed;
}
