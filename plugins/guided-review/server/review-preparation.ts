import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ReviewHeader, StartPhase, StartProgress } from "../shared/contracts.ts";
import type { ForeignWork } from "../shared/foreign-work.ts";
import { numberLabel } from "../shared/reference.ts";
import { errorMessage } from "./error-message.ts";
import { foreignWorkOf } from "./foreign-work.ts";
import type { ChangeRequest, ChangeRequestRef, Forge } from "./forge/port.ts";
import type { GuideGenerations } from "./guide-generation.ts";
import { oneAtATimePer } from "./one-at-a-time.ts";
import { reviewIdOf, type ReviewRecord, type ReviewStore } from "./review-store.ts";
import type { FastForwardResult, ReviewWorkspace, WorkspacePort } from "./workspaces/port.ts";

/**
 * What a review's job is for: a `start` reads the change request and keeps the guide the review has
 * when only the head moved; a `regenerate` moves the review to the head the forge has now.
 */
export type PrepareMode = "start" | "regenerate";

/** `note` says why the reviewer's own branch was left alone, once it has been. */
type Job = { progress: StartProgress; note: string | null; done: Promise<void> };

export type ReviewPreparationOptions = {
  store: ReviewStore;
  workspaces: WorkspacePort;
  guides: GuideGenerations;
  /** Where the repositories no Paseo project has are cloned. */
  clones: string;
  now: () => Date;
  log: (message: string) => void;
};

/** Paseo cuts a workspace title off well before this; a PR title can be anything. */
const MAX_WORKSPACE_TITLE = 120;

/**
 * Workspace preparation: the background job behind a start and a Regenerate, which reads the change
 * request and gives the review the workspace its guide is read in, the reviewer's own branch
 * fast-forwarded, the PR workspace it has, or a new one cut from a local clone, cloned first when no
 * Paseo project has the repository. Then it records the review and has its guide generated.
 */
export class ReviewPreparation {
  readonly #store: ReviewStore;
  readonly #workspaces: WorkspacePort;
  readonly #guides: GuideGenerations;
  readonly #clones: string;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  readonly #jobs = new Map<string, Job>();
  /** Workspaces are cut one repository at a time, since two starts would otherwise both find no clone and clone over each other. */
  readonly #perRepository = oneAtATimePer<string>();

  constructor(options: ReviewPreparationOptions) {
    this.#store = options.store;
    this.#workspaces = options.workspaces;
    this.#guides = options.guides;
    this.#clones = options.clones;
    this.#now = options.now;
    this.#log = options.log;
  }

  /** Where the review's job has got to, while this process has one for it. */
  progressOf(reviewId: string): StartProgress | undefined {
    return this.#jobs.get(reviewId)?.progress;
  }

  /** Why the review's job left the reviewer's own branch alone, if it did. */
  noteOf(reviewId: string): string | null | undefined {
    return this.#jobs.get(reviewId)?.note;
  }

