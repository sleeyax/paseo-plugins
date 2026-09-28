import type { Draft, DraftList, DraftLocation, LinkedDraft } from "../shared/drafts.ts";
import type { Verdict } from "../shared/submit.ts";
import { anchorAt } from "./anchors.ts";
import { followNode, type GuideAtHead } from "./carry-over.ts";
import type { DraftTarget, Forge, SubmitOutcome } from "./forge/port.ts";
import { isReady, type GuideGenerations } from "./guide-generation.ts";
import { oneAtATimePer } from "./one-at-a-time.ts";
import { composeBody, isParagraphId, paragraphId, splitBody, type BodyParagraph } from "./review-body.ts";
import type { DraftLink, DraftsRecord, ReviewRecord, ReviewStore } from "./review-store.ts";

export type ReviewDraftsOptions = { store: ReviewStore; guides: GuideGenerations };

/**
 * The reviewer's drafts and review body, and what the plugin keeps about them: the drafts live on
 * the forge, `drafts.json` links each to the node it was written from, and on GitHub a node's comment
 * is a paragraph of the pending review's body, after the reviewer's own text. On GitLab, which keeps
 * no body before submit, the body is kept here until a submit publishes it.
 *
 * Every read-modify-write of the body or `drafts.json` goes through `#changing`, one at a time per
 * review: a node comment on GitHub rewrites the body the reviewer's own text shares, and both read it first.
 */
export class ReviewDrafts {
  readonly #store: ReviewStore;
  readonly #guides: GuideGenerations;
  readonly #changing = oneAtATimePer<string>();

  constructor(options: ReviewDraftsOptions) {
    this.#store = options.store;
    this.#guides = options.guides;
  }

