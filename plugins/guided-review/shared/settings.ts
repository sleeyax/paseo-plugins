import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SETTINGS_ID = "settings";

export const DEFAULT_GH_PATH = "gh";
/** Claude with whichever model its provider calls the default, so a new model needs no settings change. */
export const DEFAULT_GUIDE_AGENT = "claude-tty";
/** What the default gives way to on a host where the claude-tty plugin's provider is not available. */
export const FALLBACK_GUIDE_AGENT = "claude";

export const DEFAULT_GLAB_PATH = "glab";

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
    /** The `glab` executable, read the same way as `ghPath`. */
    glabPath: z.string().default(DEFAULT_GLAB_PATH),
    /**
     * The guide agent's provider, alone for its default model (`claude-tty`) or with a model
     * (`codex/gpt-5.5`), as Paseo names them. Checked only when a guide agent is created.
     */
    guideAgent: z.string().default(DEFAULT_GUIDE_AGENT),
    /** The guide agent's effort, one of its model's thinking options; blank for the model's default. */
    guideAgentEffort: z.string().default(""),
    /** The guide agent's mode, one that asks before a tool runs; blank for the provider's read-only mode. */
    guideAgentMode: z.string().default(""),
  }),
});

/** What the setting amounts to once read: blank means the default name. */
export function configuredGhPath(raw: unknown): string {
  return configuredPath(raw, DEFAULT_GH_PATH);
}

export function configuredGlabPath(raw: unknown): string {
  return configuredPath(raw, DEFAULT_GLAB_PATH);
}

function configuredPath(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

/** The guide agent setting once read: blank means the default. */
export function configuredGuideAgent(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_GUIDE_AGENT;
  const trimmed = raw.trim();
  return trimmed === "" ? DEFAULT_GUIDE_AGENT : trimmed;
}
