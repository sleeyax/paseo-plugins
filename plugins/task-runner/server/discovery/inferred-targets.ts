import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isJsonObject, readJsonObject } from "./files.ts";
import type { NxProject } from "./source.ts";

const execFileAsync = promisify(execFile);

/** Paseo cuts an RPC off at 30 seconds, so a scan waits less than that for a cold Nx. */
const DEFAULT_WAIT_MS = 15_000;
const NX_TIMEOUT_MS = 180_000;

export type InferredRead = { state: "ready"; projects: NxProject[] } | { state: "loading" } | { state: "failed"; reason: string };

type Finished = Exclude<InferredRead, { state: "loading" }>;

function failureReason(error: unknown): string {
  const failure = error as { code?: unknown; stderr?: unknown; killed?: unknown; message?: unknown };
  if (failure.code === "ENOENT") return "nx is not installed here, so node_modules may be missing.";
  if (failure.killed === true) return "nx took too long.";
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  if (stderr !== "") return stderr.split("\n").slice(-3).join("\n");
  return typeof failure.message === "string" ? failure.message : "nx failed.";
}

function projectsFromGraph(graph: unknown, root: string): NxProject[] {
  const nodes = isJsonObject(graph) && isJsonObject(graph.graph) ? graph.graph.nodes : null;
  if (!isJsonObject(nodes)) throw new Error("nx did not write a project graph.");
  return Object.entries(nodes).flatMap(([name, node]) => {
    const data = isJsonObject(node) ? node.data : null;
    if (!isJsonObject(data) || typeof data.root !== "string") return [];
    return [{ name, directory: resolve(root, data.root), targets: isJsonObject(data.targets) ? Object.keys(data.targets) : [] }];
  });
}

async function loadGraph(root: string): Promise<Finished> {
  const scratch = await mkdtemp(join(tmpdir(), "task-runner-nx-"));
  try {
    const file = join(scratch, "graph.json");
    await execFileAsync(join(root, "node_modules", ".bin", "nx"), ["graph", `--file=${file}`], {
      cwd: root,
      timeout: NX_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // No Nx daemon, which would outlive the one read it was started for.
      env: { ...process.env, NX_DAEMON: "false", PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
    });
    return { state: "ready", projects: projectsFromGraph(await readJsonObject(file), root) };
  } catch (error) {
    return { state: "failed", reason: failureReason(error) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Hands each run's result to one scan, so a rescan runs the repo's nx afresh. */
export class InferredTargets {
  private readonly jobs = new Map<string, Promise<Finished>>();
  private readonly waitMs: number;

  constructor(options: { waitMs?: number } = {}) {
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  }

  async read(root: string): Promise<InferredRead> {
    const job = this.jobs.get(root) ?? loadGraph(root);
    this.jobs.set(root, job);

    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), this.waitMs);
    });
    const result = await Promise.race([job, waited]);
    clearTimeout(timer);
    if (result === null) return { state: "loading" };
    this.jobs.delete(root);
    return result;
  }
}
