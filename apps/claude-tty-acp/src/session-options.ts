import type { ModelInfo, SessionModeState, SessionModelState } from "@agentclientprotocol/sdk";

// Paseo reads a literal "default" model id as "no model selected" and then refuses to list a draft agent's commands.
export const INHERIT_MODEL_ID = "inherit";

export const MODELS: ModelInfo[] = [
  { modelId: INHERIT_MODEL_ID, name: "Default", description: "Use Claude Code's configured default model" },
  { modelId: "opus", name: "Opus (latest)", description: "Claude Code's rolling Opus alias" },
  { modelId: "fable", name: "Fable (latest)", description: "Claude Code's rolling Fable alias" },
  { modelId: "sonnet", name: "Sonnet (latest)", description: "Claude Code's rolling Sonnet alias" },
  { modelId: "haiku", name: "Haiku (latest)", description: "Claude Code's rolling Haiku alias" },
  { modelId: "claude-opus-5", name: "Opus 5", description: "Latest release" },
  { modelId: "claude-fable-5", name: "Fable 5", description: "Most powerful model" },
  { modelId: "claude-opus-4-8[1m]", name: "Opus 4.8 1M", description: "Opus 4.8 with 1M context window" },
  { modelId: "claude-opus-4-8", name: "Opus 4.8", description: "Previous release" },
  { modelId: "claude-sonnet-5", name: "Sonnet 5", description: "Best for everyday tasks" },
  { modelId: "claude-sonnet-5[1m]", name: "Sonnet 5 1M", description: "Sonnet 5 with 1M context window" },
  { modelId: "claude-opus-4-7[1m]", name: "Opus 4.7 1M", description: "Opus 4.7 with 1M context window" },
  { modelId: "claude-opus-4-7", name: "Opus 4.7", description: "Previous release" },
  { modelId: "claude-opus-4-6[1m]", name: "Opus 4.6 1M", description: "Opus 4.6 with 1M context window" },
  { modelId: "claude-opus-4-6", name: "Opus 4.6", description: "Most capable for complex work" },
  { modelId: "claude-sonnet-4-6[1m]", name: "Sonnet 4.6 1M", description: "Sonnet 4.6 with 1M context window" },
  { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6", description: "Best for everyday tasks" },
  { modelId: "claude-haiku-4-5", name: "Haiku 4.5", description: "Fastest for quick answers" },
];

export const MODEL_IDS = MODELS.map((model) => model.modelId);
export const MODE_IDS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;

export type ModeId = (typeof MODE_IDS)[number];

export function modelState(currentModelId: string): SessionModelState {
  return {
    currentModelId,
    availableModels: MODELS,
  };
}

export function modeState(currentModeId: string): SessionModeState {
  return {
    currentModeId,
    availableModes: [
      { id: "default", name: "Default", description: "Ask before edits and commands according to Claude settings" },
      { id: "acceptEdits", name: "Accept Edits", description: "Automatically accept file edits" },
      { id: "plan", name: "Plan", description: "Explore and plan without making changes" },
      { id: "auto", name: "Auto", description: "Let Claude Code handle permissions automatically" },
      { id: "bypassPermissions", name: "Bypass Permissions", description: "Never ask - for unattended agents" },
    ],
  };
}

export function migrateModelId(value: string): string {
  return value === "default" ? INHERIT_MODEL_ID : value;
}

export function assertModelId(value: string): void {
  if (!MODEL_IDS.includes(value)) throw new Error(`Unsupported Claude model ${value}`);
}

export function assertModeId(value: string): asserts value is ModeId {
  if (!(MODE_IDS as readonly string[]).includes(value)) throw new Error(`Unsupported Claude mode ${value}`);
}
