import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { PresenceActivity } from "../shared/presence.ts";
import {
  closeFrameError,
  encodeFrame,
  frameError,
  FrameDecoder,
  handshakePayload,
  isReadyFrame,
  OP_FRAME,
  OP_HANDSHAKE,
  OP_PING,
  OP_PONG,
  setActivityFrame,
  socketCandidates,
} from "./ipc.ts";

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

export type DiscordState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "unavailable"; error: string }
  | { status: "rejected"; error: string };

/**
 * Owns the IPC socket and nothing else: what to show is decided upstream, so a Discord that is not
 * running, or is started later, shows up here as a retry rather than as a gap in the presence.
 * An application id Discord refuses is not retried, because only a new id can change the answer.
 */
export class DiscordConnection {
  private socket: Socket | null = null;
  private decoder = new FrameDecoder();
  private applicationId: string | null = null;
  private state: DiscordState = { status: "idle" };
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PresenceActivity | null = null;
  private readonly onReady: () => void;

  constructor(options: { onReady: () => void }) {
    this.onReady = options.onReady;
  }

  currentState(): DiscordState {
    return this.state;
  }

  /** Reconnects when the application id changes, and is a no-op when it has not. */
  use(applicationId: string): void {
    if (this.applicationId === applicationId && this.socket) return;
    this.disconnect();
    this.applicationId = applicationId;
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    const applicationId = this.applicationId;
    if (!applicationId || this.socket) return;
    const candidates = socketCandidates();
    this.state = { status: "connecting" };
    this.tryCandidate(candidates, 0, applicationId);
  }

  private tryCandidate(candidates: string[], index: number, applicationId: string): void {
    if (index >= candidates.length) {
      this.fail("Discord is not running");
      return;
    }
    const socket = createConnection(candidates[index]!);
    socket.once("error", () => {
      socket.destroy();
      if (this.socket === socket) this.socket = null;
      this.tryCandidate(candidates, index + 1, applicationId);
    });
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      this.attachSocket(socket, applicationId);
    });
  }

  private attachSocket(socket: Socket, applicationId: string): void {
    this.socket = socket;
    this.decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error: Error) => this.fail(error.message));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // Discord hangs up without a close frame when it does not recognise the application id.
      if (this.state.status === "connected") this.fail("Discord closed the connection");
      else this.reject("Discord refused this application ID");
    });
    this.handshakeTimer = setTimeout(
      () => this.reject("Discord did not answer the handshake"),
      HANDSHAKE_TIMEOUT_MS,
    );
    this.handshakeTimer.unref?.();
    socket.write(encodeFrame(OP_HANDSHAKE, handshakePayload(applicationId)));
  }

  private onData(chunk: Buffer): void {
    for (const frame of this.decoder.push(chunk)) {
      if (frame.op === OP_PING) {
        this.socket?.write(encodeFrame(OP_PONG, frame.payload));
        continue;
      }
      const error = closeFrameError(frame) ?? frameError(frame);
      if (error) {
        this.reject(error);
        return;
      }
      if (isReadyFrame(frame)) {
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.state = { status: "connected" };
        this.attempt = 0;
        if (this.pending) this.write(this.pending);
        this.onReady();
      }
    }
  }

  /** Refused rather than absent: retrying cannot help until the application id changes. */
  private reject(error: string): void {
    this.clearTimers();
    this.socket?.destroy();
    this.socket = null;
    this.state = { status: "rejected", error };
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.retryTimer = null;
    this.handshakeTimer = null;
  }

  private fail(error: string): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.socket?.destroy();
    this.socket = null;
    this.state = { status: "unavailable", error };
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.applicationId) return;
    this.attempt += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.attempt - 1), RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  setActivity(activity: PresenceActivity | null): void {
    this.pending = activity;
    if (this.state.status !== "connected") return;
    this.write(activity);
  }

  private write(activity: PresenceActivity | null): void {
    this.socket?.write(encodeFrame(OP_FRAME, setActivityFrame(activity, process.pid, randomUUID())));
  }

  /** Switching the presence off drops the socket, rather than holding one open for a disabled feature. */
  disconnect(): void {
    this.clearTimers();
    this.pending = null;
    this.applicationId = null;
    this.state = { status: "idle" };
    const socket = this.socket;
    this.socket = null;
    socket?.end();
    socket?.destroy();
  }
}
