import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackgroundCommandOutput, COMMAND_FAILED, type BackgroundCommand } from "./background-commands.ts";
import type { SubagentSidecar } from "./subagent-transcripts.ts";
import { SUBSESSION_CAPABILITY, withSubagentSessions, type SubagentSource } from "./subsessions.ts";

const POLL_MS = 1;

type Harness = {
  connection: ProviderConnection;
  sent: ProviderInput[];
  seen: ProviderEvent[];
  emit(event: ProviderEvent): void;
  sidecars: SubagentSidecar[];
  steps: Map<string, ProviderTimelineItem[]>;
  /** The background commands the session's cards are marked with, by the tool call that launched each. */
  commands: Map<string, BackgroundCommand>;
  located: string | null;
  tick(): Promise<void>;
};

function sidecar(overrides: Partial<SubagentSidecar> = {}): SubagentSidecar {
  return { agentId: "a1", toolUseId: "toolu_1", agentType: "Explore", description: "Find the seam", nested: false, ...overrides };
}

function harness(offered: readonly string[] = [SUBSESSION_CAPABILITY]): Harness {
  const sent: ProviderInput[] = [];
  const seen: ProviderEvent[] = [];
  let emit: (event: ProviderEvent) => void = () => undefined;
  const inner: ProviderConnection = {
    version: 1,
    capabilities: ["prompt.message"],
    async send(input) {
      sent.push(input);
    },
    onEvent(listener) {
      emit = listener;
      return () => undefined;
    },
    async close() {},
  };
  const state = {
    sidecars: [] as SubagentSidecar[],
    steps: new Map<string, ProviderTimelineItem[]>(),
    commands: new Map<string, BackgroundCommand>(),
    located: "/subagents" as string | null,
  };
  const source: SubagentSource = {
    locate: async () => state.located,
    list: async () => state.sidecars,
    open: (_directory, agentId) => ({
      read: async () => {
        const pending = state.steps.get(agentId) ?? [];
        state.steps.set(agentId, []);
        return pending;
      },
      settle: () => [],
    }),
    backgroundCommand: (_sessionId, callId) => state.commands.get(callId) ?? null,
    openCommand: (command) => new BackgroundCommandOutput(command),
  };
  const connection = withSubagentSessions(inner, source, offered, POLL_MS);
  connection.onEvent((event) => seen.push(event));
  return {
    connection,
    sent,
    seen,
    emit: (event) => emit(event),
    get sidecars() {
      return state.sidecars;
    },
    set sidecars(value: SubagentSidecar[]) {
      state.sidecars = value;
    },
    steps: state.steps,
    commands: state.commands,
    get located() {
      return state.located;
    },
    set located(value: string | null) {
      state.located = value;
    },
    tick: () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS * 20)),
  };
}

function opened(harness: Harness, sessionId = "session"): void {
  harness.emit({
    type: "session.opened",
    sessionId,
    capabilities: ["prompt.message"],
    restoration: "core",
    persistence: { version: 1, data: { sessionId: "acp-1" } },
    cwd: "/work",
  });
}

function launch(harness: Harness, status: "running" | "completed" | "failed" | "canceled", callId = "toolu_1"): void {
  harness.emit({
    type: "timeline.item",
    sessionId: "session",
    item: {
      id: callId,
      type: "tool_call",
      callId,
      name: "Task",
      detail: { type: "plain_text", text: "Explore" },
      ...(status === "failed" ? { status, error: "no" } : { status, error: null }),
    },
  });
}

/** What the bridge makes of a still-open launch when Paseo cancels a turn to replace it. */
function launchCancelledWithTurn(harness: Harness, callId = "toolu_1"): void {
  harness.emit({
    type: "timeline.item",
    sessionId: "session",
    item: {
      id: callId,
      type: "tool_call",
      callId,
      name: "Task",
      detail: { type: "plain_text", text: "Explore" },
      status: "failed",
      error: null,
    },
  });
}

function childEvents(harness: Harness): ProviderEvent[] {
  return harness.seen.filter(
    (event) => "sessionId" in event && typeof event.sessionId === "string" && event.sessionId.startsWith("session:"),
  );
}

