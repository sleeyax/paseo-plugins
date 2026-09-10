import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SubagentsPayload, SubagentTranscriptPayload } from "../shared/contracts.ts";
import { subagentsDirectory, transcriptPath } from "./paths.ts";
import { isSafeStateFileStem, type SessionEntry } from "../shared/sessions.ts";
import {
  agentIdFromFileName,
  joinSubagents,
  parseMeta,
  parseRecords,
  promptOf,
  readLaunches,
  readOutcomes,
  subagentFileName,
  subagentMetaFileName,
  SubagentSteps,
  type SubagentFile,
  type SubagentLaunch,
  type SubagentMeta,
  type SubagentOutcome,
} from "../shared/subagents.ts";
import { messageOf } from "./checkout.ts";
import { readState } from "./sessions.ts";
import { newScan, readHead, readNewLines, readWhole, type FileScan } from "./transcript-scan.ts";

/** Enough of a subagent's transcript to name it, without reading a prompt that runs to pages. */
const PROMPT_BYTES = 8_192;
/** How many of a subagent's steps the panel is sent; the rest stay on disk and are counted. */
const STEP_LIMIT = 200;

type TranscriptScan = FileScan & {
  launches: Map<string, SubagentLaunch>;
  outcomes: Map<string, SubagentOutcome>;
};

/** A subagent's own transcript, read the same way: a running agent's is polled and only grows. */
type SubagentScan = FileScan & { session: string; steps: SubagentSteps };

/**
 * Module scope is the only state a plugin has between calls, and it lives as long as the plugin
 * process, so everything kept in it is keyed by the session it was read for and dropped with that
 * session. A daemon that has run for weeks would otherwise hold the scan of every session it has
 * ever polled, and every subagent name it has ever shown.
 */
const scans = new Map<string, TranscriptScan>();
/** Neither a subagent's sidecar nor its opening prompt changes, so both are read once. */
const names = new Map<string, { session: string; name: { meta: SubagentMeta | null; prompt: string | null } }>();
const stepScans = new Map<string, SubagentScan>();

/**
 * Only sessions that are open are listed. A subagent lives inside its session's Claude process, so
 * one whose session has been stopped is not running anywhere, whatever its transcript last said.
 */
export async function listSubagents(): Promise<SubagentsPayload> {
  const reading = await readState();
  const sessions: SubagentsPayload["sessions"] = [];
  const live = new Set<string>();
  let problem: string | null = reading.problem;
  for (const session of reading.sessions) {
    if (session.lock?.live !== true || session.cwd === null || session.claudeSessionId === null) continue;
    if (!isSafeStateFileStem(session.claudeSessionId)) {
      problem = problem ?? `${session.id}: ${session.claudeSessionId} is not a Claude session ID whose files can be read.`;
      continue;
    }
    const directory = subagentsDirectory(session.cwd, session.claudeSessionId);
    live.add(directory);
    try {
      sessions.push({
        sessionId: session.id,
        cwd: session.cwd,
        subagents: await sessionSubagents(session.cwd, session.claudeSessionId, directory),
      });
    } catch (error) {
      problem = problem ?? `${session.id}: ${messageOf(error)}`;
    }
  }
  forgetStoppedSessions(live);
  return { now: Date.now(), problem, sessions: sessions.filter((entry) => entry.subagents.length > 0) };
}

/** What was read for a session that is no longer open is never read again, so it is not kept. */
function forgetStoppedSessions(live: ReadonlySet<string>): void {
  for (const key of [...scans.keys()]) if (!live.has(key)) scans.delete(key);
  for (const [key, entry] of [...names]) if (!live.has(entry.session)) names.delete(key);
  for (const [key, entry] of [...stepScans]) if (!live.has(entry.session)) stepScans.delete(key);
}

/**
 * The steps one subagent took. The panel re-asks every few seconds for as long as the agent runs,
 * and the transcript behind the answer only grows, so it is scanned rather than re-read: what is
 * new is parsed onto the tail already held, and the steps that fall off the tail are counted.
 */
