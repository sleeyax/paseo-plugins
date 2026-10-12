import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
} from "@agentclientprotocol/sdk";
import { ClaudeTtyAgent } from "./agent.ts";
import { withRequestErrors } from "./request-errors.ts";

/** Connects a client to the agent over the SDK's own JSON-RPC, so the test sees what Paseo sees. */
function connect(): { client: ClientSideConnection; agent: () => ClaudeTtyAgent | null } {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: ClaudeTtyAgent | null = null;
  new AgentSideConnection((connection) => {
    agent = new ClaudeTtyAgent(connection);
    return withRequestErrors(agent);
  }, ndJsonStream(toClient.writable, toAgent.readable));
  const client = new ClientSideConnection(
    () => ({ requestPermission: async () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: async () => undefined }) as Client,
    ndJsonStream(toAgent.writable, toClient.readable),
  );
  return { client, agent: () => agent };
}

test("answers a failed request with the adapter's own sentence", async () => {
  const { client, agent } = connect();
  await client.initialize({ protocolVersion: PROTOCOL_VERSION });

  await assert.rejects(client.prompt({ sessionId: "missing", prompt: [{ type: "text", text: "hi" }] }), {
    code: -32603,
    message: "Session missing not found",
  });
  await agent()?.close();
});

test("passes a RequestError through as it was thrown", async () => {
  const thrown = RequestError.invalidParams(undefined, "no such mode");
  const wrapped = withRequestErrors({
    initialize: async () => {
      throw thrown;
    },
  } as unknown as ClaudeTtyAgent);

  await assert.rejects(wrapped.initialize({ protocolVersion: PROTOCOL_VERSION }), (error) => error === thrown);
});
