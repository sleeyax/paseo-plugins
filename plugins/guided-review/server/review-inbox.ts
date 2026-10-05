import type { Inbox, InboxItem, LocalReview, ReviewRequest } from "../shared/inbox.ts";
import type { ChangeRequestRef, Forge } from "./forge/port.ts";
import type { GuideGenerations } from "./guide-generation.ts";
import type { InboxCheckOffsFile } from "./inbox-check-offs.ts";
import type { ReviewPreparation } from "./review-preparation.ts";
import { reviewIdOf, type ReviewRecord, type ReviewStore } from "./review-store.ts";
import type { WorkspacePort } from "./workspaces/port.ts";

export type ReviewInboxOptions = {
  forges: readonly Forge[];
  store: ReviewStore;
  preparation: ReviewPreparation;
  guides: GuideGenerations;
  workspaces: WorkspacePort;
  checkOffs: InboxCheckOffsFile;
  log: (message: string) => void;
};

/**
 * The review requests of every forge, joined with the reviews started here and what the reviewer checked off: the start surface's list.
 * Each forge answers per host, so one that cannot be listed leaves the rest listed.
 *
 * GitLab's listing cannot count drafts, which take a call per MR, so they are counted only for the
 * MRs reviewed here; and its guess at a push since the last review is replaced by the head a review
 * from here was published at, which is exact.
 */
export class ReviewInbox {
  readonly #forges: readonly Forge[];
  readonly #store: ReviewStore;
  readonly #preparation: ReviewPreparation;
  readonly #guides: GuideGenerations;
  readonly #workspaces: WorkspacePort;
  readonly #checkOffs: InboxCheckOffsFile;
  readonly #log: (message: string) => void;

  constructor(options: ReviewInboxOptions) {
    this.#forges = options.forges;
    this.#store = options.store;
    this.#preparation = options.preparation;
    this.#guides = options.guides;
    this.#workspaces = options.workspaces;
    this.#checkOffs = options.checkOffs;
    this.#log = options.log;
  }

  async list(): Promise<Inbox> {
    const listed = (await Promise.all(this.#forges.map((forge) => forge.listReviewRequests()))).flat();
    const requests = listed.flatMap((host) => host.requests);
    const checkedOff = await this.#checkOffs.follow(listed);
    const items = await Promise.all(requests.map(async (request) => ({ ...(await this.#item(request)), checkedOff: checkedOff.has(request.url) })));
    return { hosts: listed.map(({ requests: _, ...host }) => host), items };
  }

  /** What this plugin has of the review `reviewId` names: null when it was never started here. */
  async local(reviewId: string): Promise<LocalReview | null> {
    const record = await this.#store.get(reviewId);
    const progress = this.#preparation.progressOf(reviewId);
    const preparing = progress === undefined || progress.phase === "ready" ? null : { phase: progress.phase, message: progress.message };
    if (record === null) return preparing === null ? null : { header: progress?.header ?? null, preparing, guide: "none", workspaceId: null };
    const stored = await this.#store.getGuide(record.id, record.header.headSha);
    return {
      header: record.header,
      preparing,
      guide: this.#guides.running(record) ? "generating" : (stored?.status ?? "none"),
      workspaceId: (await this.#workspaces.isActive(record.workspace.id)) ? record.workspace.id : null,
    };
  }

  async #item(request: ReviewRequest): Promise<Omit<InboxItem, "checkedOff">> {
    const reviewId = idOf(request);
    const local = reviewId === null ? null : await this.local(reviewId);
    const record = reviewId === null ? null : await this.#store.get(reviewId);
    if (record === null) return { ...request, reviewId, local };
    return { ...request, ...(await this.#fromReview(request, record)), reviewId, local };
  }

  /** What the review started here knows better than the forge's listing. */
  async #fromReview(request: ReviewRequest, record: ReviewRecord): Promise<Pick<ReviewRequest, "pendingDrafts" | "changedSinceReview">> {
    const paragraphs = (await this.#store.getDrafts(record.id)).paragraphs.length;
    if (request.forge === "github") {
      return { pendingDrafts: request.pendingDrafts === null ? null : request.pendingDrafts + paragraphs, changedSinceReview: request.changedSinceReview };
    }
    const reviewed = request.state !== "requested" && record.submittedHeadSha !== undefined;
    return {
      pendingDrafts: await this.#countDrafts(record.ref),
      changedSinceReview: reviewed ? record.submittedHeadSha !== request.headSha : request.changedSinceReview,
    };
  }

  async #countDrafts(ref: ChangeRequestRef): Promise<number | null> {
    const forge = this.#forges.find((candidate) => candidate.kind === ref.forge);
    try {
      return (await forge?.listDrafts(ref))?.length ?? null;
    } catch (error) {
      this.#log(`Counting the drafts on ${ref.url} failed: ${String(error)}`);
      return null;
    }
  }

}

function idOf({ forge, host, project, number, url }: ReviewRequest): string | null {
  try {
    return reviewIdOf({ forge, host, project, number, url });
  } catch {
    return null;
  }
}
