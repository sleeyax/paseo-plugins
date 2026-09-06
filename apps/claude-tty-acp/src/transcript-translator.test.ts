import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { TranscriptTranslator } from "./transcript-translator.ts";

test("translates messages, reasoning, tools, plans, usage, images, and system activity", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const records = [
    {
      type: "user",
      uuid: "user-1",
      message: { content: "hello<system-reminder>hidden</system-reminder>" },
    },
    {
      type: "assistant",
      uuid: "assistant-1",
      requestId: "request-1",
      context_window: 200_000,
      message: {
        usage: { input_tokens: 100, cache_read_input_tokens: 50 },
        content: [
          { type: "thinking", thinking: "considering" },
          { type: "text", text: "working" },
          { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } },
          {
            type: "tool_use",
            id: "todo-1",
            name: "TodoWrite",
            input: { todos: [{ content: "Implement", status: "in_progress" }, { content: "Verify", status: "pending" }] },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "result-1",
      message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: [{ type: "text", text: "updated" }] }] },
    },
    {
      type: "assistant",
      uuid: "assistant-image",
      message: { content: [{ type: "image", source: { data: "aW1hZ2U=", media_type: "image/png" } }] },
    },
    { type: "system", uuid: "system-1", subtype: "api_error", content: "Transient API error" },
  ];

  await translator.translate(records);
  await translator.translate(records);

  assert.deepEqual(
    notifications.map((notification) => notification.update.sessionUpdate),
    ["user_message_chunk", "agent_thought_chunk", "agent_message_chunk", "tool_call", "plan", "usage_update", "tool_call_update", "agent_message_chunk", "agent_message_chunk"],
  );
  const tool = notifications.find((notification) => notification.update.sessionUpdate === "tool_call")?.update;
  assert.ok(tool?.sessionUpdate === "tool_call");
  assert.equal(tool.kind, "edit");
  assert.deepEqual(tool.locations, [{ path: "/work/repo/src/app.ts" }]);
  assert.deepEqual(tool.content, [{ type: "diff", path: "/work/repo/src/app.ts", oldText: "a", newText: "b" }]);
  const plan = notifications.find((notification) => notification.update.sessionUpdate === "plan")?.update;
  assert.ok(plan?.sessionUpdate === "plan");
  assert.deepEqual(plan.entries.map((entry) => entry.status), ["in_progress", "pending"]);
  const usage = notifications.find((notification) => notification.update.sessionUpdate === "usage_update")?.update;
  assert.deepEqual(usage, { sessionUpdate: "usage_update", size: 200_000, used: 150 });
  const chunks = notifications.filter((notification) => notification.update.sessionUpdate.endsWith("message_chunk"));
  assert.ok(chunks.every((notification) => "messageId" in notification.update && /^[0-9a-f-]{36}$/.test(String(notification.update.messageId))));
  assert.equal(translator.assistantChunks, 3);
});

test("suppresses a transcript answer already emitted from the Stop fallback", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  translator.suppressNextAssistantText("Hello from Claude");
  await translator.translate([
    { type: "assistant", uuid: "late-answer", message: { content: [{ type: "text", text: "Hello from Claude" }] } },
  ]);
  assert.equal(notifications.length, 0);

  await translator.translate([{ type: "user", uuid: "next-user", message: { content: "next" } }]);
  await translator.translate([
    { type: "assistant", uuid: "next-answer", message: { content: [{ type: "text", text: "Hello from Claude" }] } },
  ]);
  assert.deepEqual(notifications.map((notification) => notification.update.sessionUpdate), ["user_message_chunk", "agent_message_chunk"]);
});

test("renders question tool calls as readable text instead of raw JSON", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const input = {
    questions: [
      {
        question: "Choose runtime",
        header: "Runtime",
        options: [
          { label: "Node", description: "Use the established runtime" },
          { label: "Bun", description: "Use the faster alternative" },
        ],
        multiSelect: false,
      },
    ],
  };

  await translator.translate([
    {
      type: "assistant",
      uuid: "question-message",
      message: { content: [{ type: "tool_use", id: "question-tool", name: "AskUserQuestion", input }] },
    },
  ]);

  assert.equal(notifications.length, 1);
  const update = notifications[0]?.update;
  assert.ok(update?.sessionUpdate === "tool_call");
  assert.deepEqual(update.rawInput, input);
  assert.deepEqual(update.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: "Choose runtime\n\n- Node — Use the established runtime\n- Bun — Use the faster alternative",
      },
    },
  ]);
});

