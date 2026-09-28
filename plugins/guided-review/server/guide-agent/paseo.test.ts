import type { PaseoAgentPermissionResponse, PaseoApi } from "@getpaseo/client";
import assert from "node:assert/strict";
import test from "node:test";
import { answerPermission, createPaseoGuideAgents, parseAgentSetting, readOnlyMode, type PermissionRequest } from "./paseo.ts";
import { GUIDE_AGENT_LABEL, GuideAgentError } from "./port.ts";

type Wait = { status: "idle" | "error" | "permission" | "timeout"; lastMessage?: string | null; error?: string | null; pending?: PermissionRequest[] };

/**
 * The slice of the SDK the adapter uses, answering from what the test put in it and recording what
 * the adapter did. One agent, whose turns end the way `waits` says, in order.
 */
function stubPaseo() {
  const state = {
    models: [
      { provider: "claude", id: "claude-sonnet-5", label: "Sonnet 5" },
      { provider: "claude", id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true },
    ] as { provider: string; id: string; label: string; isDefault?: boolean }[],
    modes: [{ id: "default", label: "Default" }, { id: "plan", label: "Plan" }],
    created: [] as Record<string, unknown>[],
    waits: [] as Wait[],
    responses: [] as { requestId: string; response: PaseoAgentPermissionResponse }[],
    sent: [] as string[],
    agentStatus: "idle",
    labels: { [GUIDE_AGENT_LABEL]: "github/github.com/acme/uploader/7" } as Record<string, string>,
  };
  const handle = {
    id: "agent-1",
    async waitForFinish() {
      const next = state.waits.shift() ?? { status: "timeout" };
      return {
        status: next.status,
        lastMessage: next.lastMessage ?? null,
        error: next.error ?? null,
        final: next.pending ? { pendingPermissions: next.pending } : null,
      };
    },
    async respondToPermission(options: { requestId: string; response: PaseoAgentPermissionResponse }) {
      state.responses.push(options);
    },
    async refresh() {
      return { agent: { status: state.agentStatus, labels: state.labels, archivedAt: null, pendingPermissions: [] }, project: null };
    },
    async send(text: string) {
      state.sent.push(text);
    },
    timeline: { async refetch() { return { entries: [{ item: { type: "assistant_message", text: "From the timeline" } }] }; } },
  };
  const paseo = {
    providers: {
      async listModels() {
        return { models: state.models };
      },
      async listModes() {
        return { modes: state.modes };
      },
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        agents: {
          async create(options: Record<string, unknown>) {
            state.created.push({ workspaceId, ...options });
            return handle;
          },
        },
      }),
    },
    agents: { ref: () => handle },
  } as unknown as PaseoApi;
  return { paseo, state };
}

function request(overrides: Partial<PermissionRequest>): PermissionRequest {
  return { id: "perm-1", provider: "claude", name: "Tool", kind: "tool", ...overrides } as PermissionRequest;
}

const WORKSPACE = { id: "wks_1", directory: "/r/uploader-pr-7" };

test("the guide agent is created in the workspace, in plan mode, with the provider's default model when none is set", async () => {
  const { paseo, state } = stubPaseo();
  const agents = createPaseoGuideAgents({ paseo: () => paseo, agent: async () => "claude" });

  assert.deepEqual(await agents.create({ workspace: WORKSPACE, title: "Guide: Retry uploads", labels: { a: "b" }, prompt: "Explain.", outputSchema: { type: "object" } }), {
    id: "agent-1",
  });
  assert.deepEqual(state.created, [
    {
      workspaceId: "wks_1",
      config: { provider: "claude/claude-opus-5-5", modeId: "plan" },
      title: "Guide: Retry uploads",
      labels: { a: "b" },
      prompt: "Explain.",
      outputSchema: { type: "object" },
    },
  ]);
});

test("a configured model is used as it is, and a provider that offers no read-only mode runs in its default", async () => {
  const { paseo, state } = stubPaseo();
  state.modes = [{ id: "default", label: "Default" }];
  const agents = createPaseoGuideAgents({ paseo: () => paseo, agent: async () => "opencode/big-model" });

  await agents.create({ workspace: WORKSPACE, title: "Guide", labels: {}, prompt: "Explain." });

  assert.deepEqual(state.created[0]!.config, { provider: "opencode/big-model" });
});

test("a provider with no model to offer fails the creation in a sentence naming the setting", async () => {
  const { paseo, state } = stubPaseo();
  state.models = [];
  const agents = createPaseoGuideAgents({ paseo: () => paseo, agent: async () => "claude" });

  await assert.rejects(agents.create({ workspace: WORKSPACE, title: "Guide", labels: {}, prompt: "Explain." }), {
    name: "GuideAgentError",
    message: "The claude provider offers no model for the guide agent. Check the guide agent setting.",
  });
});

