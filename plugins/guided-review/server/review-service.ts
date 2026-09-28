import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AskResult, GuideSubject, NodeDiff, PanelView, ReviewHeader, StartPhase, StartProgress, StartResult } from "../shared/contracts.ts";
import { coveredPaths, GuideSchema, type GuideState, type LayeredGuide } from "../shared/guide.ts";
import { numberLabel } from "../shared/reference.ts";
import { askPrompt, codeReferencesOf, type AskSubjectContext } from "./ask-prompt.ts";
import { resolveCode } from "./diff.ts";
import { ForgeError, type ChangeRequest, type ChangeRequestRef, type Forge } from "./forge/port.ts";
import { GUIDE_AGENT_LABEL, GUIDE_HEAD_LABEL, GuideAgentError, type GuideAgentPort } from "./guide-agent/port.ts";
import { jsonSchemaOf, withOutputSchema } from "./guide-agent/structured.ts";
import { setAside } from "./file-classes.ts";
import { layOutGuide, parseGuide } from "./guide-output.ts";
import { guidePrompt } from "./guide-prompt.ts";
import { ReviewStore, reviewIdOf, type GuideRecord, type ReviewRecord } from "./review-store.ts";
import type { ReviewWorkspace, WorkspacePort } from "./workspaces/port.ts";

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

type Job = { progress: StartProgress; done: Promise<void> };
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
    return { status: "ready", reviewId: record.id, header: record.header, guide: await this.#guideState(record) };
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
   * The hunks one node of the review's current guide covers, parsed from what the forge said at the
   * guide's head, in the order the node names its files.
   */
  async nodeDiff({ reviewId, nodeId }: { reviewId: string; nodeId: string }): Promise<NodeDiff> {
    const record = await this.#store.get(reviewId);
    if (record === null) throw new Error("This review is not known here any more. Start it again.");
    const { headSha } = record.header;
    const stored = await this.#store.getGuide(record.id, headSha);
    if (stored?.status !== "ready" || stored.guide === null) throw new Error("The guide is not ready yet.");
    const node = stored.guide.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) throw new Error(`The guide has no concept "${nodeId}". Reopen the panel.`);
    const changeRequest = await this.#store.snapshot(record.id, headSha);
    if (changeRequest === null) throw new Error("What the forge said at this head is missing. Start the review again.");
    return { headSha, files: resolveCode(changeRequest.files, node.covers).files };
  }

  /** For the `workspace.archived` hook: a review's workspace ending ends its guide agents. */
  async workspaceArchived({ workspaceId }: { workspaceId: string }): Promise<void> {
    const record = await this.#store.findByWorkspace(workspaceId);
    if (record !== null) await this.#endGuides(record.id, workspaceId);
  }

  /** Resolves once no background job is running, including the ones a finishing job started. */
  async settled(): Promise<void> {
    for (;;) {
      const running = [...this.#jobs.values(), ...this.#generations.values()].map((job) => job.done);
      await Promise.all(running);
      if (this.#generations.size === 0) return;
    }
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
    // The `workspace.archived` hook is not replayed after a restart, so an old workspace's agents are ended here too.
    const previous = await this.#store.get(id);
    if (previous !== null && previous.workspace.id !== workspace.id) await this.#endGuides(previous.id, previous.workspace.id);

    const record: ReviewRecord = { id, ref, workspace, header, viewer, updatedAt: this.#now().toISOString() };
    await this.#store.save(record, changeRequest);
    job.progress = { ...job.progress, phase: "ready", workspaceId: workspace.id };
    await this.#guideState(record);
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
      await save({ status: "ready", guide: layOutGuide(parsed.guide, changed, files.setAside), message: null });
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

  /** Archives the guide agents that lived in `workspaceId`; the workspace ending ends its guides. */
  async #endGuides(reviewId: string, workspaceId: string): Promise<void> {
    for (const guide of await this.#store.guides(reviewId)) {
      if (guide.workspaceId === workspaceId && guide.agentId !== null) await this.#guideAgents.archive(guide.agentId);
    }
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

function notSent(agentId: string | null, message: string): AskResult {
  return { status: "not-sent", agentId, message };
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
