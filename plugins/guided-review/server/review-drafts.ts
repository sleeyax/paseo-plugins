import type { CommentOrigin, Draft, DraftList, DraftLocation, LinkedDraft } from "../shared/drafts.ts";
import { anchorAt } from "./anchors.ts";
import { followNode, type GuideAtHead } from "./carry-over.ts";
import type { DraftTarget, Forge, ReviewSubmission, SubmitOutcome } from "./forge/port.ts";
import { SubmitSteps } from "./forge/submit-steps.ts";
import { isReady, type GuideGenerations } from "./guide-generation.ts";
import { oneAtATimePer } from "./one-at-a-time.ts";
import { isParagraphId, paragraphId, type BodyParagraph } from "./review-body.ts";
import type { DraftLink, ReviewRecord, ReviewStore } from "./review-store.ts";

export type ReviewDraftsOptions = { store: ReviewStore; guides: GuideGenerations };

/**
 * The reviewer's drafts and review body, and what the plugin keeps about them: the drafts live on
 * the forge, `drafts.json` links each to the node or overview it was written from, and on GitHub,
 * which has no draft on the pull request as a whole, a general comment is kept there until a submit
 * posts it. Neither forge keeps a body before submit that the plugin can write, so the body is kept
 * here until a submit publishes it.
 *
 * Every read-modify-write of `drafts.json` goes through `#changing`, one at a time per review.
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
   * on the web. On GitHub the general comments kept here are drafts too. Each comes
   * with the part of the guide the panel shows that it was written from, when it was written from one,
   * and the passage the reviewer highlighted for it.
   */
  async list(record: ReviewRecord, forge: Forge): Promise<DraftList> {
    const [drafts, kept] = await Promise.all([forge.listDrafts(record.ref), this.#store.getDrafts(record.id)]);
    const follow = await this.#linkFollower(record);
    const all = [...drafts, ...kept.paragraphs.map(paragraphDraft)];
    return { drafts: await Promise.all(all.map(async (draft) => ({ ...draft, ...(await follow(kept.links[draft.id])) }))) };
  }

  /**
   * Saves a comment on the forge as a draft at once, at `location` in the diff the panel drew at
   * `drawnAt`, which must still be the review's head: Regenerate moves the review to a new head, whose
   * lines are numbered differently, so a comment from a guide it replaced is refused rather than put
   * on whatever line now has its number. It is linked to the node or overview `from` of the guide the
   * panel shows when it was written from one, with the passage `quote` the reviewer highlighted there.
   * A `general` comment, on the change as a whole, is a comment on a node or on the overview: an
   * MR-level draft note on GitLab, and on GitHub a comment kept here until submit.
   */
  async create(
    record: ReviewRecord,
    forge: Forge,
    {
      drawnAt,
      location,
      body,
      from,
      quote,
    }: { drawnAt: string; location: DraftLocation; body: string; from: CommentOrigin | null; quote: string | null },
  ): Promise<LinkedDraft> {
    const text = draftText(body);
    const passage = quote?.trim() || null;
    if (drawnAt !== record.header.headSha) throw new Error(regeneratedAway(drawnAt, record.header.headSha));
    if (passage !== null && from === null) throw new Error("A highlighted passage has to come from the guide's overview or one of its concepts.");
    const changeRequest = await this.#store.snapshot(record.id, record.header.headSha);
    if (changeRequest === null) throw new Error("What the forge said at this head is missing. Start the review again.");
    const anchor = anchorAt(changeRequest.files, location);
    const link = from === null ? null : await this.#linkTo(record, from, passage);
    const { ref, baseSha, startSha, headSha } = changeRequest;

    if (anchor.kind === "general" && !forge.takesGeneralDrafts) {
      const paragraph: BodyParagraph = { id: paragraphId(), body: text };
      return this.#changing(record.id, async () => {
        const kept = await this.#store.getDrafts(record.id);
        const links = link === null ? kept.links : { ...kept.links, [paragraph.id]: link };
        await this.#store.saveDrafts(record.id, { links, paragraphs: [...kept.paragraphs, paragraph] });
        return { ...paragraphDraft(paragraph), ...fresh(link) };
      });
    }

    const draft = await forge.createDraft({ ref, baseSha, startSha, headSha }, { anchor, body: text });
    if (link !== null) {
      await this.#changing(record.id, async () => {
        const kept = await this.#store.getDrafts(record.id);
        await this.#store.saveDrafts(record.id, { ...kept, links: { ...kept.links, [draft.id]: link } });
      });
    }
    return { ...draft, ...fresh(link) };
  }

  async update(record: ReviewRecord, forge: Forge, draftId: string, body: string): Promise<void> {
    const text = draftText(body);
    if (!isParagraphId(draftId)) return forge.updateDraft(record.ref, draftId, text);
    await this.#changingParagraphs(record, draftId, (paragraphs) =>
      paragraphs.map((paragraph) => (paragraph.id === draftId ? { ...paragraph, body: text } : paragraph)),
    );
  }

  async delete(record: ReviewRecord, forge: Forge, draftId: string): Promise<void> {
    if (isParagraphId(draftId)) {
      return this.#changingParagraphs(record, draftId, (paragraphs) => paragraphs.filter((paragraph) => paragraph.id !== draftId));
    }
    await forge.deleteDraft(record.ref, draftId);
    await this.#changing(record.id, async () => {
      const kept = await this.#store.getDrafts(record.id);
      if (!(draftId in kept.links)) return;
      const { [draftId]: _gone, ...links } = kept.links;
      await this.#store.saveDrafts(record.id, { ...kept, links });
    });
  }

  /** The review body so far, the reviewer's own text, without GitHub's general comments. */
  async ownBody(record: ReviewRecord): Promise<string> {
    return this.#store.getReviewBody(record.id);
  }

  /** Replaces the reviewer's own text of the body; a submit keeps it here first, so a refused or failed one loses none of it. */
  async saveOwnBody(record: ReviewRecord, body: string): Promise<void> {
    await this.#store.saveReviewBody(record.id, body);
  }

  /**
   * Submits the review with `verdict`: GitHub's general comments first, each a comment of its own,
   * then the drafts and the reviewer's own text as the review. A comment is dropped from what is kept
   * here as soon as it is posted, and the first that fails stops the submit, so trying again posts
   * none twice. Once the forge says the review is published, nothing kept here is wanted any more.
   */
  async submit(record: ReviewRecord, forge: Forge, submission: ReviewSubmission): Promise<SubmitOutcome> {
    const { verdict, body } = submission;
    const outcome = await this.#changing(record.id, async () => {
      const steps = new SubmitSteps();
      let kept = await this.#store.getDrafts(record.id);
      const comments = kept.paragraphs;
      for (const [index, paragraph] of comments.entries()) {
        if (!(await steps.run("comment", postLabel(paragraph), () => forge.postComment(record.ref, paragraph.body))).ok) {
          for (const rest of comments.slice(index + 1)) steps.skip("comment", postLabel(rest), "Not tried, since a comment before it was not posted.");
          steps.skip("submit", "Publish the review", "Not tried, since a comment was not posted.");
          return { published: false, steps: steps.steps };
        }
        const { [paragraph.id]: _posted, ...links } = kept.links;
        kept = { links, paragraphs: kept.paragraphs.filter((candidate) => candidate.id !== paragraph.id) };
        await this.#store.saveDrafts(record.id, kept);
      }
      // GitHub turns down a Comment review with nothing in it, and the comments already said it all.
      if (comments.length > 0 && verdict === "comment" && body === "" && (await forge.listDrafts(record.ref)).length === 0) {
        await forge.discardReview(record.ref);
        return { published: true, steps: steps.steps };
      }
      const outcome = await forge.submitReview(await this.#reviewTarget(record), submission);
      if (outcome.published) await this.#store.saveDrafts(record.id, { links: {}, paragraphs: [] });
      return { published: outcome.published, steps: [...steps.steps, ...outcome.steps] };
    });
    if (outcome.published) await this.saveOwnBody(record, "");
    return outcome;
  }

  /** Throws the pending review away with its drafts and body. */
  async discard(record: ReviewRecord, forge: Forge): Promise<void> {
    await this.#changing(record.id, async () => {
      await forge.discardReview(record.ref);
      await this.#store.saveDrafts(record.id, { links: {}, paragraphs: [] });
    });
    await this.saveOwnBody(record, "");
  }

  /** Rewrites GitHub's general comments kept here, one of which is `draftId`. */
  async #changingParagraphs(record: ReviewRecord, draftId: string, change: (paragraphs: BodyParagraph[]) => BodyParagraph[]): Promise<void> {
    await this.#changing(record.id, async () => {
      const kept = await this.#store.getDrafts(record.id);
      if (!kept.paragraphs.some((paragraph) => paragraph.id === draftId)) throw new Error(`${draftId} is not one of your drafts on ${record.ref.url}.`);
      const paragraphs = change(kept.paragraphs);
      const links = Object.fromEntries(Object.entries(kept.links).filter(([id]) => !isParagraphId(id) || paragraphs.some((paragraph) => paragraph.id === id)));
      await this.#store.saveDrafts(record.id, { links, paragraphs });
    });
  }

  /** A link to `from` in the guide the panel shows, which must have it, with the passage `quote` highlighted there. */
  async #linkTo(record: ReviewRecord, from: CommentOrigin, quote: string | null): Promise<DraftLink> {
    const current = await this.#guides.shown(record);
    if (current === null) throw new Error("There is no finished guide to comment on.");
    if (from.kind === "node" && !current.guide.nodes.some((node) => node.id === from.nodeId)) throw new Error("That concept is not in the guide any more.");
    return { from, ...(quote === null ? {} : { quote }), headSha: current.headSha, agentId: current.agentId };
  }

  /**
   * Follows a draft's link to the part of the guide the panel shows it came from: the overview, the
   * node itself when the link was made in that guide, else the node covering the same code as the one
   * it was made to in the guide then shown, as marks are carried over. No origin without a link, a
   * guide, or such a node. A highlighted passage stays with the draft, marked as from an earlier guide
   * when it was highlighted in another than the one shown.
   */
  async #linkFollower(record: ReviewRecord): Promise<(link: DraftLink | undefined) => Promise<Linked>> {
    const current = await this.#guides.shown(record);
    const snapshot = current === null ? null : await this.#store.snapshot(record.id, current.headSha);
    if (current === null || snapshot === null) return async (link) => ({ from: null, quote: quoteOf(link, true) });
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
    const follow = async (link: DraftLink, same: boolean): Promise<CommentOrigin | null> => {
      if (link.from.kind === "overview") return link.from;
      const { nodeId } = link.from;
      if (same) return current.guide.nodes.some((node) => node.id === nodeId) ? link.from : null;
      const then = await guideOf(link);
      const followed = then === null ? null : followNode(then, nodeId, now);
      return followed === null ? null : { kind: "node", nodeId: followed };
    };
    return async (link) => {
      if (link === undefined) return { from: null, quote: null };
      const same = link.headSha === current.headSha && link.agentId === current.agentId;
      return { from: await follow(link, same), quote: quoteOf(link, !same) };
    };
  }

  /** The change request at the review's head, which a submit with no pending review starts one on. */
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

/** What a draft's link says about it in the panel's listing. */
type Linked = Pick<LinkedDraft, "from" | "quote">;

/** A link just made, in the guide the panel shows. */
function fresh(link: DraftLink | null): Linked {
  return { from: link?.from ?? null, quote: quoteOf(link ?? undefined, false) };
}

function quoteOf(link: DraftLink | undefined, earlier: boolean): LinkedDraft["quote"] {
  return link?.quote === undefined ? null : { text: link.quote, earlier };
}

/** A general comment GitHub will get at submit, as the panel lists it beside the forge's drafts. */
function paragraphDraft(paragraph: BodyParagraph): Draft {
  return { id: paragraph.id, body: paragraph.body, location: { kind: "general" } };
}

/** A submit step posting `paragraph`, named by its start. */
function postLabel(paragraph: BodyParagraph): string {
  const line = paragraph.body.split("\n")[0]!.trim();
  const excerpt = line.length > 60 || paragraph.body.includes("\n") ? `${line.slice(0, 60).trimEnd()}…` : line;
  return `Post your comment "${excerpt}"`;
}