test("negotiates the capability on the connection and on every session the adapter opens", async () => {
  const kit = harness();
  assert.ok(kit.connection.capabilities.includes(SUBSESSION_CAPABILITY));
  opened(kit);
  const first = kit.seen[0];
  assert.equal(first?.type, "session.opened");
  assert.deepEqual(first.type === "session.opened" ? [...first.capabilities] : [], ["prompt.message", SUBSESSION_CAPABILITY]);
  await kit.connection.close();
});

test("leaves the connection alone on a daemon that offers no subsessions", async () => {
  const kit = harness([]);
  assert.deepEqual([...kit.connection.capabilities], ["prompt.message"]);
  opened(kit);
  kit.sidecars = [sidecar()];
  launch(kit, "running");
  await kit.tick();
  assert.deepEqual(childEvents(kit), []);
  await kit.connection.close();
});

test("opens a subsession for an agent whose launch is still open, and streams what it does", async () => {
  const kit = harness();
  opened(kit);
  launch(kit, "running");
  kit.sidecars = [sidecar()];
  kit.steps.set("a1", [{ id: "message-1", type: "assistant_message", text: "looking" }]);
  await kit.tick();

  const [open, item] = childEvents(kit);
  assert.equal(open?.type, "session.opened");
  assert.deepEqual(
    open?.type === "session.opened"
      ? { id: open.sessionId, parent: open.parentSessionId, title: open.title, description: open.description, capabilities: [...open.capabilities], restoration: open.restoration }
      : null,
    {
      id: "session:a1",
      parent: "session",
      title: "Explore",
      description: "Find the seam",
      capabilities: [],
      restoration: "parent",
    },
  );
  assert.equal(item?.type, "timeline.item");
  await kit.connection.close();
});

test("closes the subsession when the launch that started it ends, and says so when it failed", async () => {
  const kit = harness();
  opened(kit);
  launch(kit, "running");
  kit.sidecars = [sidecar()];
  await kit.tick();
  launch(kit, "failed");
  await kit.tick();

  const closed = childEvents(kit).find((event) => event.type === "session.closed");
  assert.equal(closed?.type, "session.closed");
  assert.ok(closed?.type === "session.closed" && closed.error !== undefined);
  await kit.connection.close();
});

test("keeps a subsession open across a launch cancelled with its turn, and closes it on the real ending", async () => {
  const kit = harness();
  opened(kit);
  launch(kit, "running");
  kit.sidecars = [sidecar()];
  await kit.tick();

  // A message sent while the agent runs: Paseo cancels the turn, the bridge terminalizes the launch
  // as failed with no error, and the outcome wrapper — outside this one — would repair it to canceled.
  launchCancelledWithTurn(kit);
  await kit.tick();
  assert.equal(childEvents(kit).find((event) => event.type === "session.closed"), undefined);

  // The agent keeps writing, so the adapter reopens the card; a later cancel arrives already repaired.
  launch(kit, "running");
  launch(kit, "canceled");
  await kit.tick();
  assert.equal(childEvents(kit).find((event) => event.type === "session.closed"), undefined);

  launch(kit, "running");
  launch(kit, "completed");
  await kit.tick();
  const closed = childEvents(kit).find((event) => event.type === "session.closed");
  assert.ok(closed?.type === "session.closed" && closed.error === undefined);
  await kit.connection.close();
});

test("never opens an agent a second time once its launch has ended", async () => {
  const kit = harness();
  opened(kit);
  launch(kit, "running");
  kit.sidecars = [sidecar()];
  await kit.tick();
  launch(kit, "completed");
  await kit.tick();
  await kit.tick();

  assert.equal(childEvents(kit).filter((event) => event.type === "session.opened").length, 1);
  assert.equal(childEvents(kit).filter((event) => event.type === "session.closed").length, 1);
  await kit.connection.close();
});

test("leaves a transcript whose launch was never seen open, and a nested agent, on the card", async () => {
  const kit = harness();
  opened(kit);
  kit.sidecars = [
    sidecar({ agentId: "history", toolUseId: "toolu_gone" }),
    sidecar({ agentId: "nested", toolUseId: "toolu_1", nested: true }),
  ];
  launch(kit, "running");
  await kit.tick();

  assert.deepEqual(childEvents(kit), []);
  await kit.connection.close();
});

