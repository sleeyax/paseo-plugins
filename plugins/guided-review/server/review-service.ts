import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AskResult, BranchStart, GuideSubject, HeadCheck, NodeDiff, PanelView, ReviewHeader, StartPhase, StartProgress, StartResult } from "../shared/contracts.ts";
import { coveredPaths, GuideSchema, type CoveredCode, type GuideState, type LayeredGuide } from "../shared/guide.ts";
import { summariseProgress, type GuideProgress } from "../shared/progress.ts";
import { numberLabel } from "../shared/reference.ts";
import { askPrompt, codeReferencesOf, type AskSubjectContext } from "./ask-prompt.ts";
import { carryMarks } from "./carry-over.ts";
import { resolveCode } from "./diff.ts";
import { ForgeError, type BranchChangeRequest, type ChangedFile, type ChangeRequest, type ChangeRequestRef, type Forge } from "./forge/port.ts";
import { GUIDE_AGENT_LABEL, GUIDE_HEAD_LABEL, GuideAgentError, type GuideAgentPort } from "./guide-agent/port.ts";
import { jsonSchemaOf, withOutputSchema } from "./guide-agent/structured.ts";
import { setAside } from "./file-classes.ts";
import { layOutGuide, parseGuide } from "./guide-output.ts";
import { guidePrompt } from "./guide-prompt.ts";
import { ReviewStore, reviewIdOf, type GuideRecord, type ProgressRecord, type ReviewRecord } from "./review-store.ts";
import type { FastForwardResult, ReviewWorkspace, WorkspaceCheckout, WorkspacePort } from "./workspaces/port.ts";

export type ReviewServiceOptions = {
  /** Every forge a URL may belong to; the first to claim it reads it. */
  forges: readonly Forge[];
  workspaces: WorkspacePort;
  guideAgents: GuideAgentPort;
  /** Where reviews and the clones this plugin makes are kept. */
  dataDirectory: string;
  now?: () => Date;
  log?: (message: string) => void;
};

/** Paseo cuts a workspace title off well before this; a PR title can be anything. */
const MAX_WORKSPACE_TITLE = 120;

/** `note` says why the reviewer's own branch was left alone, once it has been. */
type Job = { progress: StartProgress; note: string | null; done: Promise<void> };
/** Guiding a workspace's branch, from finding its change request to the review's own job. */
type BranchJob = { state: BranchState; done: Promise<void> };
type BranchState =
  | { status: "finding" }
  | { status: "none" | "failed"; message: string }
  | { status: "choose"; checkout: LocalCheckout; forge: Forge; candidates: BranchChangeRequest[] }
  | { status: "started"; reviewId: string };
/** A workspace on a branch, with the repository its `origin` names. */
type LocalCheckout = WorkspaceCheckout & { branch: string; repository: NonNullable<WorkspaceCheckout["repository"]> };
/**
 * What a review's job is for: a `start` reads the change request and keeps the guide the review has
 * when only the head moved; a `regenerate` moves the review to the head the forge has now.
 */
