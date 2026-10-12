import type { AuthoredChangeRequest, AuthoredInboxItem, Inbox, InboxItem, ListedChangeRequest, LocalReview, ReviewRequest } from "../shared/inbox.ts";
import type { ChangeRequestRef, Forge } from "./forge/port.ts";
import { awaitsScope, type GuideGenerations } from "./guide-generation.ts";
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
 * The review requests of every forge and the viewer's own change requests, joined with the reviews started here and what the viewer checked off on each tab: the start screen's list.
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
    const listed = (await Promise.all(this.#forges.map((forge) => forge.listChangeRequests()))).flat();
    const checkedOff = await this.#checkOffs.follow(listed);
    const items = await Promise.all(
      listed.flatMap((host) => host.requests).map(async (request) => ({ ...(await this.#item(request)), checkedOff: checkedOff.assigned.has(request.url) })),
    );
    const authored = await Promise.all(
      listed.flatMap((host) => host.authored).map(async (mine) => ({ ...(await this.#authoredItem(mine)), checkedOff: checkedOff.authored.has(mine.url) })),
    );
    return { hosts: listed.map(({ requests: _, authored: __, ...host }) => host), items, authored };
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
      guide: this.#guides.running(record) ? "generating" : (stored?.status ?? (awaitsScope(record) ? "choosing-scope" : "none")),
      workspaceId: (await this.#workspaces.isActive(record.workspace.id)) ? record.workspace.id : null,
    };
  }

  async #item(request: ReviewRequest): Promise<Omit<InboxItem, "checkedOff">> {
    const { reviewId, local, record } = await this.#joined(request);
    if (record === null) return { ...request, reviewId, local };
    const reviewed = request.forge === "gitlab" && request.state !== "requested" && record.submittedHeadSha !== undefined;
    return {
      ...request,
      pendingDrafts: await this.#pendingDrafts(request, record),
      changedSinceReview: reviewed ? record.submittedHeadSha !== request.headSha : request.changedSinceReview,
      reviewId,
      local,
    };
  }

  async #authoredItem(mine: AuthoredChangeRequest): Promise<Omit<AuthoredInboxItem, "checkedOff">> {
    const { reviewId, local, record } = await this.#joined(mine);
    if (record === null) return { ...mine, reviewId, local };
    return { ...mine, pendingDrafts: await this.#pendingDrafts(mine, record), reviewId, local };
  }

  /** The review started here of a listed change request, which is one review whichever tab lists it. */
  async #joined(listed: ListedChangeRequest): Promise<{ reviewId: string | null; local: LocalReview | null; record: ReviewRecord | null }> {
    const reviewId = idOf(listed);
    if (reviewId === null) return { reviewId, local: null, record: null };
    return { reviewId, local: await this.local(reviewId), record: await this.#store.get(reviewId) };
  }

  /** The viewer's unpublished comments, counting the ones kept here, which the forge's listing cannot see. */
  async #pendingDrafts(listed: ListedChangeRequest, record: ReviewRecord): Promise<number | null> {
    if (listed.forge === "gitlab") return this.#countDrafts(record.ref);
    const paragraphs = (await this.#store.getDrafts(record.id)).paragraphs.length;
    return listed.pendingDrafts === null ? null : listed.pendingDrafts + paragraphs;
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

function idOf({ forge, host, project, number, url }: ListedChangeRequest): string | null {
  try {
    return reviewIdOf({ forge, host, project, number, url });
  } catch {
    return null;
  }
}