  /** What every job, finished or not, settles on. */
  pending(): Promise<void>[] {
    return [...this.#jobs.values()].map((job) => job.done);
  }

  /**
   * Starts reading the change request and giving it a workspace as a background job, and returns the
   * review's ID; a job already running for it is the one followed. `own` is the reviewer's workspace
   * on the change request's branch, to fast-forward and attach to rather than make a PR workspace.
   * A `start` keeps a guide the review already has when the head has moved; a `regenerate` does not.
   */
  begin(forge: Forge, ref: ChangeRequestRef, own: ReviewWorkspace | null, mode: PrepareMode = "start"): string {
    const id = reviewIdOf(ref);
    const running = this.#jobs.get(id);
    if (running && !isFinished(running.progress.phase)) return id;

    const job: Job = { progress: startProgressAt("reading"), note: null, done: Promise.resolve() };
    this.#jobs.set(id, job);
    job.done = this.#prepare(id, forge, ref, job, own, mode).catch((error: unknown) => {
      const message = errorMessage(error);
      this.#log(`Starting a review of ${ref.url} failed: ${message}`);
      job.progress = { ...job.progress, phase: "failed", message };
    });
    return id;
  }

  async #prepare(id: string, forge: Forge, ref: ChangeRequestRef, job: Job, own: ReviewWorkspace | null, mode: PrepareMode): Promise<void> {
    const [changeRequest, viewer] = await failingAs(`Could not read ${ref.url}`, () =>
      Promise.all([forge.fetchChangeRequest(ref), forge.currentUser(ref)]),
    );
    const header = headerOf(changeRequest);
    job.progress = { ...job.progress, header };

    const previous = await this.#store.get(id);
    const headMoved = previous !== null && previous.header.headSha !== changeRequest.headSha;
    if (mode === "start" && headMoved && (await this.#keepsGuide(previous, own))) {
      // Nothing regenerates on its own: the guide stays at its head, and its workspace where it is,
      // until the reviewer asks for the new head from the panel's banner. What does not belong to
      // one head, like the title and whether it is still open, follows the forge.
      const record: ReviewRecord = {
        ...previous,
        header: { ...previous.header, title: header.title, state: header.state, isDraft: header.isDraft },
        viewer,
        updatedAt: this.#now().toISOString(),
      };
      await this.#store.update(record);
      await this.#ready(job, record);
      return;
    }

    // Read beside the workspace's preparation, which it does not depend on.
    const foreign = this.#foreignWork(forge, changeRequest);
    const workspace = await this.#workspaceFor(id, forge, changeRequest, job, own, headMoved);
    if (previous !== null && previous.workspace.id !== workspace.id) {
      // The `workspace.archived` hook is not replayed after a restart, so an old workspace's agents are ended here too.
      await this.#guides.endAll(previous.id, previous.workspace.id);
    } else if (previous !== null && headMoved) {
      // The panel shows the guide at the new head from now on, so the one it replaces ends with it.
      await this.#guides.endAt(previous.id, previous.header.headSha, workspace.id);
    }

    const previousHeadSha = headMoved ? previous.header.headSha : previous?.previousHeadSha;
    const foreignWork = await foreign;
    const record: ReviewRecord = {
      id,
      ref,
      workspace,
      header,
      viewer,
      updatedAt: this.#now().toISOString(),
      ...(job.note === null ? {} : { note: job.note }),
      ...(previousHeadSha === undefined ? {} : { previousHeadSha }),
      ...(foreignWork === null ? {} : { foreign: foreignWork }),
    };
    await this.#store.save(record, changeRequest);
    await this.#ready(job, record);
  }

  /**
   * The other change requests' work `changeRequest` carries, or null when it carries none. Failing
   * to read it is logged and reads as none, since the review does not need it; it never rejects, as
   * it is awaited only once the workspace is ready, which may fail first.
   */
  async #foreignWork(forge: Forge, changeRequest: ChangeRequest): Promise<ForeignWork | null> {
    try {
      const belongsTo = await forge.commitChangeRequests(changeRequest.ref, changeRequest.commits.map((commit) => commit.sha));
      return foreignWorkOf(changeRequest, belongsTo);
    } catch (error) {
      this.#log(`Could not read which change requests the commits of ${changeRequest.ref.url} belong to: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Ready only once the guide is asked for, so nothing following the job reads a ready review as having none. */
  async #ready(job: Job, record: ReviewRecord): Promise<void> {
    await this.#guides.state(record);
    job.progress = { ...job.progress, header: record.header, phase: "ready", workspaceId: record.workspace.id };
  }

  /**
   * Whether a start with the head moved leaves the review as it is: its workspace is still open and
   * is the one asked for, and it has a guide there that is written or being written. A failed guide
   * holds nothing to keep, so a start moves on to the new head instead of offering a retry at the old.
   */
  async #keepsGuide(previous: ReviewRecord, own: ReviewWorkspace | null): Promise<boolean> {
    if (own !== null && own.id !== previous.workspace.id) return false;
    if (!(await this.#workspaces.isActive(previous.workspace.id))) return false;
    if (this.#guides.running(previous)) return true;
    const stored = await this.#store.getGuide(previous.id, previous.header.headSha);
    return stored !== null && stored.workspaceId === previous.workspace.id && stored.status !== "failed";
  }

  /**
   * The workspace the review is read in. The reviewer's own workspace on the change request's branch
   * (`own`, or the one the review was attached to before) when its branch is at the head or can be
   * fast-forwarded to it; otherwise the PR workspace the review already has, or a new one, with the
   * reason the branch was left alone kept in `job.note`. When the head has moved, a PR workspace is
   * brought to it the same way, so the guide agent reads the code the guide is for; one that cannot
   * be is left as it is for a new one.
   */
  async #workspaceFor(
    id: string,
    forge: Forge,
    changeRequest: ChangeRequest,
    job: Job,
    own: ReviewWorkspace | null,
    headMoved: boolean,
  ): Promise<ReviewWorkspace> {
    const previous = await this.#reusableWorkspace(id);
    const local = own ?? (previous?.branch === undefined ? null : previous);
    if (local?.branch !== undefined) {
      job.progress = { ...job.progress, phase: "updating-branch" };
      const outcome =
        changeRequest.headBranch === local.branch
          ? await this.#workspaces.fastForward({ workspace: local, branch: local.branch, ref: changeRequest.ref, headSha: changeRequest.headSha })
          : null;
      if (outcome?.status === "current" || outcome?.status === "fast-forwarded") return local;
      job.note = leftAlone(local.branch, changeRequest, outcome);
      if (outcome?.status === "failed") this.#log(`Fast-forwarding ${local.directory} failed: ${outcome.message}`);
    }
    const reusable = previous?.branch === undefined ? previous : null;
    if (reusable !== null && (!headMoved || (await this.#bringToHead(reusable, changeRequest, job)))) return reusable;
    return this.#createWorkspace(forge, changeRequest, job);
  }

  /**
   * Fast-forwards a PR workspace's branch to the change request's new head, through the same clean
   * fast-forward as the reviewer's own branch. False, with the reason in `job.note`, when it cannot be:
   * a force-push leaves it diverged, and anything written in it leaves it dirty.
   */
  async #bringToHead(workspace: ReviewWorkspace, changeRequest: ChangeRequest, job: Job): Promise<boolean> {
    job.progress = { ...job.progress, phase: "updating-branch" };
    const checkout = await this.#workspaces.inspect(workspace.id);
    const outcome =
      checkout?.branch == null
        ? null
        : await this.#workspaces.fastForward({ workspace, branch: checkout.branch, ref: changeRequest.ref, headSha: changeRequest.headSha });
    if (outcome?.status === "current" || outcome?.status === "fast-forwarded") return true;
    job.note = prWorkspaceLeftAlone(changeRequest, outcome);
    if (outcome?.status === "failed") this.#log(`Fast-forwarding ${workspace.directory} failed: ${outcome.message}`);
    return false;
  }

  /** The workspace this review already has, while it is open: a second one would be a second worktree. */
  async #reusableWorkspace(id: string): Promise<ReviewWorkspace | null> {
    const record = await this.#store.get(id);
    if (record === null) return null;
    return (await this.#workspaces.isActive(record.workspace.id)) ? record.workspace : null;
  }

  async #createWorkspace(forge: Forge, changeRequest: ChangeRequest, job: Job): Promise<ReviewWorkspace> {
    const { ref } = changeRequest;
    job.progress = { ...job.progress, phase: "creating-workspace" };
    return this.#perRepository(`${ref.host}/${ref.project}`.toLowerCase(), async () => {
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
    });
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

/** A start's progress at `phase`, before anything about the change request is known. */
export function startProgressAt(phase: StartPhase): StartProgress {
  return { phase, header: null, workspaceId: null, message: null };
}

export function isFinished(phase: StartPhase): boolean {
  return phase === "ready" || phase === "failed" || phase === "unknown";
}

/**
 * Why the reviewer's branch was not used, in the one line the panel shows. `outcome` is null when the
 * change request does not come from that branch after all.
 */
function leftAlone(branch: string, changeRequest: ChangeRequest, outcome: FastForwardResult | null): string {
  const label = numberLabel(changeRequest.ref.forge, changeRequest.ref.number);
  const instead = "so it was left untouched and the guide is in a PR workspace instead.";
  switch (outcome?.status) {
    case undefined:
      return `${label} comes from ${changeRequest.headBranch}, not ${branch}, ${instead}`;
    case "dirty":
      return `${branch} has uncommitted changes, ${instead}`;
    case "diverged":
      return `${branch} has commits that are not in ${label}, ${instead}`;
    case "moved":
      return `The workspace is no longer on ${branch}, ${instead}`;
    case "failed":
      return `${branch} could not be fast-forwarded to ${label} (${outcome.message}), ${instead}`;
    case "current":
    case "fast-forwarded":
      throw new Error(`A ${outcome.status} branch is not left alone.`);
  }
}

/**
 * Why the review's PR workspace was not brought to the new head, in the one line the panel shows.
 * `outcome` is null when the workspace is on no branch at all.
 */
function prWorkspaceLeftAlone(changeRequest: ChangeRequest, outcome: FastForwardResult | null): string {
  const label = numberLabel(changeRequest.ref.forge, changeRequest.ref.number);
  const instead = "so it was left untouched and the guide is in a new PR workspace.";
  switch (outcome?.status) {
    case undefined:
    case "moved":
      return `The previous PR workspace is no longer on the branch it was made with, ${instead}`;
    case "dirty":
      return `The previous PR workspace has uncommitted changes, ${instead}`;
    case "diverged":
      return `The previous PR workspace has commits that are not in ${label} any more, ${instead}`;
    case "failed":
      return `The previous PR workspace could not be fast-forwarded to ${label} (${outcome.message}), ${instead}`;
    case "current":
    case "fast-forwarded":
      throw new Error(`A ${outcome.status} workspace is not left alone.`);
  }
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
  const title = `Review ${numberLabel(changeRequest.ref.forge, changeRequest.ref.number)}: ${changeRequest.title}`;
  return title.length <= MAX_WORKSPACE_TITLE ? title : `${title.slice(0, MAX_WORKSPACE_TITLE - 1)}…`;
}

async function failingAs<T>(context: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${context}: ${errorMessage(error)}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
