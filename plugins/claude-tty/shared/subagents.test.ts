import assert from "node:assert/strict";
import test from "node:test";
import {
  agentIdFromFileName,
  joinSubagents,
  lastStepLabel,
  parseMeta,
  parseRecords,
  promptOf,
  readLaunches,
  readOutcomes,
  subagentFileName,
  SubagentSteps,
  type SubagentFile,
  type SubagentLaunch,
  type SubagentOutcome,
} from "./subagents.ts";

test("names a subagent transcript both ways and ignores anything else in the directory", () => {
  assert.equal(agentIdFromFileName("agent-a1.jsonl"), "a1");
  assert.equal(agentIdFromFileName("agent-.jsonl"), null);
  assert.equal(agentIdFromFileName("summary.txt"), null);
  assert.equal(subagentFileName("a1"), "agent-a1.jsonl");
});

test("holds the partial final line a transcript being appended to always has", () => {
  const records = parseRecords('{"type":"user"}\n\n{"type":"assistant"}\n{"type":"br');
  assert.deepEqual(records, [{ type: "user" }, { type: "assistant" }]);
});

test("reads launches and outcomes out of a session transcript", () => {
  const records = parseRecords(
    [
      JSON.stringify({ type: "user", toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1", description: "Audit" } }),
      JSON.stringify({ type: "user", toolUseResult: { status: "completed", agentId: "a2", description: "Search" } }),
      JSON.stringify({ type: "user", toolUseResult: { status: "completed" } }),
      JSON.stringify({
        type: "user",
        message: { content: "<task-notification> <task-id>a1</task-id> <status>failed</status> <summary>Agent failed</summary> </task-notification>" },
      }),
    ].join("\n"),
  );
  assert.deepEqual(readLaunches(records), [
    { agentId: "a1", description: "Audit", running: true },
    { agentId: "a2", description: "Search", running: false },
  ]);
  assert.deepEqual(readOutcomes(records), [{ agentId: "a1", status: "failed", summary: "Agent failed" }]);
});

test("reads the outcome of an agent whose notification was queued while Claude was busy", () => {
  const report = "<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent finished</summary> </task-notification>";
  const records = parseRecords(
    [
      JSON.stringify({ type: "user", toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1", description: "Audit" } }),
      // Claude was mid-turn when the agent finished, so its report was queued and no user turn carries it.
      JSON.stringify({ type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt: report } }),
    ].join("\n"),
  );

  assert.deepEqual(readOutcomes(records), [{ agentId: "a1", status: "completed", summary: "Agent finished" }]);
});

test("lists running subagents first and names one whose launch is gone after its prompt", () => {
  const files: SubagentFile[] = [
    { agentId: "done", lastActivity: 200, meta: null, prompt: null },
    { agentId: "orphan", lastActivity: 100, meta: null, prompt: "Investigate the auth module" },
    { agentId: "busy", lastActivity: 50, meta: null, prompt: null },
    { agentId: "nested", lastActivity: 25, meta: { description: "Check the SDK", nested: true }, prompt: null },
  ];
  const launches = new Map<string, SubagentLaunch>([
    ["busy", { agentId: "busy", description: "Audit the API", running: true }],
    ["done", { agentId: "done", description: "Search", running: false }],
  ]);
  const outcomes = new Map<string, SubagentOutcome>();

  assert.deepEqual(joinSubagents(files, launches, outcomes), [
    { agentId: "busy", description: "Audit the API", status: "running", summary: null, nested: false, lastActivity: 50 },
    { agentId: "done", description: "Search", status: "completed", summary: null, nested: false, lastActivity: 200 },
    { agentId: "orphan", description: "Investigate the auth module", status: "unknown", summary: null, nested: false, lastActivity: 100 },
    // Launched by another subagent, so the session's transcript says nothing about it at all.
    { agentId: "nested", description: "Check the SDK", status: "unknown", summary: null, nested: true, lastActivity: 25 },
  ]);
});

test("a notification decides the state of a subagent that was launched to run on its own", () => {
  const files: SubagentFile[] = [{ agentId: "a1", lastActivity: 10, meta: null, prompt: null }];
  const launches = new Map<string, SubagentLaunch>([["a1", { agentId: "a1", description: "Audit", running: true }]]);
  const outcomes = new Map<string, SubagentOutcome>([["a1", { agentId: "a1", status: "completed", summary: "Agent finished" }]]);
  assert.deepEqual(joinSubagents(files, launches, outcomes), [
    { agentId: "a1", description: "Audit", status: "completed", summary: "Agent finished", nested: false, lastActivity: 10 },
  ]);
});

test("reads the sidecar Claude writes beside a subagent transcript", () => {
  assert.deepEqual(
    parseMeta('{"agentType":"general-purpose","description":"Count the files","toolUseId":"toolu_1","spawnDepth":1}'),
    { description: "Count the files", nested: false },
  );
  assert.deepEqual(parseMeta('{"description":"Nested work","spawnDepth":2}'), { description: "Nested work", nested: true });
  assert.deepEqual(parseMeta("{}"), { description: null, nested: false });
  assert.equal(parseMeta("half written"), null);
  assert.equal(parseMeta(null), null);
});

test("reads what a subagent said, ran, and got back", () => {
  const records = parseRecords(
    [
      JSON.stringify({ type: "user", timestamp: "2026-09-01T15:43:30.000Z", message: { content: "You are auditing\nthe backend" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-01T15:43:37.000Z",
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Reading   the controllers" },
            { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/app.ts" } },
            { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pnpm test", description: "Run the suite" } },
            { type: "tool_use", id: "odd-1", name: "Unknown", input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-09-01T15:45:07.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "read-1", content: [{ type: "text", text: "contents" }] },
            { type: "tool_result", tool_use_id: "bash-1", is_error: true, content: [{ type: "text", text: "\nExit code 1\n17 tests failed" }] },
          ],
        },
      }),
    ].join("\n"),
  );

  const transcript = new SubagentSteps(200);
  transcript.append(records);
  assert.equal(transcript.startedAt, Date.parse("2026-09-01T15:43:30.000Z"));
  assert.deepEqual(transcript.steps, [
    { kind: "text", at: Date.parse("2026-09-01T15:43:37.000Z"), title: "Reading   the controllers", detail: null, body: null, failed: false, error: null },
    { kind: "tool", at: Date.parse("2026-09-01T15:43:37.000Z"), title: "Read", detail: null, body: "src/app.ts", failed: false, error: null },
    // The reason a tool failed is the whole of what is worth knowing about a run that went wrong.
    { kind: "tool", at: Date.parse("2026-09-01T15:43:37.000Z"), title: "Bash", detail: "Run the suite", body: "pnpm test", failed: true, error: "Exit code 1" },
    { kind: "tool", at: Date.parse("2026-09-01T15:43:37.000Z"), title: "Unknown", detail: null, body: null, failed: false, error: null },
  ]);
  assert.equal(promptOf(records), "You are auditing the backend");
});

test("keeps a step readable when what it was handed is not", () => {
  const records = parseRecords(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `A ${"very ".repeat(400)}long answer` },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "x".repeat(900), description: `run\n  ${"y".repeat(400)}` } },
        ],
      },
    }),
  );

  const collected = new SubagentSteps(200);
  collected.append(records);
  const [text, tool] = collected.steps;
  assert.equal(text?.title.length, 1_200);
  assert.equal(text?.title.endsWith("…"), true);
  assert.equal(tool?.body?.length, 400);
  assert.equal(tool?.detail?.includes("\n"), false);
  assert.equal(tool?.at, null);
});

