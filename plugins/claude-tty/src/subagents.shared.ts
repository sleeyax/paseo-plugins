/**
 * What the panel can know about the subagents a session is running. Claude records a subagent's
 * work in a transcript of its own, and says only in the session's transcript that it was launched
 * and — for one launched asynchronously — that it has stopped, so both files are read.
 */

const AGENT_FILE_PREFIX = "agent-";
const AGENT_FILE_SUFFIX = ".jsonl";
const AGENT_META_SUFFIX = ".meta.json";
const STEP_CHARS = 200;

export type SubagentStatus = "running" | "completed" | "failed" | "unknown";

/** A subagent as the session's own transcript describes it. */
export type SubagentLaunch = { agentId: string; description: string | null; running: boolean };

/** The end of an asynchronous subagent, which is reported nowhere else. */
export type SubagentOutcome = { agentId: string; status: SubagentStatus; summary: string | null };

/** A subagent's transcript on disk, which is the only record of one whose launch is long compacted away. */
export type SubagentFile = {
  agentId: string;
  lastActivity: number;
  /** What the sidecar Claude writes beside the transcript says, where there is one. */
  meta: SubagentMeta | null;
  /** The opening line of its prompt, read only when nothing better names it. */
  prompt: string | null;
};

/** The sidecar Claude writes when it spawns a subagent, which names it without reading anything else. */
export type SubagentMeta = { description: string | null; nested: boolean };

export type Subagent = {
  agentId: string;
  description: string | null;
  status: SubagentStatus;
  summary: string | null;
  /** Launched by another subagent rather than by the session, which is why it has no card of its own. */
  nested: boolean;
  lastActivity: number | null;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long ago a subagent last wrote anything, which is the only sign of life its file gives. */
export function lastStepLabel(lastActivity: number | null, now: number): string | null {
  if (lastActivity === null || !Number.isFinite(lastActivity)) return null;
  const elapsed = now - lastActivity;
  if (elapsed < MINUTE_MS) return "last step just now";
  if (elapsed < HOUR_MS) return `last step ${count(elapsed / MINUTE_MS, "minute")} ago`;
  return `last step ${count(elapsed / HOUR_MS, "hour")} ago`;
}

function count(units: number, unit: string): string {
  const whole = Math.floor(units);
  return `${whole} ${unit}${whole === 1 ? "" : "s"}`;
}

export function agentIdFromFileName(name: string): string | null {
  if (!name.startsWith(AGENT_FILE_PREFIX) || !name.endsWith(AGENT_FILE_SUFFIX)) return null;
  const agentId = name.slice(AGENT_FILE_PREFIX.length, -AGENT_FILE_SUFFIX.length);
  return agentId === "" ? null : agentId;
}

export function subagentFileName(agentId: string): string {
  return `${AGENT_FILE_PREFIX}${agentId}${AGENT_FILE_SUFFIX}`;
}

export function subagentMetaFileName(agentId: string): string {
  return `${AGENT_FILE_PREFIX}${agentId}${AGENT_META_SUFFIX}`;
}

/** Older versions of Claude wrote no sidecar, so an unreadable one is a name to find elsewhere. */
export function parseMeta(contents: string | null): SubagentMeta | null {
  if (contents === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  return {
    description: typeof record.description === "string" && record.description !== "" ? record.description : null,
    nested: typeof record.spawnDepth === "number" && record.spawnDepth > 1,
  };
}

export function parseRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // A half-written final line is the normal state of a transcript being appended to.
    }
  }
  return records;
}

/** Claude names the launched agent in the metadata it keeps beside the tool result. */
export function readLaunches(records: readonly Record<string, unknown>[]): SubagentLaunch[] {
  const launches: SubagentLaunch[] = [];
  for (const record of records) {
    const result = asRecord(record.toolUseResult);
    const agentId = result?.agentId;
    if (typeof agentId !== "string" || agentId === "") continue;
    launches.push({
      agentId,
      description: typeof result?.description === "string" ? result.description : null,
      running: result?.status === "async_launched",
    });
  }
  return launches;
}