export async function readSubagentTranscript(sessionId: string, agentId: string): Promise<SubagentTranscriptPayload> {
  if (!isSafeStateFileStem(sessionId) || !isSafeStateFileStem(agentId)) {
    throw new Error(`${sessionId}/${agentId} is not a subagent of a session on this host.`);
  }
  const session = (await readState()).sessions.find((entry) => entry.id === sessionId);
  const located = subagentPath(session, agentId);
  if (located === null) throw new Error(`Session ${sessionId} is not open, so its subagents cannot be read.`);
  const scan = await scanSubagent(located.file, located.directory);
  return { startedAt: scan.steps.startedAt, steps: scan.steps.steps, earlier: scan.steps.earlier };
}

/** The Claude session ID is guarded like the two the caller named: it is joined into a path too. */
function subagentPath(session: SessionEntry | undefined, agentId: string): { file: string; directory: string } | null {
  if (session === undefined || session.cwd === null || session.claudeSessionId === null) return null;
  if (!isSafeStateFileStem(session.claudeSessionId)) return null;
  const directory = subagentsDirectory(session.cwd, session.claudeSessionId);
  return { file: path.join(directory, subagentFileName(agentId)), directory };
}

async function sessionSubagents(cwd: string, claudeSessionId: string, directory: string) {
  const files = await readSubagentFiles(directory);
  if (files.length === 0) return [];
  const scan = await scanTranscript(transcriptPath(cwd, claudeSessionId), directory);
  return joinSubagents(files, scan.launches, scan.outcomes);
}

async function scanSubagent(file: string, directory: string): Promise<SubagentScan> {
  const scan = stepScans.get(file) ?? { session: directory, ...newScan(), steps: new SubagentSteps(STEP_LIMIT) };
  stepScans.set(file, scan);
  await readNewLines(file, scan, (read) => {
    // Nothing rewrites a subagent's transcript, but one that was would be read twice onto one tail.
    if (read.rewritten) scan.steps = new SubagentSteps(STEP_LIMIT);
    scan.steps.append(parseRecords(read.text));
  });
  return scan;
}

/** A session that has never run a subagent has no directory of them, which is not a problem. */
async function readSubagentFiles(directory: string): Promise<SubagentFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: SubagentFile[] = [];
  for (const name of names) {
    const agentId = agentIdFromFileName(name);
    if (agentId === null) continue;
    const file = path.join(directory, name);
    const stats = await stat(file).catch(() => null);
    if (stats === null) continue;
    files.push({ agentId, lastActivity: stats.mtimeMs, ...(await nameOf(agentId, directory, file)) });
  }
  return files;
}

/**
 * The sidecar names a subagent outright; the prompt is only read when there is no sidecar to read.
 * An agent ID is unique inside one session's directory of them and nowhere else, so that is what
 * this is keyed by — which is also what lets it be dropped when the session is.
 */
async function nameOf(agentId: string, directory: string, file: string): Promise<{ meta: SubagentMeta | null; prompt: string | null }> {
  const key = `${directory}\u0000${agentId}`;
  const cached = names.get(key);
  if (cached !== undefined) return cached.name;
  const meta = parseMeta(await readWhole(path.join(directory, subagentMetaFileName(agentId))));
  const prompt = meta?.description ? null : promptOf(parseRecords(await readHead(file, PROMPT_BYTES)));
  const name = { meta, prompt };
  names.set(key, { session: directory, name });
  return name;
}

/**
 * A compaction rewrites the transcript in place, and what it dropped is still worth having read, so
 * the launches and outcomes already joined stay and only the reading of the file starts over.
 * A session that has never been written to is not a problem, and there is nothing to join yet.
 */
async function scanTranscript(file: string, directory: string): Promise<TranscriptScan> {
  const scan = scans.get(directory) ?? { ...newScan(), launches: new Map(), outcomes: new Map() };
  scans.set(directory, scan);
  await readNewLines(file, scan, (read) => {
    const records = parseRecords(read.text);
    for (const launch of readLaunches(records)) scan.launches.set(launch.agentId, launch);
    for (const outcome of readOutcomes(records)) scan.outcomes.set(outcome.agentId, outcome);
  }).catch((error: unknown) => {
    if (isMissing(error)) return;
    throw error;
  });
  return scan;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
