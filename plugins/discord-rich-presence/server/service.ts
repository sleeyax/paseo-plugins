import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import type {
  KnownProject,
  PresenceActivity,
  PresenceSettings,
  PresenceSnapshot,
} from "../shared/presence.ts";
import { renderActivity } from "../shared/presence.ts";
import { knownProjects, type settingsDocument } from "../shared/settings.ts";
import { decideWrite, MIN_WRITE_INTERVAL_MS } from "../shared/throttle.ts";
import { DaemonConnection, type DaemonState } from "./daemon.ts";
import { DiscordConnection, type DiscordState } from "./discord.ts";

/** A burst of agent events is one presence write, and the debounce doubles as the rate-limit floor. */
const REFRESH_DEBOUNCE_MS = MIN_WRITE_INTERVAL_MS;
/** Covers anything the update stream misses, including a subscription lost to a reconnect. */
const REFRESH_INTERVAL_MS = 60_000;

export type Settings = PluginSettings<typeof settingsDocument.schema>;

export type PresenceStatus = {
  discord: DiscordState;
  daemon: DaemonState;
  activity: PresenceActivity | null;
  projects: KnownProject[];
};

export class PresenceService {
  private readonly startedAt = Date.now();
  private readonly daemon: DaemonConnection;
  private readonly discord: DiscordConnection;
  /** Null until a valid document is read, so nothing is shown before then. */
  private settings: PresenceSettings | null = null;
  private unsubscribe: (() => void) | null = null;
  private snapshot: PresenceSnapshot = { workspaces: [], agents: [], projects: [] };
  private activity: PresenceActivity | null = null;
  private lastPayload: string | null = null;
  private lastSentAt: number | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  /** The host may run the cleanup while start is still awaiting, and start must not bring anything back up after it. */
  private stopped = false;

  constructor(private readonly store: Settings) {
    this.daemon = new DaemonConnection({ onUpdate: () => this.scheduleRefresh() });
    this.discord = new DiscordConnection({ onReady: () => this.publish() });
  }

  async start(): Promise<void> {
    this.unsubscribe = this.store.subscribe((state) => this.follow(state));
    await this.follow(await this.store.read());
    if (this.stopped) return;
    await this.daemon.start();
    if (this.stopped) return;
    this.intervalTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.intervalTimer.unref?.();
    await this.refresh();
  }

  status(): PresenceStatus {
    return {
      discord: this.discord.currentState(),
      daemon: this.daemon.currentState(),
      activity: this.activity,
      projects: knownProjects(this.settings?.projectDetailLevels ?? {}, this.snapshot),
    };
  }

  /** An invalid document keeps the current settings, so a bad save never exposes a hidden project. */
  private async follow(state: PluginSettingsState<typeof settingsDocument.schema>): Promise<void> {
    if (this.stopped) return;
    if (state.status !== "ready") {
      console.warn(`discord-rich-presence kept its current settings, because the saved ones are invalid: ${state.error}`);
      return;
    }
    this.settings = state.values;
    this.applyConnection();
    await this.refresh();
  }

  private applyConnection(): void {
    const settings = this.settings;
    if (!settings?.enabled || !settings.applicationId) {
      this.lastPayload = null;
      this.lastSentAt = null;
      this.discord.disconnect();
      return;
    }
    this.discord.use(settings.applicationId);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
    this.refreshTimer.unref?.();
  }

  private async refresh(): Promise<void> {
    const snapshot = await this.daemon.snapshot();
    if (snapshot) this.snapshot = snapshot;
    await this.publish();
  }

  private async publish(): Promise<void> {
    const settings = this.settings;
    if (!settings || this.stopped) return;
    const now = Date.now();
    this.activity = renderActivity(this.snapshot, settings, this.startedAt, now);
    const payload = this.activity ? JSON.stringify(this.activity) : null;
    const decision = decideWrite({
      payload,
      lastPayload: this.lastPayload,
      lastSentAt: this.lastSentAt,
      now,
    });
    if (decision.send) {
      this.lastPayload = payload;
      this.lastSentAt = now;
      this.discord.setActivity(this.activity);
      return;
    }
    if (decision.retryInMs !== null) this.scheduleWrite(decision.retryInMs);
  }

  private scheduleWrite(delay: number): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.publish();
    }, delay);
    this.writeTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.writeTimer) clearTimeout(this.writeTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.discord.disconnect();
    await this.daemon.stop();
  }
}
