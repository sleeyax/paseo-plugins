import path from "node:path";
import type { Env } from "../shared/daemon-url.ts";
import type { PresenceActivity } from "../shared/presence.ts";

export const OP_HANDSHAKE = 0;
export const OP_FRAME = 1;
export const OP_CLOSE = 2;
export const OP_PING = 3;
export const OP_PONG = 4;

const HEADER_BYTES = 8;
const SOCKET_INDEX_LIMIT = 10;

export type IpcFrame = { op: number; payload: unknown };

export function encodeFrame(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.alloc(HEADER_BYTES + body.length);
  frame.writeInt32LE(op, 0);
  frame.writeInt32LE(body.length, 4);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

/** Discord writes length-prefixed frames down a stream socket, so reads split and coalesce freely. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): IpcFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: IpcFrame[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (this.buffer.length < HEADER_BYTES + length) break;
      const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString("utf8");
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
      frames.push({ op, payload: body.length > 0 ? (JSON.parse(body) as unknown) : null });
    }
    return frames;
  }
}

function runtimeDir(env: Env): string {
  return env.XDG_RUNTIME_DIR ?? env.TMPDIR ?? env.TMP ?? env.TEMP ?? "/tmp";
}

/**
 * Discord may be a native install, a snap or a flatpak, and each puts its socket somewhere else.
 * The index rises when an earlier Discord instance already holds the lower one.
 */
export function socketCandidates(env: Env = process.env): string[] {
  const base = runtimeDir(env);
  const directories = [base, path.join(base, "snap.discord"), path.join(base, "app", "com.discordapp.Discord")];
  const candidates: string[] = [];
  for (let index = 0; index < SOCKET_INDEX_LIMIT; index += 1) {
    for (const directory of directories) {
      candidates.push(path.join(directory, `discord-ipc-${index}`));
    }
  }
  return candidates;
}

export function handshakePayload(applicationId: string): { v: number; client_id: string } {
  return { v: 1, client_id: applicationId };
}

export type DiscordActivityPayload = {
  details?: string;
  state?: string;
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
  timestamps?: { start?: number };
};

/** Rich presence is snake_case on the wire, and Discord rejects a frame carrying empty strings. */
export function toActivityPayload(activity: PresenceActivity): DiscordActivityPayload {
  const assets: DiscordActivityPayload["assets"] = {
    large_image: activity.largeImageKey,
    large_text: activity.largeImageText,
  };
  if (activity.smallImageKey) assets.small_image = activity.smallImageKey;
  if (activity.smallImageText) assets.small_text = activity.smallImageText;
  const payload: DiscordActivityPayload = {
    details: activity.details,
    assets,
    timestamps: { start: activity.startTimestamp },
  };
  if (activity.state) payload.state = activity.state;
  return payload;
}

export function setActivityFrame(
  activity: PresenceActivity | null,
  pid: number,
  nonce: string,
): { cmd: string; args: { pid: number; activity: DiscordActivityPayload | null }; nonce: string } {
  return {
    cmd: "SET_ACTIVITY",
    args: { pid, activity: activity ? toActivityPayload(activity) : null },
    nonce,
  };
}

export function isReadyFrame(frame: IpcFrame): boolean {
  const payload = frame.payload as { cmd?: unknown; evt?: unknown } | null;
  return frame.op === OP_FRAME && payload?.cmd === "DISPATCH" && payload?.evt === "READY";
}

/** Discord answers a bad handshake with a close frame carrying the reason, then hangs up. */
export function closeFrameError(frame: IpcFrame): string | null {
  if (frame.op !== OP_CLOSE) return null;
  const payload = frame.payload as { code?: unknown; message?: unknown } | null;
  const message = payload?.message;
  if (typeof message === "string" && message.length > 0) return message;
  return `Discord closed the connection (code ${String(payload?.code)})`;
}

export function frameError(frame: IpcFrame): string | null {
  const payload = frame.payload as { evt?: unknown; data?: { message?: unknown; code?: unknown } } | null;
  if (payload?.evt !== "ERROR") return null;
  const message = payload.data?.message;
  return typeof message === "string" ? message : `Discord rejected the frame (code ${String(payload.data?.code)})`;
}