test("keeps an asynchronous agent's tool call open and streams the work it does", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: {
        content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Audit the API", subagent_type: "general-purpose" } }],
      },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1", description: "Audit the API" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
    },
  ]);

  const launch = notifications.map((notification) => notification.update);
  assert.deepEqual(launch.map((update) => update.sessionUpdate), ["tool_call", "tool_call_update"]);
  assert.ok(launch[0]?.sessionUpdate === "tool_call");
  assert.equal(launch[0].title, "Agent: Audit the API");
  assert.equal(launch[0].status, "in_progress");
  assert.ok(launch[1]?.sessionUpdate === "tool_call_update");
  assert.equal(launch[1].status, "in_progress");

  notifications.length = 0;
  await translator.translateSubagent("a1", [
    {
      type: "assistant",
      uuid: "sub-1",
      message: {
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Reading the controllers" },
          { type: "tool_use", id: "sub-read", name: "Read", input: { file_path: "src/app.ts" } },
        ],
      },
    },
  ]);

  assert.equal(notifications.length, 1);
  const streamed = notifications[0]?.update;
  assert.ok(streamed?.sessionUpdate === "tool_call_update");
  assert.equal(streamed.toolCallId, "agent-tool");
  assert.equal(streamed.status, "in_progress");
  assert.deepEqual(streamed.content, [
    { type: "content", content: { type: "text", text: "Reading the controllers\n• Read: src/app.ts" } },
  ]);

  notifications.length = 0;
  const notification =
    "<task-notification> <task-id>a1</task-id> <tool-use-id>agent-tool</tool-use-id> <status>completed</status> <summary>Agent \"Audit the API\" finished</summary> </task-notification>";
  await translator.translate([{ type: "user", uuid: "notified", message: { content: notification } }]);
  await translator.translate([{ type: "user", uuid: "notified", message: { content: notification } }]);

  assert.equal(notifications.length, 1);
  const finished = notifications[0]?.update;
  assert.ok(finished?.sessionUpdate === "tool_call_update");
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.content, [
    {
      type: "content",
      content: { type: "text", text: 'Reading the controllers\n• Read: src/app.ts\nAgent "Audit the API" finished' },
    },
  ]);
});

test("shows a subagent's steps that arrived before its launch was read, and its nested agents", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translateSubagent("a1", [
    { type: "assistant", uuid: "early", message: { content: [{ type: "text", text: "Started early" }] } },
  ]);
  assert.equal(notifications.length, 0);

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Task", input: { description: "Search" } }] },
    },
    {
      type: "user",
      uuid: "finished",
      toolUseResult: { status: "completed", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [{ type: "text", text: "report" }] }] },
    },
  ]);

  // A synchronous agent answers when it is done, so its card is linked, filled in and then closed.
  assert.deepEqual(notifications.map((notification) => notification.update.sessionUpdate), ["tool_call", "tool_call_update", "tool_call_update"]);
  const linked = notifications[1]?.update;
  assert.ok(linked?.sessionUpdate === "tool_call_update");
  assert.deepEqual(linked.content, [{ type: "content", content: { type: "text", text: "Started early" } }]);
  const closed = notifications[2]?.update;
  assert.ok(closed?.sessionUpdate === "tool_call_update");
  assert.equal(closed.status, "completed");

  notifications.length = 0;
  await translator.translateSubagent("a1", [
    { type: "user", uuid: "nested-launch", toolUseResult: { isAsync: true, status: "async_launched", agentId: "a2" }, message: { content: [] } },
  ]);
  await translator.translateSubagent("a2", [
    { type: "assistant", uuid: "nested", message: { content: [{ type: "text", text: "Nested work" }] } },
  ]);

  assert.equal(notifications.length, 1);
  const nested = notifications[0]?.update;
  assert.ok(nested?.sessionUpdate === "tool_call_update");
  assert.equal(nested.toolCallId, "agent-tool");
  assert.deepEqual(nested.content, [{ type: "content", content: { type: "text", text: "Started early\n↳ Nested work" } }]);
});

test("carries a nested subagent's earlier steps onto the card of the agent that launched it", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  // Transcripts are read in name order, so a nested agent is routinely seen before its spawner.
  await translator.translateSubagent("nested", [
    { type: "assistant", uuid: "n1", message: { content: [{ type: "text", text: "Nested first step" }] } },
  ]);
  await translator.translateSubagent("spawner", [
    { type: "user", uuid: "s1", toolUseResult: { isAsync: true, status: "async_launched", agentId: "nested" }, message: { content: [] } },
    { type: "assistant", uuid: "s2", message: { content: [{ type: "text", text: "Spawner step" }] } },
  ]);
  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Investigate" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "spawner" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ]);

  const linked = notifications.at(-1)?.update;
  assert.ok(linked?.sessionUpdate === "tool_call_update");
  assert.deepEqual(linked.content, [
    { type: "content", content: { type: "text", text: "↳ Nested first step\nSpawner step" } },
  ]);

  notifications.length = 0;
  await translator.translateSubagent("nested", [
    { type: "assistant", uuid: "n2", message: { content: [{ type: "text", text: "Nested later step" }] } },
  ]);
  const streamed = notifications[0]?.update;
  assert.ok(streamed?.sessionUpdate === "tool_call_update");
  assert.equal(streamed.toolCallId, "agent-tool");
  assert.deepEqual(streamed.content, [
    { type: "content", content: { type: "text", text: "↳ Nested first step\nSpawner step\n↳ Nested later step" } },
  ]);
});

