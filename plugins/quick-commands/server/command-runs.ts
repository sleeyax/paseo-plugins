import type { ChildProcess } from "node:child_process";
import type { Command } from "../shared/commands.ts";
import { OUTPUT_LINE_LIMIT, type LastRun, type LastRuns } from "../shared/runs.ts";
import { OutputTail } from "./output-tail.ts";
import type { RunStore } from "./run-store.ts";

/** Starts `command` in a process group of its own, which Stop signals as a whole. */
export type Launch = (command: string) => ChildProcess;

export const STOP_GRACE_MS = 5_000;
/** How often a running command's output is written to disk, so a run cut off by a crash keeps most of it. */
const OUTPUT_SAVE_INTERVAL_MS = 2_000;

interface ActiveRun {
  child: ChildProcess;
  tail: OutputTail;
  stopRequested: boolean;
  killTimer: NodeJS.Timeout | null;
}

export class CommandRuns {
  readonly #launch: Launch;
  readonly #store: RunStore;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #listeners = new Set<() => void>();
  readonly #active = new Map<string, ActiveRun>();
  #runs: LastRuns = {};
  /** Commands that still exist; a run of one deleted while it ran is dropped when it finishes. */
  #known: Set<string> | null = null;
  #saving: Promise<void> = Promise.resolve();
  #saveTimer: NodeJS.Timeout | null = null;

  constructor(options: { launch: Launch; store: RunStore; now?: () => number; log?: (message: string) => void }) {
    this.#launch = options.launch;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? console.warn;
  }

  async load(): Promise<void> {
    const loaded = interruptRunning(await this.#store.load());
    // A run started before loading finished wins over the stored one.
    this.#runs = { ...loaded, ...this.#runs };
    this.#prune();
    this.#changed();
  }

  snapshot(): LastRuns {
    const runs: LastRuns = {};
    for (const [id, run] of Object.entries(this.#runs)) {
      const active = this.#active.get(id);
      runs[id] = active ? { ...run, output: active.tail.lines() } : run;
    }
    return runs;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isRunning(commandId: string): boolean {
    return this.#active.has(commandId);
  }

  start(command: Pick<Command, "id" | "command">): void {
    if (this.#active.has(command.id)) throw new Error("This command is already running.");

    const child = this.#launch(command.command);
    const active: ActiveRun = { child, tail: new OutputTail(OUTPUT_LINE_LIMIT), stopRequested: false, killTimer: null };
    this.#active.set(command.id, active);
    this.#runs[command.id] = { status: "running", exitCode: null, startedAt: this.#now(), finishedAt: null, output: [] };

    const onOutput = (chunk: string) => {
      active.tail.push(chunk);
      this.#changed();
      this.#saveSoon();
    };
    child.stdout?.setEncoding("utf8").on("data", onOutput);
    child.stderr?.setEncoding("utf8").on("data", onOutput);
    child.on("error", (error) => active.tail.push(`${error.message}\n`));
    // `close` follows `error` when the shell could not start, so this is the one place a run ends.
    child.on("close", (code) => this.#finish(command.id, active, code));

    this.#changed();
    this.#save();
  }

  stop(commandId: string): void {
    const active = this.#active.get(commandId);
    if (!active || active.stopRequested) return;
    active.stopRequested = true;
    this.#signalGroup(active.child, "SIGTERM");
    active.killTimer = setTimeout(() => this.#signalGroup(active.child, "SIGKILL"), STOP_GRACE_MS);
    active.killTimer.unref();
  }

  /** Takes the commands the settings now hold, and forgets the finished runs of any that were deleted. */
  retain(commandIds: Iterable<string>): void {
    this.#known = new Set(commandIds);
    if (this.#prune()) {
      this.#changed();
      this.#save();
    }
  }

  /** Resolves once every write so far has reached the disk. */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
      this.#save();
    }
    await this.#saving;
  }

  #finish(commandId: string, active: ActiveRun, code: number | null): void {
    if (this.#active.get(commandId) !== active) return;
    if (active.killTimer) clearTimeout(active.killTimer);
    this.#active.delete(commandId);

    const started = this.#runs[commandId];
    const status: LastRun["status"] = active.stopRequested ? "stopped" : code === 0 ? "succeeded" : "failed";
    this.#runs[commandId] = {
      status,
      exitCode: code,
      startedAt: started?.startedAt ?? this.#now(),
      finishedAt: this.#now(),
      output: active.tail.lines(),
    };
    this.#prune();
    this.#changed();
    this.#save();
  }

  #prune(): boolean {
    const known = this.#known;
    if (known === null) return false;
    let pruned = false;
    for (const id of Object.keys(this.#runs)) {
      if (!known.has(id) && !this.#active.has(id)) {
        delete this.#runs[id];
        pruned = true;
      }
    }
    return pruned;
  }

  #signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.#log(`could not send ${signal}: ${String(error)}`);
    }
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #saveSoon(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#save();
    }, OUTPUT_SAVE_INTERVAL_MS);
    this.#saveTimer.unref();
  }

  /** Writes run one after another, each with the state at the moment it starts. */
  #save(): void {
    this.#saving = this.#saving
      .then(() => this.#store.save(this.snapshot()))
      .catch((error: unknown) => this.#log(`could not save the last runs: ${String(error)}`));
  }
}

/** A stored run still marked running belonged to an earlier plugin process, which can no longer tell how it ended. */
function interruptRunning(runs: LastRuns): LastRuns {
  return Object.fromEntries(
    Object.entries(runs).map(([id, run]) => [id, run.status === "running" ? { ...run, status: "interrupted" as const } : run]),
  );
}
