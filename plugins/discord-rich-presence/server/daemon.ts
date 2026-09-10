import { promises as fs } from "node:fs";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { resolveDaemonPassword, resolveDaemonUrl, type Env } from "../shared/daemon-url.ts";
import type { PresenceSnapshot } from "../shared/presence.ts";
import { toPresenceSnapshot } from "../shared/snapshot.ts";
import { daemonConfigPath, pidFilePath } from "./paths.ts";

/** The daemon routes a `plugin:`-prefixed client id to its own plugin session, and that handshake never completes for a websocket. */
const DAEMON_CLIENT_ID = "discord-rich-presence";

const WORKSPACE_PAGE_LIMIT = 50;
const AGENT_PAGE_LIMIT = 100;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type DaemonState =
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "failed"; error: string };

async function readJsonFile(target: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(target, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * The plugin backend's own `paseo` handle only exists inside an RPC call, so a presence that has to
 * be live before anyone opens a panel needs its own connection. The daemon's address and password
 * come from the same places the CLI reads them, and the subprocess inherits the daemon's environment.
 */
export class DaemonConnection {
  private client: PaseoClient | null = null;
  private state: DaemonState = { status: "connecting" };
  private subscribed = false;
  private stopped = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly env: Env;
  private readonly onUpdate: () => void;

  constructor(options: { env?: Env; onUpdate: () => void }) {
    this.env = options.env ?? process.env;
    this.onUpdate = options.onUpdate;
  }

  currentState(): DaemonState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    const pid = await readJsonFile(pidFilePath(this.env));
    const config = await readJsonFile(daemonConfigPath(this.env));
    const daemonSection = (config?.daemon ?? null) as Record<string, unknown> | null;
    const target = resolveDaemonUrl({
      env: this.env,
      pidListen: stringField(pid, "listen") ?? stringField(pid, "sockPath"),
      configListen: stringField(daemonSection, "listen"),
    });
    if (target.error !== undefined) {
      this.state = { status: "failed", error: target.error };
      return;
    }

    this.client = createPaseoClient({
      url: target.url,
      clientId: DAEMON_CLIENT_ID,
      password: resolveDaemonPassword(this.env),
      reconnect: { enabled: true, baseDelayMs: RECONNECT_BASE_MS, maxDelayMs: RECONNECT_MAX_MS },
    });
    this.client.workspaces.subscribe(() => this.onUpdate());
    this.client.agents.subscribe(() => this.onUpdate());
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.client) return;
    this.state = { status: "connecting" };
    try {
      await this.client.connect();
      this.state = { status: "connected" };
      this.attempt = 0;
      this.subscribed = false;
      this.onUpdate();
    } catch (error) {
      this.state = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.attempt += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempt - 1), RECONNECT_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /**
   * Lists rather than accumulating the update stream: the presence only needs a handful of fields,
   * and a list call keeps a missed or replayed event from drifting the counts.
   * The project list is the settings surface's, not the presence's: a project with no workspace
   * open still has to be listed so a detail level can be set on it.
   * A project list that fails is dropped instead, because failing the snapshot would stall the presence behind a reconnect over data it never reads.
   */
  async snapshot(): Promise<PresenceSnapshot | null> {
    if (!this.client) return null;
    try {
      const subscribe = this.subscribed ? undefined : {};
      const [workspaces, agents, projects] = await Promise.all([
        this.client.workspaces.list({ page: { limit: WORKSPACE_PAGE_LIMIT }, subscribe }),
        this.client.agents.list({ scope: "active", page: { limit: AGENT_PAGE_LIMIT }, subscribe }),
        this.client.projects.list().catch(() => ({ projects: [] })),
      ]);
      this.subscribed = true;
      this.state = { status: "connected" };
      return toPresenceSnapshot(workspaces.entries, agents.entries, projects.projects);
    } catch (error) {
      this.state = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      this.subscribed = false;
      this.scheduleRetry();
      return null;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }
}