test("stops emitting children the moment the daemon asks the session to close", async () => {
  const kit = harness();
  opened(kit);
  launch(kit, "running");
  await kit.connection.send({ type: "session.close", requestId: "r1", sessionId: "session" });
  kit.sidecars = [sidecar()];
  await kit.tick();

  assert.deepEqual(childEvents(kit), []);
  assert.equal(kit.sent[0]?.type, "session.close");
  await kit.connection.close();
});

test("stops emitting children for a session the adapter has reported closed", async () => {
  const kit = harness();
  opened(kit);
  launch(kit, "running");
  kit.emit({ type: "session.closed", sessionId: "session" });
  kit.sidecars = [sidecar()];
  await kit.tick();

  assert.deepEqual(childEvents(kit), []);
  await kit.connection.close();
});

test("closes the subsessions a session still had open when it goes", async () => {
  const kit = harness();
  opened(kit);
  launch(kit, "running");
  kit.sidecars = [sidecar()];
  await kit.tick();
  kit.emit({ type: "session.closed", sessionId: "session" });

  const closed = childEvents(kit).find((event) => event.type === "session.closed");
  assert.ok(closed?.type === "session.closed" && closed.error !== undefined);
  // The child's own close goes out before the session's, which the daemon refuses anything after.
  assert.ok(kit.seen.indexOf(closed) < kit.seen.findIndex((event) => event.type === "session.closed" && event.sessionId === "session"));
  await kit.connection.close();
});

test("waits for the state file that says which Claude session this is", async () => {
  const kit = harness();
  kit.located = null;
  opened(kit);
  launch(kit, "running");
  kit.sidecars = [sidecar()];
  await kit.tick();
  assert.deepEqual(childEvents(kit), []);

  kit.located = "/subagents";
  await kit.tick();
  assert.equal(childEvents(kit)[0]?.type, "session.opened");
  await kit.connection.close();
});

async function backgroundCommand(kit: Harness, output: string): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-tty-command-"));
  const outputFile = path.join(directory, "b1.output");
  await writeFile(outputFile, output);
  kit.commands.set("toolu_bg", { taskId: "b1", outputFile, command: "npm test", description: "Run the tests" });
}

function commandItems(kit: Harness): Extract<ProviderTimelineItem, { type: "tool_call" }>[] {
  return childEvents(kit).flatMap((event) =>
    event.type === "timeline.item" && event.item.type === "tool_call" ? [event.item] : [],
  );
}

test("opens a subsession for a background command while its card runs, and follows its output", async () => {
  const kit = harness();
  opened(kit);
  await backgroundCommand(kit, "pass one\n");
  launch(kit, "running", "toolu_bg");
  await kit.tick();

  const open = childEvents(kit)[0];
  assert.deepEqual(
    open?.type === "session.opened" ? { id: open.sessionId, parent: open.parentSessionId, title: open.title, description: open.description } : null,
    { id: "session:b1", parent: "session", title: "Background command", description: "Run the tests" },
  );
  assert.deepEqual(commandItems(kit).at(-1)?.detail, { type: "shell", command: "npm test", output: "pass one" });
  // Output that has not moved is nothing to send.
  const sent = childEvents(kit).length;
  await kit.tick();
  assert.equal(childEvents(kit).length, sent);

  launch(kit, "completed", "toolu_bg");
  await kit.tick();
  assert.equal(commandItems(kit).at(-1)?.status, "completed");
  const closed = childEvents(kit).at(-1);
  assert.deepEqual(closed, { type: "session.closed", sessionId: "session:b1" });
  await kit.connection.close();
});

test("closes a background command's subsession as failed when its card fails", async () => {
  const kit = harness();
  opened(kit);
  await backgroundCommand(kit, "");
  launch(kit, "running", "toolu_bg");
  await kit.tick();
  launch(kit, "failed", "toolu_bg");
  await kit.tick();

  // A failed call has to carry an error, or the daemon refuses the whole timeline it is in.
  const last = commandItems(kit).at(-1);
  assert.deepEqual(last === undefined ? null : { status: last.status, error: last.error }, { status: "failed", error: COMMAND_FAILED });
  assert.deepEqual(childEvents(kit).at(-1), { type: "session.closed", sessionId: "session:b1", error: { message: COMMAND_FAILED } });
  await kit.connection.close();
});