type PrepareMode = "start" | "regenerate";
/** A guide being generated; `agentId` is set once its agent exists. */
type Generation = { agentId: string | null; done: Promise<void> };

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
  readonly #guideAgents: GuideAgentPort;
  /** Guide generations running, by review and head SHA. */
  readonly #generations = new Map<string, Generation>();
  /** The latest branch guiding asked for in each workspace, by workspace ID. */
  readonly #branchStarts = new Map<string, BranchJob>();
  /** The last write of each guide's marks, by review and head SHA, which the next one waits for. */
  readonly #progressWrites = new Map<string, Promise<unknown>>();

  constructor(options: ReviewServiceOptions) {
    this.#forges = options.forges;
    this.#workspaces = options.workspaces;
    this.#guideAgents = options.guideAgents;
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
    let match: { forge: Forge; ref: ChangeRequestRef } | null;
    try {
      match = await this.#match(url);
    } catch (error) {
      // A URL a forge claims but cannot read from here, like one on a host its CLI is not logged in to.
      if (error instanceof ForgeError) return { status: "rejected", message: error.message };
      throw error;
    }
    if (match === null) {
      const hints = this.#forges.map((forge) => forge.urlHint).join(", or ");
      return { status: "rejected", message: `That is not ${hints}.` };
    }

    return { status: "started", reviewId: this.#begin(match.forge, match.ref, null) };
  }

  /**
   * Guides the open change request the workspace's branch is the source of, in the background: finds
   * it, has the reviewer choose when there are several, then starts its review with the workspace
   * as the one to attach to. `url` is that choice. A branch guiding still running is followed.
   */
  async startBranch({ workspaceId, url }: { workspaceId: string; url: string | null }): Promise<BranchStart> {
    const current = this.#branchStarts.get(workspaceId);
    if (current && (await this.#branchRunning(current))) return this.#branchView(current);

    const job: BranchJob = { state: { status: "finding" }, done: Promise.resolve() };
    const chosen = current?.state.status === "choose" ? current.state : null;
    const candidate = chosen?.candidates.find((entry) => entry.ref.url === url);
    this.#branchStarts.set(workspaceId, job);
    if (chosen && candidate) {
      job.state = { status: "started", reviewId: this.#begin(chosen.forge, candidate.ref, ownWorkspace(chosen.checkout)) };
    } else {
      job.done = this.#findBranch(workspaceId, job).catch((error: unknown) => {
        const message = errorMessage(error);
        this.#log(`Finding the PR or MR of ${workspaceId}'s branch failed: ${message}`);
        job.state = { status: "failed", message };
      });
    }
    return this.#branchView(job);
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
    if (record === null) {
      const branch = this.#branchStarts.get(workspaceId);
      return branch ? { status: "none", branch: await this.#branchView(branch) } : { status: "none" };
    }
    return {
      status: "ready",
      reviewId: record.id,
      header: record.header,
      guide: await this.#guideState(record),
      ...(record.note ? { note: record.note } : {}),
    };
  }

  /**
   * Generates the review's guide again with a new guide agent, archiving the one before it, unless a
   * generation is running already, which is then the one followed.
   */
  async generateGuide({ reviewId }: { reviewId: string }): Promise<GuideState> {
    const record = await this.#store.get(reviewId);
    if (record === null) throw new Error("This review is not known here any more. Start it again.");
    const running = this.#generations.get(generationKey(record));
    if (running) return { status: "generating", agentId: running.agentId };

    const previous = await this.#store.getGuide(record.id, record.header.headSha);
    if (previous?.agentId) await this.#guideAgents.archive(previous.agentId);
    return this.#generate(record, null);
  }

  /**
   * Where the forge has the review's head now, against the head of the guide the panel shows. The
   * "PR updated since this guide" banner is `moved`, and so is what keeps a verdict from applying to
   * code the guide did not explain. A forge that cannot be asked is reported, not thrown, and reads
   * as not moved, so a flaky network does not put a banner up.
   */
  async checkHead({ reviewId }: { reviewId: string }): Promise<HeadCheck> {
    const record = await this.#store.get(reviewId);
    if (record === null) throw new Error("This review is not known here any more. Start it again.");
    const guideHeadSha = record.header.headSha;
    try {
      const head = await this.#forgeOf(record.ref).fetchHead(record.ref);
      return { guideHeadSha, forgeHeadSha: head.headSha, moved: head.headSha !== guideHeadSha, state: head.state, message: null };
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      const message = `Could not check ${record.ref.url} for new commits: ${error.message}`;
      return { guideHeadSha, forgeHeadSha: null, moved: false, state: null, message };
    }
  }

  /**
   * "Regenerate": reads the change request at its current head, brings the guide's workspace there
   * and generates the guide for that head, as a background job the panel follows through `progress`.
   * The only way to a guide at a new head: a start with the head moved keeps the guide it has.
   */
  async regenerate({ reviewId }: { reviewId: string }): Promise<StartResult> {
    const record = await this.#store.get(reviewId);
    if (record === null) return { status: "rejected", message: "This review is not known here any more. Start it again." };
    return { status: "started", reviewId: this.#begin(this.#forgeOf(record.ref), record.ref, null, "regenerate") };
  }

  /**
   * "Ask about this": sends the guide agent a prompt naming the subject, with what the guide says
   * about it, for the reviewer to follow up in the agent's chat. Sends only to an idle agent of a
   * finished guide, since a prompt to a busy one would interrupt it; otherwise says why not.
   */
  async ask({ reviewId, subject }: { reviewId: string; subject: GuideSubject }): Promise<AskResult> {
    const record = await this.#store.get(reviewId);
    if (record === null) return notSent(null, "This review is not known here any more. Start it again.");
    const { headSha } = record.header;
    const running = this.#generations.get(generationKey(record));
    if (running) return notSent(running.agentId, "The guide agent is still writing the guide. Ask once the guide is ready.");
    const stored = await this.#store.getGuide(record.id, headSha);
    if (stored === null || stored.workspaceId !== record.workspace.id || stored.status !== "ready" || stored.agentId === null) {
      return notSent(stored?.agentId ?? null, "There is no finished guide to ask about yet.");
    }
    const agentId = stored.agentId;

    const context = await this.#askContext(record, stored.guide!, subject);
    if (typeof context === "string") return notSent(agentId, context);

    switch (await this.#guideAgents.status(agentId)) {
      case "busy":
        return notSent(agentId, "The guide agent is busy with another answer. Ask again once it has finished.");
      case "gone":
        return notSent(null, "The guide agent is gone: it was archived or closed, so there is no chat to ask in.");
      case "idle":
        break;
    }
    try {
      await this.#guideAgents.send(agentId, askPrompt(record.ref, headSha, context));
    } catch (error) {
      // The agent got busy, or went, between the check and the send.
      if (error instanceof GuideAgentError) return notSent(agentId, error.message);
      throw error;
    }
    return { status: "sent", agentId };
  }

  /** What the prompt says about `subject`, from the stored guide and snapshot, or why it cannot be asked about. */
  async #askContext(record: ReviewRecord, guide: LayeredGuide, subject: GuideSubject): Promise<AskSubjectContext | string> {
    const changeRequest = await this.#store.snapshot(record.id, record.header.headSha);
    if (subject.kind === "node") {
      const node = guide.nodes.find((candidate) => candidate.id === subject.nodeId);
      if (node === undefined) return "That concept is not in the guide any more.";
      if (changeRequest === null) return "What the forge said at this head is missing. Start the review again.";
      return { kind: "node", node, code: codeReferencesOf(resolveCode(changeRequest.files, node.covers).files) };
    }
    const file = changeRequest?.files.find((candidate) => candidate.path === subject.path);
    if (file === undefined) return `${subject.path} is not one of the change's files.`;
    const supporting = guide.supporting.find((entry) => entry.path === file.path);
    if (supporting !== undefined) return { kind: "file", file, category: supporting.category };
    if (guide.unsorted.includes(file.path)) return { kind: "file", file, category: null };
    const nodes = guide.nodes.filter((candidate) => coveredPaths(candidate).includes(file.path));
    if (nodes.length === 0) return `${file.path} is not in the guide any more.`;
    const titles = nodes.map((node) => `"${node.title}"`).join(", ");
    return nodes.length === 1
      ? `${file.path} belongs to the concept ${titles}. Ask about that concept instead.`
      : `${file.path} belongs to the concepts ${titles}. Ask about one of those instead.`;
  }

  /**
   * The hunks a subject of the review's current guide covers, parsed from what the forge said at the
   * guide's head: a node's, in the order it names its files, or the whole diff of a changed file,
   * which is what a Supporting or Unsorted entry shows.
   */
  async nodeDiff({ reviewId, subject }: { reviewId: string; subject: GuideSubject }): Promise<NodeDiff> {
    const record = await this.#store.get(reviewId);
    if (record === null) throw new Error("This review is not known here any more. Start it again.");
    const { headSha } = record.header;
    const stored = await this.#store.getGuide(record.id, headSha);
    if (stored?.status !== "ready" || stored.guide === null) throw new Error("The guide is not ready yet.");
    let covers: CoveredCode[];
    if (subject.kind === "node") {
      const node = stored.guide.nodes.find((candidate) => candidate.id === subject.nodeId);
      if (node === undefined) throw new Error(`The guide has no concept "${subject.nodeId}". Reopen the panel.`);
      covers = node.covers;
    } else {
      covers = [{ path: subject.path, hunks: [], lines: [] }];
    }
    const changeRequest = await this.#store.snapshot(record.id, headSha);
    if (changeRequest === null) throw new Error("What the forge said at this head is missing. Start the review again.");
    const resolved = resolveCode(changeRequest.files, covers);
    if (subject.kind === "file" && resolved.files.length === 0) throw new Error(`${subject.path} is not one of the change's files.`);
    return { headSha, files: resolved.files };
  }

  /**
   * The reviewer's progress through the guide the panel shows: the one at the review's head, in its
   * workspace. Null while that guide is not ready.
   */
  async guideProgress({ reviewId }: { reviewId: string }): Promise<GuideProgress | null> {
    const record = await this.#store.get(reviewId);
    // A guide being generated again replaces the one on disk, and its marks with it.
    if (record === null || this.#generations.has(generationKey(record))) return null;
    const stored = await this.#store.getGuide(record.id, record.header.headSha);
    if (stored === null || stored.workspaceId !== record.workspace.id || !isReady(stored)) return null;
    return summariseProgress(stored.guide, stored.headSha, marksOf(stored, await this.#store.getProgress(record.id, stored.headSha)));
  }

  /**
   * Marks a node, or a Supporting or Unsorted entry, of the guide at `headSha` understood, or clears
   * the mark, and keeps the marks on disk under that head. Marks of one guide are written one at a
   * time, so two toggles at once both land.
   */
  async setUnderstood({
    reviewId,
    headSha,
    subject,
    understood,
  }: {
    reviewId: string;
    headSha: string;
    subject: GuideSubject;
    understood: boolean;
  }): Promise<GuideProgress> {
    const key = `${reviewId}@${headSha}`;
    const write = (this.#progressWrites.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.#setUnderstood(reviewId, headSha, subject, understood));
    this.#progressWrites.set(key, write);
    try {
      return await write;
    } finally {
      if (this.#progressWrites.get(key) === write) this.#progressWrites.delete(key);
    }
  }

  async #setUnderstood(reviewId: string, headSha: string, subject: GuideSubject, understood: boolean): Promise<GuideProgress> {
    const record = await this.#store.get(reviewId);
    if (record === null) throw new Error("This review is not known here any more. Start it again.");
    const stored = this.#generations.has(`${record.id}@${headSha}`) ? null : await this.#store.getGuide(record.id, headSha);
    if (stored === null || !isReady(stored)) throw new Error("There is no finished guide to mark progress in.");
    const { guide } = stored;
    if (subject.kind === "node" && !guide.nodes.some((node) => node.id === subject.nodeId)) {
      throw new Error("That concept is not in the guide any more.");
    }
    if (subject.kind === "file" && !guide.supporting.some((entry) => entry.path === subject.path) && !guide.unsorted.includes(subject.path)) {
      throw new Error(`${subject.path} is not a Supporting or Unsorted file of the guide.`);
    }

    const marks = marksOf(stored, await this.#store.getProgress(record.id, headSha));
    const [list, value] = subject.kind === "node" ? [marks.nodes, subject.nodeId] : [marks.files, subject.path];
    const next = understood ? [...new Set([...list, value])] : list.filter((entry) => entry !== value);
    const progress: ProgressRecord = {
      headSha,
      agentId: stored.agentId,
      nodes: subject.kind === "node" ? next : marks.nodes,
      files: subject.kind === "file" ? next : marks.files,
      updatedAt: this.#now().toISOString(),
    };
    await this.#store.saveProgress(record.id, progress);
    return summariseProgress(guide, headSha, progress);
  }

  /** For the `workspace.archived` hook: a review's workspace ending ends its guide agents. */
  async workspaceArchived({ workspaceId }: { workspaceId: string }): Promise<void> {
    const record = await this.#store.findByWorkspace(workspaceId);
    if (record !== null) await this.#endGuides(record.id, workspaceId);
  }

  /** Resolves once no background job is running, including the ones a finishing job started. */
  async settled(): Promise<void> {
    for (;;) {
      const running = [...this.#branchStarts.values(), ...this.#jobs.values(), ...this.#generations.values()].map((job) => job.done);
      await Promise.all(running);
      const now = [...this.#branchStarts.values(), ...this.#jobs.values()].map((job) => job.done);
      if (this.#generations.size === 0 && now.every((done) => running.includes(done))) return;
    }
  }

  /** The forge a recorded review was read from. */
  #forgeOf(ref: ChangeRequestRef): Forge {
    const forge = this.#forges.find((candidate) => candidate.kind === ref.forge);
    if (forge === undefined) throw new Error(`No ${ref.forge} forge is set up to read ${ref.url}.`);
    return forge;
  }

  async #match(url: string): Promise<{ forge: Forge; ref: ChangeRequestRef } | null> {
    for (const forge of this.#forges) {
      const ref = await forge.matchUrl(url);
      if (ref !== null) return { forge, ref };
    }
    return null;
  }

  /**
   * Starts reading the change request and giving it a workspace as a background job, and returns the
   * review's ID; a job already running for it is the one followed. `own` is the reviewer's workspace
   * on the change request's branch, to fast-forward and attach to rather than make a PR workspace.
   * A `start` keeps a guide the review already has when the head has moved; a `regenerate` does not.
   */
  #begin(forge: Forge, ref: ChangeRequestRef, own: ReviewWorkspace | null, mode: PrepareMode = "start"): string {
    const id = reviewIdOf(ref);
    const running = this.#jobs.get(id);
    if (running && !isFinished(running.progress.phase)) return id;

    const job: Job = { progress: progress("reading"), note: null, done: Promise.resolve() };
    this.#jobs.set(id, job);
    job.done = this.#prepare(id, forge, ref, job, own, mode).catch((error: unknown) => {
      const message = errorMessage(error);
      this.#log(`Starting a review of ${ref.url} failed: ${message}`);
      job.progress = { ...job.progress, phase: "failed", message };
    });
    return id;
  }

  /** Finds the change request the workspace's branch is the source of, and starts it when there is one. */
  async #findBranch(workspaceId: string, job: BranchJob): Promise<void> {
    const checkout = await this.#workspaces.inspect(workspaceId);
    if (checkout === null) {
      job.state = { status: "failed", message: "This workspace is not open any more." };
      return;
    }
    const { branch, repository } = checkout;
    if (branch === null) {
      job.state = { status: "none", message: "This workspace is not on a branch, so no PR or MR comes from it." };
      return;
    }
    if (repository === null) {
      job.state = { status: "none", message: "This workspace's repository has no origin on GitHub or GitLab to find a PR or MR on." };
      return;
    }

    for (const forge of this.#forges) {
      let found: BranchChangeRequest[] | null;
      try {
        found = await forge.findByBranch(repository, branch);
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        job.state = { status: "failed", message: error.message };
        return;
      }
      if (found === null) continue;

      const local: LocalCheckout = { ...checkout, branch, repository };
      if (found.length === 0) {
        const kind = forge.kind === "gitlab" ? "merge request" : "pull request";
        job.state = { status: "none", message: `No open ${kind} in ${repository.project} comes from ${branch}.` };
      } else if (found.length === 1) {
        job.state = { status: "started", reviewId: this.#begin(forge, found[0]!.ref, ownWorkspace(local)) };
      } else {
        job.state = { status: "choose", checkout: local, forge, candidates: found };
      }
      return;
    }
    job.state = { status: "none", message: `${repository.host} is neither GitHub nor a GitLab glab is logged in to.` };
  }

  /** Whether the branch guiding is still under way: finding its change request, or preparing its review. */
  async #branchRunning(job: BranchJob): Promise<boolean> {
    if (job.state.status === "finding") return true;
    if (job.state.status !== "started") return false;
    return !isFinished((await this.progress({ reviewId: job.state.reviewId })).phase);
  }

  async #branchView(job: BranchJob): Promise<BranchStart> {
    const { state } = job;
    switch (state.status) {
      case "finding":
      case "none":
      case "failed":
        return state;
      case "choose":
        return {
          status: "choose",
          branch: state.checkout.branch,
          candidates: state.candidates.map(({ ref, title, author }) => ({ forge: ref.forge, url: ref.url, number: ref.number, title, author })),
        };
      case "started": {
        const note = this.#jobs.get(state.reviewId)?.note ?? (await this.#store.get(state.reviewId))?.note ?? null;
        return { status: "started", reviewId: state.reviewId, progress: await this.progress({ reviewId: state.reviewId }), note };
      }
    }
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
      job.progress = { ...job.progress, header: record.header, phase: "ready", workspaceId: record.workspace.id };
      await this.#guideState(record);
      return;
    }

    const workspace = await this.#workspaceFor(id, forge, changeRequest, job, own, headMoved);
    if (previous !== null && previous.workspace.id !== workspace.id) {
      // The `workspace.archived` hook is not replayed after a restart, so an old workspace's agents are ended here too.
      await this.#endGuides(previous.id, previous.workspace.id);
    } else if (previous !== null && headMoved) {
      // The panel shows the guide at the new head from now on, so the one it replaces ends with it.
      await this.#endGuideAt(previous.id, previous.header.headSha, workspace.id);
    }

    const previousHeadSha = headMoved ? previous.header.headSha : previous?.previousHeadSha;
    const record: ReviewRecord = {
      id,
      ref,
      workspace,
      header,
      viewer,
      updatedAt: this.#now().toISOString(),
      ...(job.note === null ? {} : { note: job.note }),
      ...(previousHeadSha === undefined ? {} : { previousHeadSha }),
    };
    await this.#store.save(record, changeRequest);
    job.progress = { ...job.progress, phase: "ready", workspaceId: workspace.id };
    await this.#guideState(record);
  }

  /**
   * Whether a start with the head moved leaves the review as it is: its workspace is still open and
   * is the one asked for, and it has a guide there that is written or being written. A failed guide
   * holds nothing to keep, so a start moves on to the new head instead of offering a retry at the old.
   */
  async #keepsGuide(previous: ReviewRecord, own: ReviewWorkspace | null): Promise<boolean> {
    if (own !== null && own.id !== previous.workspace.id) return false;
    if (!(await this.#workspaces.isActive(previous.workspace.id))) return false;
    if (this.#generations.has(generationKey(previous))) return true;
    const stored = await this.#store.getGuide(previous.id, previous.header.headSha);
    return stored !== null && stored.workspaceId === previous.workspace.id && stored.status !== "failed";
  }

  /**
   * The guide of the review's current head, starting its generation when there is none for this
   * workspace, and picking a generation a plugin restart cut off back up from its agent.
   */
  async #guideState(record: ReviewRecord): Promise<GuideState> {
    const running = this.#generations.get(generationKey(record));
    if (running) return { status: "generating", agentId: running.agentId };

    const stored = await this.#store.getGuide(record.id, record.header.headSha);
    if (stored === null || stored.workspaceId !== record.workspace.id) return this.#generate(record, null);
    switch (stored.status) {
      case "ready":
        return { status: "ready", agentId: stored.agentId!, guide: stored.guide! };
      case "failed":
        return { status: "failed", agentId: stored.agentId, message: stored.message ?? "Generating the guide failed." };
      case "generating":
        // Nothing here is generating it, so a plugin restart cut it off: an agent that exists is
        // waited for again, and one that never got created is created now.
        return this.#generate(record, stored.agentId);
    }
  }

  /**
   * Generates the guide as a background job: creates the guide agent on the generation prompt, or
   * takes `agentId`'s, and keeps its validated answer. Returns the generation's state, which is the
   * running one's when this head has one: two panels asking at once must not make two agents.
   */
  #generate(record: ReviewRecord, agentId: string | null): GuideState {
    const key = generationKey(record);
    const running = this.#generations.get(key);
    if (running) return { status: "generating", agentId: running.agentId };

    const { headSha } = record.header;
    const generation: Generation = { agentId, done: Promise.resolve() };
    const save = (update: Pick<GuideRecord, "status" | "guide" | "message">) =>
      this.#store.saveGuide(record.id, {
        headSha,
        workspaceId: record.workspace.id,
        agentId: generation.agentId,
        ...update,
        updatedAt: this.#now().toISOString(),
      });

    const run = async () => {
      if (generation.agentId === null) await save({ status: "generating", guide: null, message: null });
      const changeRequest = await this.#store.snapshot(record.id, headSha);
      if (changeRequest === null) throw new Error("What the forge said at this head is missing. Start the review again.");
      // Lockfiles and generated files never reach the agent; they go straight into Supporting.
      const files = setAside(changeRequest.files);
      if (generation.agentId === null) {
        const schema = jsonSchemaOf(GuideSchema);
        const agent = await this.#guideAgents.create({
          workspace: record.workspace,
          title: `Guide: ${record.header.title}`,
          labels: { [GUIDE_AGENT_LABEL]: record.id, [GUIDE_HEAD_LABEL]: headSha },
          prompt: withOutputSchema(guidePrompt({ ...changeRequest, files: files.sent }, files.setAside.length), schema),
          outputSchema: schema,
        });
        generation.agentId = agent.id;
        await save({ status: "generating", guide: null, message: null });
      }
      const parsed = parseGuide(await this.#guideAgents.reply(generation.agentId), changeRequest.files);
      if (!parsed.ok) return save({ status: "failed", guide: null, message: parsed.message });
      const changed = changeRequest.files.map((file) => file.path);
      const guide = layOutGuide(parsed.guide, changed, files.setAside);
      // Before the guide reads as ready, so its first progress read already has what carried over.
      await this.#carryMarksOver(record, generation.agentId, guide, changeRequest.files);
      await save({ status: "ready", guide, message: null });
    };

    this.#generations.set(key, generation);
    generation.done = run()
      .catch(async (error: unknown) => {
        const message = errorMessage(error);
        this.#log(`Generating the guide for ${record.header.url} failed: ${message}`);
        await save({ status: "failed", guide: null, message }).catch(() => {});
      })
      .finally(() => this.#generations.delete(key));
    return { status: "generating", agentId };
  }

  /**
   * Keeps, as the marks of the guide `agentId` just wrote at the review's head, the marks of the
   * guide at the head before it that hold for code that did not change: see `carryMarks`. Marks at
   * the old head made in another guide than the one kept there count for nothing, as they do there.
   */
  async #carryMarksOver(record: ReviewRecord, agentId: string, guide: LayeredGuide, files: ChangedFile[]): Promise<void> {
    const from = record.previousHeadSha;
    if (from === undefined) return;
    const [before, marks, snapshot, current] = await Promise.all([
      this.#store.getGuide(record.id, from),
      this.#store.getProgress(record.id, from),
      this.#store.snapshot(record.id, from),
      this.#store.getProgress(record.id, record.header.headSha),
    ]);
    // A generation picked up again after a restart may have carried them over already.
    if (current?.agentId === agentId) return;
    if (before === null || !isReady(before) || snapshot === null) return;
    const carried = carryMarks({ guide: before.guide, files: snapshot.files, marks: marksOf(before, marks) }, { guide, files });
    if (carried.nodes.length === 0 && carried.files.length === 0) return;
    await this.#store.saveProgress(record.id, {
      headSha: record.header.headSha,
      agentId,
      ...carried,
      updatedAt: this.#now().toISOString(),
    });
  }

  /** Archives the agent of the review's guide at `headSha`, if that guide lived in `workspaceId`. */
  async #endGuideAt(reviewId: string, headSha: string, workspaceId: string): Promise<void> {
    const guide = await this.#store.getGuide(reviewId, headSha);
    if (guide !== null && guide.workspaceId === workspaceId && guide.agentId !== null) await this.#guideAgents.archive(guide.agentId);
  }

  /** Archives the guide agents that lived in `workspaceId`; the workspace ending ends its guides. */
  async #endGuides(reviewId: string, workspaceId: string): Promise<void> {
    for (const guide of await this.#store.guides(reviewId)) {
      if (guide.workspaceId === workspaceId && guide.agentId !== null) await this.#guideAgents.archive(guide.agentId);
    }
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

/** A workspace on a branch as the one to attach a guide to, fast-forwarding it first. */
function ownWorkspace(checkout: LocalCheckout): ReviewWorkspace {
  return { ...checkout.workspace, branch: checkout.branch };
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

function progress(phase: StartPhase): StartProgress {
  return { phase, header: null, workspaceId: null, message: null };
}

function notSent(agentId: string | null, message: string): AskResult {
  return { status: "not-sent", agentId, message };
}

type ReadyGuide = GuideRecord & { status: "ready"; agentId: string; guide: LayeredGuide };

function isReady(record: GuideRecord): record is ReadyGuide {
  return record.status === "ready" && record.agentId !== null && record.guide !== null;
}

/** The marks made in `guide`; ones kept for an earlier guide at the same head, by another agent, are not. */
function marksOf(guide: ReadyGuide, progress: ProgressRecord | null): { nodes: string[]; files: string[] } {
  if (progress === null || progress.agentId !== guide.agentId) return { nodes: [], files: [] };
  return { nodes: progress.nodes, files: progress.files };
}

function generationKey(record: ReviewRecord): string {
  return `${record.id}@${record.header.headSha}`;
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