test("the read-only mode is plan, then read-only, and read-only for Codex even unadvertised", () => {
  assert.equal(readOnlyMode("claude", [{ id: "default" }, { id: "plan" }]), "plan");
  assert.equal(readOnlyMode("other", [{ id: "read-only" }]), "read-only");
  assert.equal(readOnlyMode("codex", [{ id: "auto" }, { id: "full-access" }]), "read-only");
  assert.equal(readOnlyMode("other", [{ id: "default" }]), undefined);
  assert.deepEqual(parseAgentSetting(" codex/gpt-5.5 "), { provider: "codex", model: "gpt-5.5" });
  assert.deepEqual(parseAgentSetting("claude/"), { provider: "claude", model: null });
});

test("writes, edits, commands and leaving plan mode are always denied; the rest only while nobody is watching", () => {
  const denied = { behavior: "deny", message: "This guide agent is read-only: do not change files, run commands or leave plan mode. Give your answer as a normal message." };
  assert.deepEqual(answerPermission(request({ detail: { type: "edit", filePath: "a.ts" } }), false), denied);
  assert.deepEqual(answerPermission(request({ detail: { type: "write", filePath: "a.ts" } }), false), denied);
  assert.deepEqual(answerPermission(request({ detail: { type: "shell", command: "rm -rf ." } }), false), denied);
  assert.deepEqual(answerPermission(request({ name: "ApplyPatch" }), false), denied);
  assert.deepEqual(answerPermission(request({ kind: "plan", name: "ExitPlanMode" }), false), denied);
  assert.deepEqual(answerPermission(request({ kind: "mode" }), true), denied);

  assert.equal(answerPermission(request({ detail: { type: "read", filePath: "a.ts" } }), false), null);
  assert.equal(answerPermission(request({ kind: "question" }), false), null);
  assert.deepEqual(answerPermission(request({ detail: { type: "read", filePath: "a.ts" } }), true), { behavior: "allow" });
  assert.deepEqual(answerPermission(request({ detail: { type: "search", query: "retry" } }), true), { behavior: "allow" });
  assert.equal(answerPermission(request({ kind: "question" }), true)?.behavior, "deny");
});

test("a reply waits through permission requests, answering them, and returns the final message", async () => {
  const { paseo, state } = stubPaseo();
  state.waits = [
    { status: "permission", pending: [request({ id: "exit", kind: "plan", name: "ExitPlanMode" }), request({ id: "read", detail: { type: "read", filePath: "a.ts" } })] },
    { status: "idle", lastMessage: '{"ok":true}' },
  ];
  const agents = createPaseoGuideAgents({ paseo: () => paseo, agent: async () => "claude" });

  assert.equal(await agents.reply("agent-1"), '{"ok":true}');
  assert.deepEqual(
    state.responses.map(({ requestId, response }) => [requestId, response.behavior]),
    [
      ["exit", "deny"],
      ["read", "allow"],
    ],
  );
});

test("a reply with no last message falls back to the timeline, and a failed or stuck turn is an error", async () => {
  const { paseo, state } = stubPaseo();
  const agents = createPaseoGuideAgents({ paseo: () => paseo, agent: async () => "claude", timeoutMs: 120_000 });

  state.waits = [{ status: "idle", lastMessage: null }];
  assert.equal(await agents.reply("agent-1"), "From the timeline");

  state.waits = [{ status: "error", error: "Provider crashed" }];
  await assert.rejects(agents.reply("agent-1"), new GuideAgentError("The guide agent failed: Provider crashed"));

  state.waits = [{ status: "timeout" }];
  await assert.rejects(agents.reply("agent-1"), new GuideAgentError("The guide agent did not finish within 2 minutes."));
});

test("a busy agent is not sent to, since sending would interrupt its turn", async () => {
  const { paseo, state } = stubPaseo();
  const agents = createPaseoGuideAgents({ paseo: () => paseo, agent: async () => "claude" });
  state.agentStatus = "running";

  assert.equal(await agents.status("agent-1"), "busy");
  await assert.rejects(agents.send("agent-1", "Why?"), { name: "GuideAgentError" });
  await assert.rejects(agents.run("agent-1", "Why?"), { name: "GuideAgentError" });
  assert.deepEqual(state.sent, []);

  state.agentStatus = "idle";
  await agents.send("agent-1", "Why?");
  assert.deepEqual(state.sent, ["Why?"]);
});

test("the permission hook denies a guide agent's writes and leaves other agents alone", async () => {
  const { paseo, state } = stubPaseo();
  const agents = createPaseoGuideAgents({ paseo: () => paseo, agent: async () => "claude" });

  await agents.onPermissionRequested("agent-1", request({ id: "edit", detail: { type: "edit", filePath: "a.ts" } }));
  await agents.onPermissionRequested("agent-1", request({ id: "read", detail: { type: "read", filePath: "a.ts" } }));
  state.labels = {};
  await agents.onPermissionRequested("agent-1", request({ id: "someone-elses", detail: { type: "edit", filePath: "a.ts" } }));

  assert.deepEqual(
    state.responses.map(({ requestId, response }) => [requestId, response.behavior]),
    [["edit", "deny"]],
  );
});
