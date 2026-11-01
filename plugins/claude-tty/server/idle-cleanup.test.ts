import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { CAN_STOP_RUNTIME_CAPABILITY, CLAUDE_RUNNING_METHOD, idleCleanupVeto } from "./idle-cleanup.ts";

function harness(offered: readonly string[] = [CAN_STOP_RUNTIME_CAPABILITY]) {
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
  const veto = idleCleanupVeto();
  const connection = veto.wrap(inner, offered);
  connection.onEvent((event) => seen.push(event));
  return {
    inner,
    connection,
    sent,
    seen,
    emit: (event: ProviderEvent) => emit(event),
    claude(sessionId: string, running: boolean) {
      veto.transformer.notification?.({ method: CLAUDE_RUNNING_METHOD, params: { sessionId: "acp-session", running } }, { sessionId });
    },
    async ask(sessionId: string) {
      const requestId = `ask-${seen.length}`;
      await connection.send({ type: "session.can_stop_runtime", requestId, sessionId });
      return seen.find((event) => "requestId" in event && event.requestId === requestId);
    },
  };
}

function opened(sessionId: string, parentSessionId?: string): ProviderEvent {
  return {
    type: "session.opened",
    sessionId,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    capabilities: ["prompt.message"],
    restoration: parentSessionId === undefined ? "core" : "parent",
    cwd: "/work",
  };
}

test("leaves the connection alone on a daemon that does not offer the veto", () => {
  const { inner, connection } = harness([]);
  assert.equal(connection, inner);
});

test("advertises the veto on the connection and on every session, subsessions included", () => {
  const { connection, seen, emit } = harness();
  assert.deepEqual(connection.capabilities, ["prompt.message", CAN_STOP_RUNTIME_CAPABILITY]);

  emit(opened("root"));
  emit(opened("root:a1", "root"));

  assert.deepEqual(
    seen.map((event) => (event.type === "session.opened" ? event.capabilities : null)),
    [
      ["prompt.message", CAN_STOP_RUNTIME_CAPABILITY],
      ["prompt.message", CAN_STOP_RUNTIME_CAPABILITY],
    ],
  );
});

test("lets Paseo stop a session only while its Claude is not running, and answers for its subsessions", async () => {
  const h = harness();
  h.emit(opened("root"));
  h.emit(opened("root:a1", "root"));
  h.emit(opened("root:a1:b1", "root:a1"));

  assert.deepEqual(await h.ask("root"), { type: "session.can_stop_runtime", requestId: "ask-3", sessionId: "root", canStop: true });

  h.claude("root", true);
  for (const sessionId of ["root", "root:a1", "root:a1:b1"]) {
    const answer = await h.ask(sessionId);
    assert.ok(answer?.type === "session.can_stop_runtime");
    assert.equal(answer.canStop, false, `${sessionId} may stop while Claude runs`);
  }

  h.claude("root", false);
  const answer = await h.ask("root");
  assert.ok(answer?.type === "session.can_stop_runtime");
  assert.equal(answer.canStop, true);

  assert.deepEqual(h.sent, []);
});

test("keeps one session's Claude from deciding for another on the same connection", async () => {
  const h = harness();
  h.emit(opened("one"));
  h.emit(opened("two"));
  h.claude("one", true);

  const answer = await h.ask("two");
  assert.ok(answer?.type === "session.can_stop_runtime");
  assert.equal(answer.canStop, true);
});

test("fails the query for a session it does not have open", async () => {
  const h = harness();
  h.emit(opened("root"));
  h.emit({ type: "session.closed", sessionId: "root" });

  const answer = await h.ask("root");
  assert.equal(answer?.type, "request.failed");
});
