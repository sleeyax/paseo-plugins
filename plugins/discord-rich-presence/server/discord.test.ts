import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DiscordConnection } from "./discord.ts";
import { encodeFrame, FrameDecoder, OP_FRAME } from "./ipc.ts";

let runtimeDir: string;
let server: Server | null = null;

/** Stands in for Discord: the connection finds it because socketCandidates reads XDG_RUNTIME_DIR. */
async function listen(onHandshake: (socket: Socket) => void): Promise<void> {
  server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      if (decoder.push(chunk).length > 0) onHandshake(socket);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server!.listen(path.join(runtimeDir, "discord-ipc-0"), resolve));
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  runtimeDir = await mkdtemp(path.join(tmpdir(), "discord-rich-presence-"));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
});

after(async () => {
  server?.close();
  await rm(runtimeDir, { recursive: true, force: true });
});

test("stays idle until an application id is given", async () => {
  const connection = new DiscordConnection({ onReady: () => {} });
  await settle(50);
  assert.deepEqual(connection.currentState(), { status: "idle" });
  connection.disconnect();
});

test("connects once Discord answers the handshake", async () => {
  await listen((socket) => socket.write(encodeFrame(OP_FRAME, { cmd: "DISPATCH", evt: "READY", data: {} })));
  let ready = false;
  const connection = new DiscordConnection({ onReady: () => (ready = true) });
  connection.use("1234567890123456789");
  await settle(200);
  assert.deepEqual(connection.currentState(), { status: "connected" });
  assert.equal(ready, true);
  connection.disconnect();
  server?.close();
  server = null;
});

test("gives up on an application id Discord hangs up on, rather than retrying it forever", async () => {
  await listen((socket) => socket.destroy());
  const connection = new DiscordConnection({ onReady: () => {} });
  connection.use("1234567890123456789");
  await settle(200);
  const state = connection.currentState();
  assert.equal(state.status, "rejected");
  assert.match(state.status === "rejected" ? state.error : "", /application ID/i);

  // A retry would move it back to connecting; a refusal has to stay put until the id changes.
  await settle(300);
  assert.equal(connection.currentState().status, "rejected");
  connection.disconnect();
  server?.close();
  server = null;
});

test("reports a Discord that is not running, which is worth retrying", async () => {
  const connection = new DiscordConnection({ onReady: () => {} });
  connection.use("1234567890123456789");
  await settle(300);
  const state = connection.currentState();
  assert.equal(state.status, "unavailable");
  assert.match(state.status === "unavailable" ? state.error : "", /not running/i);
  connection.disconnect();
});

test("a new application id clears a refusal", async () => {
  await listen((socket) => socket.destroy());
  const connection = new DiscordConnection({ onReady: () => {} });
  connection.use("1234567890123456789");
  await settle(200);
  assert.equal(connection.currentState().status, "rejected");
  connection.use("9876543210987654321");
  assert.notEqual(connection.currentState().status, "rejected");
  connection.disconnect();
  server?.close();
  server = null;
});
