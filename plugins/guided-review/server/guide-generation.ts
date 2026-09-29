import { GuideSchema, type GuideState, type LayeredGuide } from "../shared/guide.ts";
import { carryMarks } from "./carry-over.ts";
import { errorMessage } from "./error-message.ts";
import { setAside } from "./file-classes.ts";
import type { ChangedFile } from "./forge/port.ts";
import { GUIDE_AGENT_LABEL, GUIDE_HEAD_LABEL, type GuideAgentPort } from "./guide-agent/port.ts";
import { jsonSchemaOf, withOutputSchema } from "./guide-agent/structured.ts";
import { keepQuotedAlternatives, layOutGuide, parseGuide } from "./guide-output.ts";
import { guidePrompt } from "./guide-prompt.ts";
import type { GuideRecord, ProgressRecord, ReviewRecord, ReviewStore } from "./review-store.ts";

/** A guide being generated; `agentId` is set once its agent exists. */
export type Generation = { agentId: string | null; done: Promise<void> };

/** A guide that is written, with the agent that wrote it. */
export type ReadyGuide = GuideRecord & { status: "ready"; agentId: string; guide: LayeredGuide };

export type GuideGenerationsOptions = {
  store: ReviewStore;
  guideAgents: GuideAgentPort;
  now: () => Date;
  log: (message: string) => void;
};

/**
 * The review's guides and the guide agents that write them: generating one as a background job
 * keyed by review and head SHA, picking a generation a plugin restart cut off back up from its agent,
 * carrying the reviewer's marks over to a guide at a new head, and archiving agents whose guide ends.
 */
export class GuideGenerations {
  readonly #store: ReviewStore;
  readonly #guideAgents: GuideAgentPort;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  /** Guide generations running, by review and head SHA. */
  readonly #running = new Map<string, Generation>();

  constructor(options: GuideGenerationsOptions) {
    this.#store = options.store;
    this.#guideAgents = options.guideAgents;
    this.#now = options.now;
    this.#log = options.log;
  }

  /** The generation running for the review's guide at `headSha`, the review's own head by default. */
  running(record: ReviewRecord, headSha = record.header.headSha): Generation | undefined {
    return this.#running.get(`${record.id}@${headSha}`);
  }

  /** What every running generation settles on, and whether none is running. */
  pending(): { done: Promise<void>[]; idle: boolean } {
    return { done: [...this.#running.values()].map((generation) => generation.done), idle: this.#running.size === 0 };
  }

  /** The guide the panel shows: ready at the review's head in its workspace, and not being generated again. */
  async shown(record: ReviewRecord): Promise<ReadyGuide | null> {
    if (this.running(record)) return null;
    const stored = await this.#store.getGuide(record.id, record.header.headSha);
    return stored !== null && stored.workspaceId === record.workspace.id && isReady(stored) ? stored : null;
  }

  /**
   * The guide of the review's current head, starting its generation when there is none for this
   * workspace, and picking a generation a plugin restart cut off back up from its agent.
   */
  async state(record: ReviewRecord): Promise<GuideState> {
    const running = this.running(record);
    if (running) return { status: "generating", agentId: running.agentId };

    const stored = await this.#store.getGuide(record.id, record.header.headSha);
    if (stored === null || stored.workspaceId !== record.workspace.id) return this.generate(record, null);
    switch (stored.status) {
      case "ready":
        return { status: "ready", agentId: stored.agentId!, guide: stored.guide! };
      case "failed":
        return { status: "failed", agentId: stored.agentId, message: stored.message ?? "Generating the guide failed." };
      case "generating":
        // Nothing here is generating it, so a plugin restart cut it off: an agent that exists is
        // waited for again, and one that never got created is created now.
        return this.generate(record, stored.agentId);
    }
  }

  /**
   * Generates the review's guide again with a new guide agent, archiving the one before it, unless a
   * generation is running already, which is then the one followed.
   */
  async again(record: ReviewRecord): Promise<GuideState> {
    const running = this.running(record);
    if (running) return { status: "generating", agentId: running.agentId };
    const previous = await this.#store.getGuide(record.id, record.header.headSha);
    if (previous?.agentId) await this.#guideAgents.archive(previous.agentId);
    return this.generate(record, null);
  }

  /**
   * Generates the guide as a background job: creates the guide agent on the generation prompt, or
   * takes `agentId`'s, and keeps its validated answer. Returns the generation's state, which is the
   * running one's when this head has one: two panels asking at once must not make two agents.
   */
  generate(record: ReviewRecord, agentId: string | null): GuideState {
    const running = this.running(record);
    if (running) return { status: "generating", agentId: running.agentId };

    const { headSha } = record.header;
    const key = `${record.id}@${headSha}`;
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
      const reply = await this.#guideAgents.reply(generation.agentId);
      const parsed = parseGuide(reply, files.sent, files.setAside.map((entry) => entry.path));
      if (!parsed.ok) return save({ status: "failed", guide: null, message: parsed.message });
      const guide = layOutGuide(keepQuotedAlternatives(parsed.guide, changeRequest, files.sent), changeRequest.files, files.setAside);
      // Before the guide reads as ready, so its first progress read already has what carried over.
      await this.#carryMarksOver(record, generation.agentId, guide, changeRequest.files);
      await save({ status: "ready", guide, message: null });
    };

    this.#running.set(key, generation);
    generation.done = run()
      .catch(async (error: unknown) => {
        const message = errorMessage(error);
        this.#log(`Generating the guide for ${record.header.url} failed: ${message}`);
        await save({ status: "failed", guide: null, message }).catch(() => {});
      })
      .finally(() => this.#running.delete(key));
    return { status: "generating", agentId };
  }

  /** Archives the agent of the review's guide at `headSha`, if that guide lived in `workspaceId`. */
  async endAt(reviewId: string, headSha: string, workspaceId: string): Promise<void> {
    const guide = await this.#store.getGuide(reviewId, headSha);
    if (guide !== null && guide.workspaceId === workspaceId && guide.agentId !== null) await this.#guideAgents.archive(guide.agentId);
  }

  /** Archives the guide agents that lived in `workspaceId`; the workspace ending ends its guides. */
  async endAll(reviewId: string, workspaceId: string): Promise<void> {
    for (const guide of await this.#store.guides(reviewId)) {
      if (guide.workspaceId === workspaceId && guide.agentId !== null) await this.#guideAgents.archive(guide.agentId);
    }
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
}

export function isReady(record: GuideRecord): record is ReadyGuide {
  return record.status === "ready" && record.agentId !== null && record.guide !== null;
}

/** The marks made in `guide`; ones kept for an earlier guide at the same head, by another agent, are not. */
export function marksOf(guide: ReadyGuide, progress: ProgressRecord | null): { nodes: string[]; files: string[] } {
  if (progress === null || progress.agentId !== guide.agentId) return { nodes: [], files: [] };
  return { nodes: progress.nodes, files: progress.files };
}
