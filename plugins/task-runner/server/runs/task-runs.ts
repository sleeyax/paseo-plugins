import { TASK_TERMINAL_PREFIX, type RunState, type Task } from "../../shared/task.ts";
import { presentableOutput, readTaskExit, wrapTask, type TaskExit } from "./shell-wrapper.ts";
import type { TaskHistory } from "./task-history.ts";
import type { TerminalPort, TerminalRecord } from "./terminal-port.ts";

const OUTPUT_LINES = 50;
const FORCE_KILL_AFTER_MS = 5_000;
const INTERRUPTED_EXIT_CODE = 130;

/** Lives only as long as the plugin process, so after a plugin reload a stopped task reads by its exit code alone. */
type TrackedTerminal = {
  workspaceId: string;
  stopRequestedAt: number | null;
  /** Kept so a marker that scrolls out of the buffer does not turn a finished task back into a running one. */
  exit: TaskExit | null;
};

export type TaskRunsOptions = {
  terminals: TerminalPort;
  history: TaskHistory;
  now?: () => number;
};

export class TaskRuns {
  private readonly terminals: TerminalPort;
  private readonly history: TaskHistory;
  private readonly now: () => number;
  private readonly tracked = new Map<string, TrackedTerminal>();

  constructor(options: TaskRunsOptions) {
    this.terminals = options.terminals;
    this.history = options.history;
    this.now = options.now ?? Date.now;
  }

  async run(workspaceId: string, task: Task): Promise<void> {
    if (task.disabledReason !== null) throw new Error(task.disabledReason);
    const existing = (await this.terminals.list(workspaceId)).filter((terminal) => terminal.name === task.id);
    await Promise.all(existing.map((terminal) => this.close(terminal.id)));
    await this.terminals.create({ workspaceId, name: task.id, cwd: task.cwd, ...wrapTask(task) });
    await this.history.record(workspaceId, task);
  }

  /** Task IDs, most recent first. */
  async recent(workspaceId: string): Promise<string[]> {
    return (await this.history.read(workspaceId)).map((task) => task.id);
  }

  async rerunLast(workspaceId: string): Promise<Task | null> {
    const [last] = await this.history.read(workspaceId);
    if (last === undefined) return null;
    await this.run(workspaceId, last);
    return last;
  }

  async states(workspaceId: string): Promise<RunState[]> {
    const terminals = (await this.terminals.list(workspaceId)).filter((terminal) => terminal.name.startsWith(TASK_TERMINAL_PREFIX));
    this.forgetClosed(workspaceId, terminals);
    const states = await Promise.all(terminals.map((terminal) => this.readState(workspaceId, terminal)));
    return states.filter((state) => state !== null);
  }

  async stop(workspaceId: string, terminalId: string): Promise<void> {
    const entry = this.entry(workspaceId, terminalId);
    if (entry.exit === null) entry.exit = readTaskExit(await this.terminals.capture(terminalId));
    if (entry.exit !== null) return;
    entry.stopRequestedAt = this.now();
    this.terminals.interrupt(terminalId);
  }

  async forceKill(terminalId: string): Promise<void> {
    await this.close(terminalId);
  }

  private async close(terminalId: string): Promise<void> {
    this.tracked.delete(terminalId);
    await this.terminals.kill(terminalId);
  }

  private entry(workspaceId: string, terminalId: string): TrackedTerminal {
    const existing = this.tracked.get(terminalId);
    if (existing !== undefined) return existing;
    const created: TrackedTerminal = { workspaceId, stopRequestedAt: null, exit: null };
    this.tracked.set(terminalId, created);
    return created;
  }

  private forgetClosed(workspaceId: string, open: TerminalRecord[]): void {
    const openIds = new Set(open.map((terminal) => terminal.id));
    for (const [id, entry] of this.tracked) {
      if (entry.workspaceId === workspaceId && !openIds.has(id)) this.tracked.delete(id);
    }
  }

  private async readState(workspaceId: string, terminal: TerminalRecord): Promise<RunState | null> {
    const entry = this.entry(workspaceId, terminal.id);
    let lines: string[] = [];
    if (entry.exit === null) {
      try {
        lines = await this.terminals.capture(terminal.id);
      } catch {
        this.tracked.delete(terminal.id);
        return null;
      }
      entry.exit = readTaskExit(lines);
    }
    const base = { taskId: terminal.name, terminalId: terminal.id };
    if (entry.exit !== null) {
      return { ...base, ...finishedStatus(entry.exit.exitCode, entry.stopRequestedAt), canForceKill: false, output: presentableOutput(entry.exit.output, OUTPUT_LINES) };
    }
    const canForceKill = entry.stopRequestedAt !== null && this.now() - entry.stopRequestedAt >= FORCE_KILL_AFTER_MS;
    return { ...base, status: entry.stopRequestedAt === null ? "running" : "stopping", exitCode: null, canForceKill, output: presentableOutput(lines, OUTPUT_LINES) };
  }
}

function finishedStatus(exitCode: number, stopRequestedAt: number | null): Pick<RunState, "status" | "exitCode"> {
  // Exit codes alone cannot tell: an interrupted bash exits 1 and a graceful server exits 0.
  if (stopRequestedAt !== null || exitCode === INTERRUPTED_EXIT_CODE) return { status: "stopped", exitCode };
  return { status: exitCode === 0 ? "succeeded" : "failed", exitCode };
}