  /**
   * The reviewer's drafts, read from the forge every time: they live there, and may have been started
   * on the web. On GitHub the node comments in the pending review's body are drafts too. Each comes
   * with the node of the guide the panel shows that it was written from, when it was written from one.
   */
  async list(record: ReviewRecord, forge: Forge): Promise<DraftList> {
    const [drafts, kept] = await Promise.all([forge.listDrafts(record.ref), this.#store.getDrafts(record.id)]);
    const { paragraphs } = await this.#readBody(record, forge, kept);
    const nodeOf = await this.#linkFollower(record);
    const all = [...drafts, ...paragraphs.map(paragraphDraft)];
    return { drafts: await Promise.all(all.map(async (draft) => ({ ...draft, nodeId: await nodeOf(kept.links[draft.id]) }))) };
  }

  /**
   * Saves a comment on the forge as a draft at once, at `location` in the diff the panel drew at
   * `drawnAt`, which must still be the review's head: Regenerate moves the review to a new head, whose
   * lines are numbered differently, so a comment from a guide it replaced is refused rather than put
   * on whatever line now has its number. It is linked to the node `nodeId` of the guide the panel
   * shows when it was written from one. A `general` comment, on the change as a whole, is a node's
   * comment: an MR-level draft note on GitLab, and on GitHub a paragraph added to the pending review's body.
   */
  async create(
    record: ReviewRecord,
    forge: Forge,
    { drawnAt, location, body, nodeId }: { drawnAt: string; location: DraftLocation; body: string; nodeId: string | null },
  ): Promise<LinkedDraft> {
    const text = draftText(body);
    if (drawnAt !== record.header.headSha) throw new Error(regeneratedAway(drawnAt, record.header.headSha));
    const changeRequest = await this.#store.snapshot(record.id, record.header.headSha);
    if (changeRequest === null) throw new Error("What the forge said at this head is missing. Start the review again.");
    const anchor = anchorAt(changeRequest.files, location);
    const link = nodeId === null ? null : await this.#linkTo(record, nodeId);
    const { ref, baseSha, startSha, headSha } = changeRequest;

    if (anchor.kind === "general" && forge.reviewBody) {
      const paragraph: BodyParagraph = { id: paragraphId(), body: text };
      return this.#changing(record.id, async () => {
        const kept = await this.#store.getDrafts(record.id);
        const { own, paragraphs } = await this.#readBody(record, forge, kept);
        await this.#writeBody(record, forge, own, [...paragraphs, paragraph], link === null ? kept.links : { ...kept.links, [paragraph.id]: link });
        return { ...paragraphDraft(paragraph), nodeId: link?.nodeId ?? null };
      });
    }

    const draft = await forge.createDraft({ ref, baseSha, startSha, headSha }, { anchor, body: text });
    if (link !== null) {
      await this.#changing(record.id, async () => {
        const kept = await this.#store.getDrafts(record.id);
        await this.#store.saveDrafts(record.id, { ...kept, links: { ...kept.links, [draft.id]: link } });
      });
    }
    return { ...draft, nodeId: link?.nodeId ?? null };
  }

  async update(record: ReviewRecord, forge: Forge, draftId: string, body: string): Promise<void> {
    const text = draftText(body);
    if (!isParagraphId(draftId)) return forge.updateDraft(record.ref, draftId, text);
    await this.#changingParagraphs(record, forge, draftId, (paragraphs) =>
      paragraphs.map((paragraph) => (paragraph.id === draftId ? { ...paragraph, body: text } : paragraph)),
    );
  }

  async delete(record: ReviewRecord, forge: Forge, draftId: string): Promise<void> {
    if (isParagraphId(draftId)) {
      return this.#changingParagraphs(record, forge, draftId, (paragraphs) => paragraphs.filter((paragraph) => paragraph.id !== draftId));
    }
    await forge.deleteDraft(record.ref, draftId);
    await this.#changing(record.id, async () => {
      const kept = await this.#store.getDrafts(record.id);
      if (!(draftId in kept.links)) return;
      const { [draftId]: _gone, ...links } = kept.links;
      await this.#store.saveDrafts(record.id, { ...kept, links });
    });
  }

  /**
   * The review body so far, the reviewer's own text: the forge's, where it keeps one before submit,
   * without the node comments GitHub keeps in it, else the one kept here.
   */
  async ownBody(record: ReviewRecord, forge: Forge): Promise<string> {
    return (await this.#readBody(record, forge)).own;
  }

  /** Replaces the reviewer's own text of the body, leaving the node comments GitHub keeps after it. */
  async saveOwnBody(record: ReviewRecord, forge: Forge, body: string): Promise<void> {
    await this.#changing(record.id, async () => {
      const kept = await this.#store.getDrafts(record.id);
      const { paragraphs } = await this.#readBody(record, forge, kept);
      await this.#writeBody(record, forge, body, paragraphs, kept.links);
    });
  }

  /**
   * Keeps the body a submit is about to send where the forge keeps none, before anything is sent, so
   * a refused or failed submit loses none of it.
   */
  async holdBody(record: ReviewRecord, forge: Forge, body: string): Promise<void> {
    if (forge.reviewBody === null) await this.#store.saveReviewBody(record.id, body);
  }

  /**
   * Submits the review with `verdict`: the drafts, and the body, the reviewer's own text followed by
   * the node comments GitHub keeps in it. Once the forge says they are published, nothing kept here
   * about them is wanted any more.
   */
  async submit(record: ReviewRecord, forge: Forge, verdict: Verdict, body: string): Promise<SubmitOutcome> {
    const outcome = await this.#changing(record.id, async () => {
      const kept = await this.#store.getDrafts(record.id);
      const paragraphs = kept.paragraphs.length === 0 ? [] : (await this.#readBody(record, forge, kept)).paragraphs;
      const outcome = await forge.submitReview(await this.#reviewTarget(record), { verdict, body: composeBody(body, paragraphs) });
      if (outcome.published) await this.#store.saveDrafts(record.id, { links: {}, paragraphs: [] });
      return outcome;
    });
    if (outcome.published) await this.holdBody(record, forge, "");
    return outcome;
  }

  /** Throws the pending review away with its drafts and body. */
  async discard(record: ReviewRecord, forge: Forge): Promise<void> {
    await this.#changing(record.id, async () => {
      await forge.discardReview(record.ref);
      await this.#store.saveDrafts(record.id, { links: {}, paragraphs: [] });
    });
    await this.holdBody(record, forge, "");
  }

  /**
   * Rewrites the node comments in the GitHub pending review's body, one of which is `draftId`, and
   * keeps the reviewer's own text as it is. A paragraph no longer in the body whole, edited or
   * deleted on GitHub, cannot be found to change.
   */
  async #changingParagraphs(
    record: ReviewRecord,
    forge: Forge,
    draftId: string,
    change: (paragraphs: BodyParagraph[]) => BodyParagraph[],
  ): Promise<void> {
    if (!forge.reviewBody) throw new Error(`${draftId} is not one of your drafts on ${record.ref.url}.`);
    await this.#changing(record.id, async () => {
      const kept = await this.#store.getDrafts(record.id);
      const { own, paragraphs } = await this.#readBody(record, forge, kept);
      if (!paragraphs.some((paragraph) => paragraph.id === draftId)) {
        throw new Error("This comment is no longer in your pending review's body as it was written; it was edited or removed on GitHub.");
      }
      const next = change(paragraphs);
      const links = Object.fromEntries(Object.entries(kept.links).filter(([id]) => !isParagraphId(id) || next.some((paragraph) => paragraph.id === id)));
      await this.#writeBody(record, forge, own, next, links);
    });
  }

  /** A link to the node `nodeId` of the guide the panel shows, which must have it. */
  async #linkTo(record: ReviewRecord, nodeId: string): Promise<DraftLink> {
    const current = await this.#guides.shown(record);
    if (current === null) throw new Error("There is no finished guide to comment on a concept of.");
    if (!current.guide.nodes.some((node) => node.id === nodeId)) throw new Error("That concept is not in the guide any more.");
    return { nodeId, headSha: current.headSha, agentId: current.agentId };
  }

  /**
   * Follows a draft's link to a node of the guide the panel shows: the node itself when the link was
   * made in that guide, else the node covering the same code as the one it was made to in the guide
   * then shown, as marks are carried over. Null without a link, a guide, or such a node.
   */
  async #linkFollower(record: ReviewRecord): Promise<(link: DraftLink | undefined) => Promise<string | null>> {
    const current = await this.#guides.shown(record);
    const snapshot = current === null ? null : await this.#store.snapshot(record.id, current.headSha);
    if (current === null || snapshot === null) return async () => null;
    const now: GuideAtHead = { guide: current.guide, files: snapshot.files };
    const earlier = new Map<string, Promise<GuideAtHead | null>>();
    const guideOf = (link: DraftLink) => {
      const key = `${link.headSha}@${link.agentId}`;
      if (!earlier.has(key)) {
        earlier.set(
          key,
          Promise.all([this.#store.getGuide(record.id, link.headSha), this.#store.snapshot(record.id, link.headSha)]).then(([guide, at]) =>
            guide !== null && isReady(guide) && guide.agentId === link.agentId && at !== null ? { guide: guide.guide, files: at.files } : null,
          ),
        );
      }
      return earlier.get(key)!;
    };
    return async (link) => {
      if (link === undefined) return null;
      if (link.headSha === current.headSha && link.agentId === current.agentId) {
        return current.guide.nodes.some((node) => node.id === link.nodeId) ? link.nodeId : null;
      }
      const then = await guideOf(link);
      return then === null ? null : followNode(then, link.nodeId, now);
    };
  }

  /**
   * The body as the forge keeps it, split into the reviewer's own text and the node comments kept
   * here that are still in it, or on a forge that keeps none, the own text kept here and no paragraphs.
   */
  async #readBody(record: ReviewRecord, forge: Forge, kept?: DraftsRecord): Promise<{ own: string; paragraphs: BodyParagraph[] }> {
    if (!forge.reviewBody) return { own: await this.#store.getReviewBody(record.id), paragraphs: [] };
    const [body, drafts] = await Promise.all([forge.reviewBody.read(record.ref), kept ?? this.#store.getDrafts(record.id)]);
    const { own, found } = splitBody(body, drafts.paragraphs);
    return { own, paragraphs: found };
  }

  /**
   * Writes the body, the forge's first, then what is kept here about it: the paragraphs it now holds
   * and the draft links. Only ever called inside `#changing`.
   */
  async #writeBody(record: ReviewRecord, forge: Forge, own: string, paragraphs: BodyParagraph[], links: DraftsRecord["links"]): Promise<void> {
    if (forge.reviewBody) {
      await forge.reviewBody.write(await this.#reviewTarget(record), composeBody(own, paragraphs));
      await this.#store.saveDrafts(record.id, { links, paragraphs });
    } else {
      await this.#store.saveReviewBody(record.id, own);
    }
  }

  /** The change request at the review's head, which a pending review a write has to start is started on. */
  async #reviewTarget(record: ReviewRecord): Promise<DraftTarget> {
    const changeRequest = await this.#store.snapshot(record.id, record.header.headSha);
    if (changeRequest === null) throw new Error("What the forge said at this head is missing. Start the review again.");
    const { ref, baseSha, startSha, headSha } = changeRequest;
    return { ref, baseSha, startSha, headSha };
  }
}

/**
 * Why something read in the guide the panel drew at `drawnAt` is not taken at the review's `headSha`,
 * whose lines are numbered differently: `what` names it ("This comment is on"), and `redo` says
 * what to do at the new head.
 */
export function regeneratedAway(drawnAt: string, headSha: string, what = "This comment is on", redo = "Comment on"): string {
  return `${what} the guide at ${drawnAt.slice(0, 7)}, which was regenerated for ${headSha.slice(0, 7)}. ${redo} the guide at the new head.`;
}

/** A draft's text as it is saved; a blank one is turned down, as both forges would. */
function draftText(body: string): string {
  const text = body.trim();
  if (text === "") throw new Error("Write the comment before saving it.");
  return text;
}

/** A node comment in GitHub's review body, as the panel lists it beside the forge's drafts. */
function paragraphDraft(paragraph: BodyParagraph): Draft {
  return { id: paragraph.id, body: paragraph.body, location: { kind: "general" } };
}