test("counts the agents a turn is still waiting on, and ignores the ones history only remembers", async () => {
  const connection = { sessionUpdate: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const launch = (toolCallId: string, agentId: string, running: boolean) => [
    {
      type: "assistant",
      uuid: `launcher-${agentId}`,
      message: { content: [{ type: "tool_use", id: toolCallId, name: "Agent", input: { description: agentId } }] },
    },
    {
      type: "user",
      uuid: `launched-${agentId}`,
      toolUseResult: running ? { isAsync: true, status: "async_launched", agentId } : { status: "completed", agentId },
      message: { content: [{ type: "tool_result", tool_use_id: toolCallId, content: [] }] },
    },
  ];

  // A session being loaded replays a transcript whose agents died with the process that ran them.
  await translator.translate(launch("history-tool", "history", true));
  assert.equal(translator.runningSubagents, 0);

  translator.trackRunningSubagents();
  await translator.translate([...launch("async-tool", "async", true), ...launch("sync-tool", "sync", false)]);
  assert.equal(translator.runningSubagents, 1);

  // A nested agent is part of the one piece of work the session launched, not a second one.
  await translator.translateSubagent("async", [
    { type: "user", uuid: "nested", toolUseResult: { isAsync: true, status: "async_launched", agentId: "nested" }, message: { content: [] } },
  ]);
  assert.equal(translator.runningSubagents, 1);

  const activityBefore = translator.subagentActivityAt;
  assert.ok(activityBefore > 0);
  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: { content: "<task-notification> <task-id>async</task-id> <status>completed</status> <summary>done</summary> </task-notification>" },
    },
  ]);
  assert.equal(translator.runningSubagents, 0);
  assert.ok(translator.subagentActivityAt >= activityBefore);
});

test("does not wait again on an agent whose launch a rewrite replayed", async () => {
  const connection = { sessionUpdate: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const launch = [
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ];

  translator.trackRunningSubagents();
  await translator.translate(launch);
  assert.equal(translator.runningSubagents, 1);

  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: { content: "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>done</summary> </task-notification>" },
    },
  ]);
  assert.equal(translator.runningSubagents, 0);

  // A compaction rewrites the transcript, and the reader that notices replays it from the top.
  await translator.translate(launch);
  assert.equal(translator.runningSubagents, 0);
});

test("does not wait again on an agent a turn gave up on when a rewrite replays its launch", async () => {
  const connection = { sessionUpdate: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const launch = [
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Count the files" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
  ];

  translator.trackRunningSubagents();
  await translator.translate(launch);
  assert.equal(translator.runningSubagents, 1);

  // The turn waited its bound out on an agent that never reported, and stopped counting it.
  translator.abandonRunningSubagents();
  assert.equal(translator.runningSubagents, 0);

  await translator.translate(launch);
  assert.equal(translator.runningSubagents, 0);
});

test("settles a subagent whose launch is no longer in the transcript, so it stops being followed", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  const steps = (agentId: string) => [
    { type: "assistant", uuid: `${agentId}-step`, message: { content: [{ type: "text", text: "Counting" }] } },
  ];

  // Two agents whose transcripts exist, and whose launches a compaction has taken out of the session's own.
  await translator.translateSubagent("reported", steps("reported"));
  await translator.translateSubagent("unreported", steps("unreported"));
  assert.equal(translator.subagentSettled("reported"), false);
  assert.equal(translator.subagentSettled("unreported"), false);

  // One reports, in the only record that says so.
  await translator.translate([
    {
      type: "user",
      uuid: "notified",
      message: { content: "<task-notification><task-id>reported</task-id><status>completed</status><summary>done</summary></task-notification>" },
    },
  ]);
  assert.equal(translator.subagentSettled("reported"), true);
  assert.equal(translator.subagentSettled("unreported"), false);

  // The other is still open when the session stops, which is the end of it too.
  await translator.settleOpenToolCalls();
  assert.equal(translator.subagentSettled("unreported"), true);

  // Neither has a tool call to show any of this on.
  assert.deepEqual(notifications, []);
});