export function readOutcomes(records: readonly Record<string, unknown>[]): SubagentOutcome[] {
  const outcomes: SubagentOutcome[] = [];
  for (const record of records) {
    for (const text of notificationTexts(record)) {
      for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const body = match[1] ?? "";
        const agentId = tag(body, "task-id");
        if (agentId === null) continue;
        const status = tag(body, "status");
        outcomes.push({ agentId, status: status === "completed" ? "completed" : "failed", summary: tag(body, "summary") });
      }
    }
  }
  return outcomes;
}

/**
 * A subagent is listed because its transcript exists, so one whose launch was compacted out of the
 * session's transcript — or one launched by another subagent, which the session never records — is
 * still shown, named after its sidecar or its own opening prompt rather than dropped.
 */
export function joinSubagents(
  files: readonly SubagentFile[],
  launches: ReadonlyMap<string, SubagentLaunch>,
  outcomes: ReadonlyMap<string, SubagentOutcome>,
): Subagent[] {
  return files
    .map((file) => {
      const launch = launches.get(file.agentId) ?? null;
      const outcome = outcomes.get(file.agentId) ?? null;
      return {
        agentId: file.agentId,
        description: file.meta?.description ?? launch?.description ?? file.prompt,
        status: subagentStatus(launch, outcome),
        summary: outcome?.summary ?? null,
        nested: file.meta?.nested ?? false,
        lastActivity: file.lastActivity,
      };
    })
    .sort(byRunningThenRecency);
}

function subagentStatus(launch: SubagentLaunch | null, outcome: SubagentOutcome | null): SubagentStatus {
  if (outcome !== null) return outcome.status;
  if (launch === null) return "unknown";
  // A subagent that was not launched asynchronously has already answered its launcher by now.
  return launch.running ? "running" : "completed";
}

function byRunningThenRecency(a: Subagent, b: Subagent): number {
  if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
  if (a.lastActivity !== b.lastActivity) return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
  return a.agentId.localeCompare(b.agentId);
}

/**
 * One thing a subagent did: something it said, or a tool it called. Kept apart rather than rendered
 * into a line, because a panel with room for two lines can say what a tool call was handed and how
 * it came back, and a step nobody can read is not worth listing.
 */
export type SubagentStep = {
  kind: "text" | "tool";
  /** When it happened, so a run that took minutes reads as one. */
  at: number | null;
  /** What the subagent said, or the name of the tool it called. */
  title: string;
  /** What the tool was asked to do, in the subagent's own words. */
  detail: string | null;
  /** The argument worth reading as it was written: a command, a path, a pattern. */
  body: string | null;
  failed: boolean;
  /** What came back, when what came back was a failure. */
  error: string | null;
};

const TEXT_CHARS = 1_200;
const BODY_CHARS = 400;
const ERROR_CHARS = 200;

/** The verbatim argument, in the order that says most about what the call was for. */
const BODY_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "query", "url"] as const;

/**
 * What a subagent did, read out of its own transcript as that transcript is written. A running
 * agent's file is re-read every few seconds and grows for as long as it runs, so records are handed
 * over as they arrive and only the tail the panel shows is kept; the rest are counted and dropped.
 *
 * Results are read as well: a tool that failed is most of what is worth knowing about a run that
 * went wrong, and the transcript is the only place it is written down.
 */
export class SubagentSteps {
  private readonly limit: number;
  private readonly kept: SubagentStep[] = [];
  /** The tool use each kept step came from, so a result landing in a later read can find its step. */
  private readonly keptIds: (string | null)[] = [];
  private readonly byToolUse = new Map<string, SubagentStep>();
  private dropped = 0;
  private first: number | null = null;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** When the subagent started, which is the first thing it wrote and outlives every step. */
  get startedAt(): number | null {
    return this.first;
  }

  get steps(): SubagentStep[] {
    return [...this.kept];
  }

