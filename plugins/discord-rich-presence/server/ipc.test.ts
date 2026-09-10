import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresenceActivity } from "../shared/presence.ts";
import {
  closeFrameError,
  encodeFrame,
  frameError,
  FrameDecoder,
  handshakePayload,
  isReadyFrame,
  OP_CLOSE,
  OP_FRAME,
  OP_HANDSHAKE,
  setActivityFrame,
  socketCandidates,
  toActivityPayload,
} from "./ipc.ts";

const ACTIVITY: PresenceActivity = {
  details: "paseo-plugins — main",
  state: "2 workspaces · idle",
  largeImageKey: "paseo",
  largeImageText: "Paseo",
  smallImageKey: "running",
  smallImageText: "Running",
  startTimestamp: 1_700_000_000_000,
};

test("encodes an opcode, a length and a json body", () => {
  const frame = encodeFrame(OP_HANDSHAKE, handshakePayload("1234567890123456789"));
  assert.equal(frame.readInt32LE(0), OP_HANDSHAKE);
  assert.equal(frame.readInt32LE(4), frame.length - 8);
  assert.deepEqual(JSON.parse(frame.subarray(8).toString("utf8")), {
    v: 1,
    client_id: "1234567890123456789",
  });
});

test("decodes a frame written in one piece", () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(encodeFrame(OP_FRAME, { cmd: "DISPATCH", evt: "READY" }));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.op, OP_FRAME);
});

test("waits for the rest of a frame split across reads", () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame(OP_FRAME, { cmd: "DISPATCH", evt: "READY" });
  assert.deepEqual(decoder.push(frame.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(frame.subarray(5, 12)), []);
  const frames = decoder.push(frame.subarray(12));
  assert.equal(frames.length, 1);
  assert.equal(isReadyFrame(frames[0]!), true);
});

test("decodes two frames arriving in one read", () => {
  const decoder = new FrameDecoder();
  const chunk = Buffer.concat([
    encodeFrame(OP_FRAME, { cmd: "DISPATCH", evt: "READY" }),
    encodeFrame(OP_FRAME, { cmd: "SET_ACTIVITY", nonce: "n1" }),
  ]);
  const frames = decoder.push(chunk);
  assert.equal(frames.length, 2);
  assert.equal((frames[1]?.payload as { nonce?: string }).nonce, "n1");
});

test("recognises the ready dispatch and nothing else", () => {
  assert.equal(isReadyFrame({ op: OP_FRAME, payload: { cmd: "DISPATCH", evt: "READY" } }), true);
  assert.equal(isReadyFrame({ op: OP_FRAME, payload: { cmd: "SET_ACTIVITY" } }), false);
  assert.equal(isReadyFrame({ op: OP_HANDSHAKE, payload: { cmd: "DISPATCH", evt: "READY" } }), false);
});

test("reads the message out of an error frame", () => {
  assert.equal(
    frameError({ op: OP_FRAME, payload: { evt: "ERROR", data: { code: 4009, message: "Invalid Client ID" } } }),
    "Invalid Client ID",
  );
  assert.equal(frameError({ op: OP_FRAME, payload: { cmd: "SET_ACTIVITY" } }), null);
});

test("maps the activity onto the wire's snake case", () => {
  assert.deepEqual(toActivityPayload(ACTIVITY), {
    details: "paseo-plugins — main",
    state: "2 workspaces · idle",
    assets: {
      large_image: "paseo",
      large_text: "Paseo",
      small_image: "running",
      small_text: "Running",
    },
    timestamps: { start: 1_700_000_000_000 },
  });
});

test("leaves out the fields the anonymous rendering does not set", () => {
  const anonymous: PresenceActivity = {
    details: "Using Paseo",
    largeImageKey: "paseo",
    largeImageText: "Paseo",
    startTimestamp: 1_700_000_000_000,
  };
  assert.deepEqual(toActivityPayload(anonymous), {
    details: "Using Paseo",
    assets: { large_image: "paseo", large_text: "Paseo" },
    timestamps: { start: 1_700_000_000_000 },
  });
});

test("clears the presence with a null activity", () => {
  assert.deepEqual(setActivityFrame(null, 42, "nonce-1"), {
    cmd: "SET_ACTIVITY",
    args: { pid: 42, activity: null },
    nonce: "nonce-1",
  });
});

test("looks for the socket where a native, snap and flatpak Discord each put it", () => {
  const candidates = socketCandidates({ XDG_RUNTIME_DIR: "/run/user/1000" });
  assert.deepEqual(candidates.slice(0, 3), [
    "/run/user/1000/discord-ipc-0",
    "/run/user/1000/snap.discord/discord-ipc-0",
    "/run/user/1000/app/com.discordapp.Discord/discord-ipc-0",
  ]);
  assert.equal(candidates.length, 30);
  assert.equal(candidates.at(-3), "/run/user/1000/discord-ipc-9");
});

test("falls back to a temp directory without a runtime dir", () => {
  assert.equal(socketCandidates({ TMPDIR: "/tmp" })[0], "/tmp/discord-ipc-0");
  assert.equal(socketCandidates({})[0], "/tmp/discord-ipc-0");
});

test("reads the reason out of a close frame", () => {
  assert.equal(
    closeFrameError({ op: OP_CLOSE, payload: { code: 4000, message: "Invalid Client ID" } }),
    "Invalid Client ID",
  );
  assert.match(closeFrameError({ op: OP_CLOSE, payload: { code: 4000 } }) ?? "", /code 4000/);
  assert.equal(closeFrameError({ op: OP_FRAME, payload: { cmd: "SET_ACTIVITY" } }), null);
});