test("leaves a synchronous agent's report alone when the session it ran in stops", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: { content: [{ type: "tool_use", id: "task-1", name: "Task", input: { description: "Count the files" } }] },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { status: "completed", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "task-1", content: [{ type: "text", text: "There are 12." }] }] },
    },
  ]);

  const reported = notifications.map((notification) => notification.update).at(-1);
  assert.ok(reported?.sessionUpdate === "tool_call_update");
  assert.equal(reported.status, "completed");
  assert.deepEqual(reported.content, [{ type: "content", content: { type: "text", text: "There are 12." } }]);

  // A history replay settles the calls of a session that is no longer running, and an agent that
  // answered inside its launcher's turn is not one of them.
  notifications.length = 0;
  await translator.settleOpenToolCalls();
  assert.deepEqual(notifications, []);
});

test("closes the tool calls a stopped session left running, and leaves the ones it answered", async () => {
  const notifications: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (notification: SessionNotification) => {
      notifications.push(notification);
    },
  } as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);

  await translator.translate([
    {
      type: "assistant",
      uuid: "launcher",
      message: {
        content: [
          { type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Fix the findings" } },
          { type: "tool_use", id: "done-agent-tool", name: "Agent", input: { description: "Review the branch" } },
          { type: "tool_use", id: "bash-tool", name: "Bash", input: { command: "pnpm test" } },
          { type: "tool_use", id: "read-tool", name: "Read", input: { file_path: "src/app.ts" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "launched",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1", description: "Fix the findings" },
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: [] }] },
    },
    {
      type: "user",
      uuid: "launched-done",
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "a2", description: "Review the branch" },
      message: { content: [{ type: "tool_result", tool_use_id: "done-agent-tool", content: [] }] },
    },
    {
      type: "user",
      uuid: "reported",
      message: { content: "<task-notification> <task-id>a2</task-id> <status>completed</status> <summary>Reviewed</summary> </task-notification>" },
    },
    {
      type: "user",
      uuid: "read-result",
      message: { content: [{ type: "tool_result", tool_use_id: "read-tool", content: [{ type: "text", text: "contents" }] }] },
    },
  ]);
  await translator.translateSubagent("a1", [
    { type: "assistant", uuid: "sub-1", message: { content: [{ type: "text", text: "Reading the diff" }] } },
  ]);

  notifications.length = 0;
  await translator.settleOpenToolCalls();
  await translator.settleOpenToolCalls();

  const updates = notifications.map((notification) => notification.update);
  assert.equal(updates.length, 2);
  assert.ok(updates[0]?.sessionUpdate === "tool_call_update");
  assert.equal(updates[0].toolCallId, "agent-tool");
  assert.equal(updates[0].status, "failed");
  assert.deepEqual(updates[0].content, [
    { type: "content", content: { type: "text", text: "Reading the diff\nClaude stopped before this agent reported back." } },
  ]);
  assert.ok(updates[1]?.sessionUpdate === "tool_call_update");
  assert.equal(updates[1].toolCallId, "bash-tool");
  assert.equal(updates[1].status, "failed");
  assert.equal(translator.runningSubagents, 0);
});

test("reads the session's last sign of life from whatever moved last, Claude's own tools included", async () => {
  const connection = { sessionUpdate: async () => undefined } as unknown as AgentSideConnection;
  const translator = new TranscriptTranslator("session", "/work/repo", connection);
  assert.equal(translator.activityAt, 0);
  assert.equal(translator.assistantActivityAt, 0);

  await translator.translate([{ type: "user", uuid: "user-1", message: { content: "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>" } }]);
  // Nothing is shown for a notification about a command, but the turn Claude was woken with is the session moving.
  assert.equal(translator.assistantActivityAt, 0);
  assert.equal(translator.activityAt, 0);

  await translator.translate([{ type: "user", uuid: "user-2", message: { content: "carry on" } }]);
  const wokenAt = translator.activityAt;
  assert.ok(wokenAt > 0);
  assert.equal(translator.assistantActivityAt, 0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await translator.translate([
    { type: "assistant", uuid: "assistant-1", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls" } }] } },
  ]);
  const calledAt = translator.assistantActivityAt;
  assert.ok(calledAt > wokenAt);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await translator.translate([{ type: "user", uuid: "user-3", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "done" }] } }]);
  assert.ok(translator.assistantActivityAt > calledAt, "a tool finishing is Claude's own progress");
  assert.equal(translator.activityAt, translator.assistantActivityAt);

  // Reading the same records again shows nothing new, and so moves nothing.
  const settledAt = translator.activityAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await translator.translate([{ type: "user", uuid: "user-3", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "done" }] } }]);
  assert.equal(translator.activityAt, settledAt);
});
