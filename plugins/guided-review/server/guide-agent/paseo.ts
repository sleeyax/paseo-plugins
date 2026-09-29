import type { PaseoAgent, PaseoAgentHandle, PaseoAgentPermissionResponse, PaseoApi } from "@getpaseo/client";
import { DEFAULT_GUIDE_AGENT, FALLBACK_GUIDE_AGENT } from "../../shared/settings.ts";
import { GUIDE_AGENT_LABEL, GuideAgentError, type GuideAgentPort } from "./port.ts";

export type PermissionRequest = PaseoAgent["pendingPermissions"][number];

export type PaseoGuideAgentsOptions = {
  /** The daemon connection, which only arrives with the first RPC or hook and is the same one after it. */
  paseo: () => PaseoApi;
  /** The configured agent, a provider (`claude`) or a provider and model (`codex/gpt-5.5`), read at every creation. */
  agent: () => Promise<string>;
  /** How long a turn may run before its reply is given up on. */
  timeoutMs?: number;
};

export type PaseoGuideAgents = GuideAgentPort & {
  /**
   * For the `agent.permission_requested` hook: denies a guide agent's request to change anything, and
   * leaves every other agent's requests alone. Guide agents are told apart by their label, which
   * survives a plugin restart where an in-memory list would not.
   */
  onPermissionRequested(agentId: string, request: PermissionRequest): Promise<void>;
};

/** A large PR can take the agent a while to read; past this the run is presumed stuck. */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
/** Each round answers every request pending at once, so this many means the agent is looping on them. */
const MAX_PERMISSION_ROUNDS = 50;
/** Paseo caps an explicit agent title at 200 characters. */
const MAX_TITLE = 200;

const READ_ONLY_DENIAL =
  "This guide agent is read-only: do not change files, run commands or leave plan mode. Give your answer as a normal message.";
const UNATTENDED_DENIAL =
  "Nobody is watching this run to answer requests. Carry on without it, and give your answer as a normal message.";

/**
 * The mode a provider calls read-only. Claude's plan mode and Codex's read-only preset are the known
 * ones; Codex accepts `read-only` without advertising it. A provider with neither runs in its default
 * mode, where the permission hook is what keeps it from writing.
 */
export function readOnlyMode(provider: string, modes: readonly { id: string }[]): string | undefined {
  for (const preferred of ["plan", "read-only"]) {
    if (modes.some((mode) => mode.id === preferred)) return preferred;
  }
  return provider === "codex" ? "read-only" : undefined;
}

/**
 * How the plugin answers a guide agent's permission request. Anything that would change the checkout
 * or leave the read-only mode is denied. Unattended, while the plugin is waiting for a reply nobody
 * is watching, reads and searches are allowed and the rest denied, so the run never stalls; attended,
 * those are left to the reviewer in the agent's chat.
 */
export function answerPermission(request: PermissionRequest, unattended: boolean): PaseoAgentPermissionResponse | null {
  if (changesSomething(request)) return { behavior: "deny", message: READ_ONLY_DENIAL };
  if (!unattended) return null;
  const type = request.detail?.type;
  if (request.kind === "tool" && (type === "read" || type === "search")) return { behavior: "allow" };
  return { behavior: "deny", message: UNATTENDED_DENIAL };
}

function changesSomething(request: PermissionRequest): boolean {
  if (request.kind === "plan" || request.kind === "mode") return true;
  if (request.kind !== "tool") return false;
  switch (request.detail?.type) {
    case "edit":
    case "write":
    case "shell":
      return true;
    case "read":
    case "search":
    case "fetch":
      return false;
    default:
      // A tool the provider did not describe is judged by its name.
      return /edit|write|patch|bash|shell|exec|command|notebook|delete|move|rename/i.test(request.name);
  }
}

/** Splits the setting into provider and model; a bare provider means its default model. */
export function parseAgentSetting(setting: string): { provider: string; model: string | null } {
  const trimmed = setting.trim();
  const separator = trimmed.indexOf("/");
  if (separator < 0) return { provider: trimmed, model: null };
  const model = trimmed.slice(separator + 1).trim();
  return { provider: trimmed.slice(0, separator).trim(), model: model === "" ? null : model };
}

