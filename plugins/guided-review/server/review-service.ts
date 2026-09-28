import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { PanelView, ReviewHeader, StartPhase, StartProgress, StartResult } from "../shared/contracts.ts";
import type { ChangeRequest, ChangeRequestRef, Forge } from "./forge/port.ts";
import { ReviewStore, reviewIdOf, type ReviewRecord } from "./review-store.ts";
import type { ReviewWorkspace, WorkspacePort } from "./workspaces/port.ts";

export type ReviewServiceOptions = {
  /** Every forge a URL may belong to; the first to claim it reads it. */
  forges: readonly Forge[];
  workspaces: WorkspacePort;
  /** Where reviews and the clones this plugin makes are kept. */
  dataDirectory: string;
  now?: () => Date;
  log?: (message: string) => void;
};

/** Paseo cuts a workspace title off well before this; a PR title can be anything. */
const MAX_WORKSPACE_TITLE = 120;

type Job = { progress: StartProgress; done: Promise<void> };

/**
 * The plugin's top level: every RPC the panel and the start surface call is a method here, and it
 * reaches the outside world only through the ports it is given, which is what the tests replace.
 *
 * Anything that can outlast Paseo's 30-second RPC limit — reading a large PR, cloning, creating a
 * worktree — runs as a background job the caller follows by ID.
 */
export class ReviewService {
  readonly #forges: readonly Forge[];
  readonly #workspaces: WorkspacePort;
  readonly #store: ReviewStore;
  readonly #clones: string;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  readonly #jobs = new Map<string, Job>();

  constructor(options: ReviewServiceOptions) {
    this.#forges = options.forges;
    this.#workspaces = options.workspaces;
    this.#store = new ReviewStore(options.dataDirectory);
    this.#clones = path.join(options.dataDirectory, "clones");
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => {});
  }

  /**
   * Starts a review of the change request `url` names: reads it, then gives it a workspace — the one
   * it already has if that is still open, a new PR workspace otherwise.
   */
  async start({ url }: { url: string }): Promise<StartResult> {
    const match = await this.#match(url);
    if (match === null) {
      const hints = this.#forges.map((forge) => forge.urlHint).join(", or ");
      return { status: "rejected", message: `That is not ${hints}.` };
    }

    const { forge, ref } = match;
    const id = reviewIdOf(ref);
    const running = this.#jobs.get(id);
    if (running && !isFinished(running.progress.phase)) return { status: "started", reviewId: id };

    const job: Job = { progress: progress("reading"), done: Promise.resolve() };
    this.#jobs.set(id, job);
    job.done = this.#prepare(id, forge, ref, job).catch((error: unknown) => {
      const message = errorMessage(error);
      this.#log(`Starting a review of ${ref.url} failed: ${message}`);
      job.progress = { ...job.progress, phase: "failed", message };
    });
    return { status: "started", reviewId: id };
  }

  async progress({ reviewId }: { reviewId: string }): Promise<StartProgress> {
    const job = this.#jobs.get(reviewId);
    if (job) return job.progress;
    const record = await this.#store.get(reviewId);
    if (record === null) return progress("unknown");
    return { ...progress("ready"), header: record.header, workspaceId: record.workspace.id };
  }

  async panel({ workspaceId }: { workspaceId: string }): Promise<PanelView> {
    const record = await this.#store.findByWorkspace(workspaceId);
    if (record === null) return { status: "none" };
    return { status: "ready", reviewId: record.id, header: record.header };
  }

  /** Resolves once no background job is running. */
  async settled(): Promise<void> {
    await Promise.all([...this.#jobs.values()].map((job) => job.done));
  }

  async #match(url: string): Promise<{ forge: Forge; ref: ChangeRequestRef } | null> {
    for (const forge of this.#forges) {
      const ref = await forge.matchUrl(url);
      if (ref !== null) return { forge, ref };
    }
    return null;
  }

  async #prepare(id: string, forge: Forge, ref: ChangeRequestRef, job: Job): Promise<void> {
    const [changeRequest, viewer] = await failingAs(`Could not read ${ref.url}`, () =>
      Promise.all([forge.fetchChangeRequest(ref), forge.currentUser(ref)]),
    );
    const header = headerOf(changeRequest);
    job.progress = { ...job.progress, header };

    const workspace = (await this.#reusableWorkspace(id)) ?? (await this.#createWorkspace(forge, changeRequest, job));

    const record: ReviewRecord = { id, ref, workspace, header, viewer, updatedAt: this.#now().toISOString() };
    await this.#store.save(record, changeRequest);
    job.progress = { ...job.progress, phase: "ready", workspaceId: workspace.id };
  }

  /** The workspace this review already has, while it is open: a second one would be a second worktree. */
  async #reusableWorkspace(id: string): Promise<ReviewWorkspace | null> {
    const record = await this.#store.get(id);
    if (record === null) return null;
    return (await this.#workspaces.isActive(record.workspace.id)) ? record.workspace : null;
  }

  async #createWorkspace(forge: Forge, changeRequest: ChangeRequest, job: Job): Promise<ReviewWorkspace> {
    const { ref } = changeRequest;
    const repositoryRoot =
      (await this.#workspaces.findRepository({ host: ref.host, project: ref.project })) ??
      (await this.#clone(forge, ref, job));

    job.progress = { ...job.progress, phase: "creating-workspace" };
    return failingAs(`Could not create a workspace for ${ref.url}`, () =>
      this.#workspaces.createChangeRequestWorkspace({
        repositoryRoot,
        ref,
        title: workspaceTitle(changeRequest),
      }),
    );
  }

  /**
   * A PR workspace is a worktree of a local clone, so a repository no Paseo project has is cloned
   * here, once, and reused for every later review of it.
   */
  async #clone(forge: Forge, ref: ChangeRequestRef, job: Job): Promise<string> {
    const directory = path.join(this.#clones, ...reviewIdOf(ref).split("/").slice(1, -1));
    if (await exists(path.join(directory, ".git"))) return directory;

    job.progress = { ...job.progress, phase: "cloning" };
    // Whatever is there is a clone that did not finish, and the forge will not clone over it.
    await rm(directory, { recursive: true, force: true });
    await mkdir(path.dirname(directory), { recursive: true });
    await failingAs(`Could not clone ${ref.project}`, () => forge.cloneRepository(ref, directory));
    return directory;
  }
}

function progress(phase: StartPhase): StartProgress {
  return { phase, header: null, workspaceId: null, message: null };
}

function isFinished(phase: StartPhase): boolean {
  return phase === "ready" || phase === "failed" || phase === "unknown";
}

export function headerOf(changeRequest: ChangeRequest): ReviewHeader {
  return {
    forge: changeRequest.ref.forge,
    url: changeRequest.ref.url,
    project: changeRequest.ref.project,
    number: changeRequest.ref.number,
    title: changeRequest.title,
    author: changeRequest.author.login,
    state: changeRequest.state,
    isDraft: changeRequest.isDraft,
    fileCount: changeRequest.files.length,
    additions: changeRequest.additions,
    deletions: changeRequest.deletions,
    headSha: changeRequest.headSha,
  };
}

function workspaceTitle(changeRequest: ChangeRequest): string {
  const title = `Review #${changeRequest.ref.number}: ${changeRequest.title}`;
  return title.length <= MAX_WORKSPACE_TITLE ? title : `${title.slice(0, MAX_WORKSPACE_TITLE - 1)}…`;
}

async function failingAs<T>(context: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${context}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
