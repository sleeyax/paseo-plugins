import type { Inbox, InboxItem, LocalReview, ReviewRequest } from "../shared/inbox.ts";
import type { ChangeRequestRef, Forge } from "./forge/port.ts";
import { reviewIdOf, type ReviewRecord, type ReviewStore } from "./review-store.ts";

export type ReviewInboxOptions = {
  forges: readonly Forge[];
  store: ReviewStore;
  log: (message: string) => void;
};

/**
 * The review requests of every forge, joined with the reviews started here: the start surface's
 * list. Each forge answers per host, so one that cannot be listed leaves the rest listed.
 *
 * GitLab's listing cannot count drafts, which take a call per MR, so they are counted only for the
 * MRs reviewed here; and its guess at a push since the last review is replaced by the head a review
 * from here was published at, which is exact.
 */
export class ReviewInbox {
  readonly #forges: readonly Forge[];
  readonly #store: ReviewStore;
  readonly #log: (message: string) => void;

  constructor(options: ReviewInboxOptions) {
    this.#forges = options.forges;
    this.#store = options.store;
    this.#log = options.log;
  }

  async list(): Promise<Inbox> {
    const listed = (await Promise.all(this.#forges.map((forge) => forge.listReviewRequests()))).flat();
    const requests = listed.flatMap((host) => host.requests);
    const items = await Promise.all(requests.map((request) => this.#item(request)));
    return { hosts: listed.map(({ requests: _, ...host }) => host), items };
  }

  async #item(request: ReviewRequest): Promise<InboxItem> {
    const record = await this.#recordOf(request);
    if (record === null) return { ...request, local: null };
    const local: LocalReview = {
      reviewId: record.id,
      guide: (await this.#store.getGuide(record.id, record.header.headSha))?.status ?? "none",
      headMoved: request.headSha !== "" && request.headSha !== record.header.headSha,
    };
    return { ...request, ...(await this.#fromReview(request, record)), local };
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

  async #recordOf({ forge, host, project, number, url }: ReviewRequest): Promise<ReviewRecord | null> {
    let id: string;
    try {
      id = reviewIdOf({ forge, host, project, number, url });
    } catch {
      return null;
    }
    return this.#store.get(id);
  }
}