export function createPaseoGuideAgents(options: PaseoGuideAgentsOptions): PaseoGuideAgents {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

  const agent = (agentId: string) => options.paseo().agents.ref(agentId);

  const respond = async (handle: PaseoAgentHandle, requestId: string, response: PaseoAgentPermissionResponse) => {
    try {
      await handle.respondToPermission({ requestId, response });
    } catch {
      // Already answered, by the hook, the reviewer, or the other of the two paths that answer here.
    }
  };

  const lastAssistantMessage = async (handle: PaseoAgentHandle): Promise<string | null> => {
    const page = await handle.timeline.refetch({ direction: "tail", limit: 50 });
    for (const entry of [...page.entries].reverse()) {
      if (entry.item.type === "assistant_message") return entry.item.text;
    }
    return null;
  };

  const settle = async (handle: PaseoAgentHandle): Promise<string> => {
    for (let round = 0; round <= MAX_PERMISSION_ROUNDS; round++) {
      const result = await handle.waitForFinish(timeoutMs);
      switch (result.status) {
        case "idle": {
          const text = result.lastMessage ?? (await lastAssistantMessage(handle));
          if (text === null || text.trim() === "") throw new GuideAgentError("The guide agent finished without an answer.");
          return text;
        }
        case "error":
          throw new GuideAgentError(result.error ? `The guide agent failed: ${result.error}` : "The guide agent failed.");
        case "timeout":
          throw new GuideAgentError(`The guide agent did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`);
        case "permission": {
          // Events are best-effort, so the hook may not have answered; whatever is pending is answered here.
          const pending = result.final?.pendingPermissions ?? (await handle.refresh())?.agent.pendingPermissions ?? [];
          for (const request of pending) await respond(handle, request.id, answerPermission(request, true)!);
          continue;
        }
      }
    }
    throw new GuideAgentError("The guide agent kept asking for permissions instead of answering.");
  };

  const status = async (agentId: string) => {
    const current = await agent(agentId).refresh();
    if (current === null || current.agent.archivedAt || current.agent.status === "closed") return "gone" as const;
    return current.agent.status === "idle" ? ("idle" as const) : ("busy" as const);
  };

  const requireIdle = async (agentId: string) => {
    const now = await status(agentId);
    if (now === "gone") throw new GuideAgentError("The guide agent is gone; it was archived or closed.");
    if (now === "busy") throw new GuideAgentError("The guide agent is still busy. Wait for it to finish, then try again.");
  };

  return {
    async create({ workspace, title, labels, prompt, outputSchema }) {
      const paseo = options.paseo();
      const { provider, model } = parseAgentSetting(await availableAgent(paseo, await options.agent()));
      if (provider === "") throw new GuideAgentError("No guide agent provider is configured.");
      const resolvedModel = model ?? (await defaultModel(paseo, provider, workspace.directory));
      const modes = await paseo.providers.listModes(provider, { cwd: workspace.directory }).catch(() => null);
      const modeId = readOnlyMode(provider, modes?.modes ?? []);

      try {
        const handle = await paseo.workspaces.ref(workspace.id).agents.create({
          config: { provider: `${provider}/${resolvedModel}`, ...(modeId === undefined ? {} : { modeId }) },
          title: title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1)}…`,
          labels,
          prompt,
          ...(outputSchema === undefined ? {} : { outputSchema }),
        });
        return { id: handle.id };
      } catch (error) {
        throw new GuideAgentError(`Could not create the guide agent with ${provider}/${resolvedModel}: ${messageOf(error)}`);
      }
    },

    reply: (agentId) => settle(agent(agentId)),

    async run(agentId, text) {
      await requireIdle(agentId);
      const handle = agent(agentId);
      await handle.send(text);
      return settle(handle);
    },

    async send(agentId, text) {
      await requireIdle(agentId);
      await agent(agentId).send(text);
    },

    status,

    async archive(agentId) {
      try {
        await agent(agentId).archive();
      } catch {
        // Archived already, with its workspace, or never created.
      }
    },

    async onPermissionRequested(agentId, request) {
      const response = answerPermission(request, false);
      if (response === null) return;
      const handle = agent(agentId);
      const current = await handle.refresh().catch(() => null);
      if (current?.agent.labels[GUIDE_AGENT_LABEL] === undefined) return;
      await respond(handle, request.id, response);
    },
  };
}

/**
 * The setting, unless it is the default and the claude-tty plugin that provides it is not available here.
 * A listing that fails leaves the setting as it is, so the creation says what went wrong with it.
 */
async function availableAgent(paseo: PaseoApi, setting: string): Promise<string> {
  if (setting.trim() !== DEFAULT_GUIDE_AGENT) return setting;
  const listed = await paseo.providers.listAvailable().catch(() => null);
  if (listed === null) return setting;
  return listed.providers.some((entry) => entry.provider === DEFAULT_GUIDE_AGENT && entry.available) ? setting : FALLBACK_GUIDE_AGENT;
}

async function defaultModel(paseo: PaseoApi, provider: string, cwd: string): Promise<string> {
  const listed = await paseo.providers.listModels(provider, { cwd }).catch((error: unknown) => ({ models: [], error: messageOf(error) }));
  const models = (listed.models ?? []).filter((model) => model.isSelectable !== false);
  const chosen = models.find((model) => model.isDefault) ?? models[0];
  if (chosen === undefined) {
    const reason = listed.error ? `: ${listed.error}` : "";
    throw new GuideAgentError(`The ${provider} provider offers no model for the guide agent${reason}. Check the guide agent setting.`);
  }
  return chosen.id;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