  /** The steps taken before those, which the panel says the number of rather than shows. */
  get earlier(): number {
    return this.dropped;
  }

  append(records: readonly Record<string, unknown>[]): void {
    for (const record of records) {
      const at = timestampOf(record);
      if (this.first === null) this.first = at;
      const content = asRecord(record.message)?.content;
      if (!Array.isArray(content)) continue;
      for (const value of content) {
        const block = asRecord(value);
        if (!block) continue;
        if (record.type === "assistant" && block.type === "text" && typeof block.text === "string") {
          const text = truncate(block.text.trim(), TEXT_CHARS);
          if (text !== "") this.push({ kind: "text", at, title: text, detail: null, body: null, failed: false, error: null }, null);
        }
        if (record.type === "assistant" && block.type === "tool_use") {
          this.push(toolStep(block, at), typeof block.id === "string" ? block.id : null);
        }
        if (block.type === "tool_result" && block.is_error === true) {
          const step = typeof block.tool_use_id === "string" ? this.byToolUse.get(block.tool_use_id) : undefined;
          if (step) {
            step.failed = true;
            step.error = firstLine(block.content);
          }
        }
      }
    }
  }

  /** A step that falls out of the tail takes its tool use with it, so neither map outgrows the tail. */
  private push(step: SubagentStep, id: string | null): void {
    this.kept.push(step);
    this.keptIds.push(id);
    if (id !== null) this.byToolUse.set(id, step);
    while (this.kept.length > this.limit) {
      this.kept.shift();
      const forgotten = this.keptIds.shift();
      if (forgotten !== undefined && forgotten !== null) this.byToolUse.delete(forgotten);
      this.dropped += 1;
    }
  }
}

function toolStep(block: Record<string, unknown>, at: number | null): SubagentStep {
  const input = asRecord(block.input) ?? {};
  const body = BODY_KEYS.map((key) => input[key]).find((value): value is string => typeof value === "string" && value !== "");
  return {
    kind: "tool",
    at,
    title: typeof block.name === "string" && block.name !== "" ? block.name : "Tool",
    detail: typeof input.description === "string" && input.description !== "" ? oneLine(input.description) : null,
    body: body === undefined ? null : truncate(body.trim(), BODY_CHARS),
    failed: false,
    error: null,
  };
}

/** Claude puts the reason a tool failed at the top of what it hands back. */
function firstLine(content: unknown): string | null {
  const blocks = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
  for (const value of blocks) {
    const text = typeof value === "string" ? value : asRecord(value)?.type === "text" ? asRecord(value)?.text : null;
    const line = typeof text === "string" ? text.split("\n").find((candidate) => candidate.trim() !== "") : undefined;
    if (line !== undefined) return truncate(line.trim(), ERROR_CHARS);
  }
  return null;
}

function timestampOf(record: Record<string, unknown>): number | null {
  const parsed = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The prompt a subagent was given, which names it when nothing else does. */
export function promptOf(records: readonly Record<string, unknown>[]): string | null {
  for (const record of records) {
    if (record.type !== "user") continue;
    for (const text of messageTexts(record)) {
      const line = oneLine(text);
      if (line !== "") return line;
    }
  }
  return null;
}

/**
 * Where an agent's outcome can be written. A notification for one that finished while Claude was
 * busy is queued rather than delivered as a turn, and the queued command is the only record it
 * leaves — read the message alone and the panel shows the agent running for good.
 */
function notificationTexts(record: Record<string, unknown>): string[] {
  const queued = asRecord(record.attachment);
  const prompt = queued?.type === "queued_command" && typeof queued.prompt === "string" ? [queued.prompt] : [];
  return [...messageTexts(record), ...prompt];
}

function messageTexts(record: Record<string, unknown>): string[] {
  const content = asRecord(record.message)?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = asRecord(value);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > STEP_CHARS ? `${collapsed.slice(0, STEP_CHARS - 1)}…` : collapsed;
}

function tag(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