test("says how long ago a subagent last wrote anything", () => {
  const now = 10 * 60 * 60_000;
  assert.equal(lastStepLabel(now - 5_000, now), "last step just now");
  assert.equal(lastStepLabel(now - 60_000, now), "last step 1 minute ago");
  assert.equal(lastStepLabel(now - 20 * 60_000, now), "last step 20 minutes ago");
  assert.equal(lastStepLabel(now - 3 * 3_600_000, now), "last step 3 hours ago");
  assert.equal(lastStepLabel(null, now), null);
});

test("parses only what is new, and keeps the tail of a run too long to show whole", () => {
  const steps = new SubagentSteps(3);
  const step = (index: number) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `bash-${index}`, name: "Bash", input: { command: `step ${index}` } }] } });

  steps.append(parseRecords([step(1), step(2)].join("\n")));
  assert.deepEqual(steps.steps.map((entry) => entry.body), ["step 1", "step 2"]);
  assert.equal(steps.earlier, 0);

  // The next read carries only the records the last one did not see, onto the same tail.
  steps.append(parseRecords([step(3), step(4)].join("\n")));
  assert.deepEqual(steps.steps.map((entry) => entry.body), ["step 2", "step 3", "step 4"]);
  assert.equal(steps.earlier, 1);

  // A result lands in a later read than the call it answers, and still marks it failed.
  steps.append(
    parseRecords(
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-4", is_error: true, content: "Exit code 1" }] } }),
    ),
  );
  assert.deepEqual(
    steps.steps.map((entry) => [entry.body, entry.failed, entry.error]),
    [
      ["step 2", false, null],
      ["step 3", false, null],
      ["step 4", true, "Exit code 1"],
    ],
  );
});
