import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { createContext, useContext, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { describeLocation, pathOf, type CommentOrigin, type DraftList, type DraftLocation, type LinkedDraft } from "../shared/drafts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import type { CommentSubject } from "../shared/contracts.ts";
import { CommentBox, Quote, type CommentBoxAction } from "./comment-box.tsx";
import { GuideText } from "./guide-text.tsx";
import { plainText } from "./inline-markdown.ts";
import { HIGHLIGHTS_TEXT } from "./text-selection.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";
import { Button } from "./button.tsx";

/**
 * Where in the panel a comment box is open. The same line can be drawn twice (two nodes may cover
 * one file), so a box belongs to the place that opened it, not only to its location. A new comment
 * on text the reviewer highlighted in the guide carries that text as its `quote`, and the `item`
 * of its card it opens under (see `Selected`); one that opened on its own when the reviewer let go
 * of the highlight has `keepSelection`, so it leaves the highlight in place to copy rather than
 * taking focus.
 */
export type OpenBox =
  | { kind: "new"; place: string; location: DraftLocation; quote?: string; item?: string | undefined; keepSelection?: boolean }
  | { kind: "edit"; place: string; draftId: string };

/**
 * The reviewer's drafts and what the panel does with them, shared through `DraftsContext` so the
 * diff view deep inside the guide reaches them without every component in between passing them on.
 * Only one comment box is open at a time.
 */
export type DraftsControl = {
  drafts: readonly LinkedDraft[];
  loading: boolean;
  /** Why the drafts could not be read, as a sentence. */
  error: string | null;
  refresh: () => void;
  /**
   * Saves a comment; `from` is the node or overview it was written from, which the panel groups it
   * under, and `quote` the text highlighted there to comment on.
   */
  create: (location: DraftLocation, body: string, from: CommentOrigin | null, quote?: string) => Promise<void>;
  /** The title of a node of the guide the panel shows, in the guide's order; empty until it is ready. */
  titles: ReadonlyMap<string, string>;
  update: (draftId: string, body: string) => Promise<void>;
  remove: (draftId: string) => Promise<void>;
  /**
   * The guide agent's wording for a comment on `subject`, from what the reviewer `typed`. Throws the
   * reason, as a sentence, when there is none; saves nothing.
   */
  suggestWording: (subject: CommentSubject, typed: string) => Promise<string>;
  open: OpenBox | null;
  setOpen: (box: OpenBox | null) => void;
};

/** Null outside a review, where the diff view offers no commenting. */
export const DraftsContext = createContext<DraftsControl | null>(null);

/**
 * The node whose code is drawn here, which a comment written on it is linked to; null in a
 * Supporting or Unsorted entry, whose comments belong to no node.
 */
export const CommentNodeContext = createContext<string | null>(null);

/** The guide the panel shows, as far as drafts need it: its agent, since a new one means new node IDs, and its nodes. */
export type DraftsGuide = { agentId: string; nodes: readonly { id: string; title: string }[] };

/**
 * `headSha` is the head of the guide the panel shows, whose diff every comment's lines are read in.
 * A guide regenerated for a new head lists the drafts again, where the forge now puts them, and
 * closes a box opened on the old guide. So does a guide written again at the same head, whose
 * nodes the drafts' links are followed to afresh.
 */
export function useDrafts(reviewId: string | null, headSha: string | null, guide: DraftsGuide | null = null): DraftsControl | null {
  const listDrafts = useRpc(contracts.listDrafts);
  const createDraft = useRpc(contracts.createDraft);
  const updateDraft = useRpc(contracts.updateDraft);
  const deleteDraft = useRpc(contracts.deleteDraft);
  const suggestWording = useRpc(contracts.suggestWording);
  const getSuggestion = useRpc(contracts.getSuggestion);
  const queryClient = useQueryClient();
  const drawn = `${headSha}@${guide?.agentId ?? ""}`;
  const queryKey = [PLUGIN_ID, "drafts", reviewId, drawn];
  const query = useQuery({
    queryKey,
    queryFn: () => listDrafts({ reviewId: reviewId! }),
    enabled: reviewId !== null,
  });
  const [opened, setOpened] = useState<{ drawn: string; box: OpenBox } | null>(null);
  const nodes = guide?.nodes;
  const titles = useMemo(() => new Map((nodes ?? []).map((node) => [node.id, node.title])), [nodes]);
  if (reviewId === null || headSha === null) return null;
  const open = opened !== null && opened.drawn === drawn ? opened.box : null;
  const setOpen = (box: OpenBox | null) => setOpened(box === null ? null : { drawn, box });

  // Writes land in the cache as the forge answered them, rather than waiting on a fresh listing.
  const change = (update: (drafts: LinkedDraft[]) => LinkedDraft[]) =>
    queryClient.setQueryData<DraftList>(queryKey, (current) => ({ drafts: update(current?.drafts ?? []) }));

  return {
    drafts: query.data?.drafts ?? [],
    loading: query.isPending,
    error: query.isError ? (query.error instanceof Error ? query.error.message : String(query.error)) : null,
    refresh: () => void query.refetch(),
    titles,
    create: async (location, body, from, quote) => {
      const draft = await createDraft({ reviewId, headSha, location, body, from, quote: quote ?? null });
      change((drafts) => [...drafts, draft]);
      setOpen(null);
    },
    update: async (draftId, body) => {
      await updateDraft({ reviewId, draftId, body });
      change((drafts) => drafts.map((draft) => (draft.id === draftId ? { ...draft, body } : draft)));
      setOpen(null);
    },
    remove: async (draftId) => {
      await deleteDraft({ reviewId, draftId });
      change((drafts) => drafts.filter((draft) => draft.id !== draftId));
    },
    suggestWording: async (subject, typed) => {
      // The agent's turn can outlast an RPC, so the server runs it as a job this follows.
      let suggestion = await suggestWording({ reviewId, headSha, subject, prompt: typed });
      while (suggestion.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, SUGGESTION_POLL_MS));
        suggestion = await getSuggestion({ suggestionId: suggestion.suggestionId });
      }
      if (suggestion.status === "failed") throw new Error(suggestion.message);
      return suggestion.body;
    },
    open,
    setOpen,
  };
}

/**
 * The box for a new comment at `location`. Every comment box in the panel is opened through this
 * or `DraftCard`, which is where actions for all of them, like "Suggest wording", go. The comment
 * is linked to the node whose code the box is drawn in, or for a general comment to `from`, with
 * the `quote` highlighted there.
 */
export function NewCommentBox({
  control,
  location,
  colors,
  from,
  quote,
  keepSelection,
}: {
  control: DraftsControl;
  location: DraftLocation;
  colors: Colors;
  from?: CommentOrigin;
  quote?: string;
  keepSelection?: boolean;
}) {
  const drawnIn = useContext(CommentNodeContext);
  const origin: CommentOrigin | null = from ?? (drawnIn === null ? null : { kind: "node", nodeId: drawnIn });
  const subject = subjectOf(location, origin, quote);
  const title =
    location.kind !== "general"
      ? `Comment on ${describeLocation(location)}`
      : quote !== undefined
        ? "Comment on the highlighted text, posted on the change as a whole"
        : "Comment on this concept, posted on the change as a whole";
  return (
    <CommentBox
      colors={colors}
      title={title}
      quote={quote}
      autoFocus={!keepSelection}
      onSave={(body) => control.create(location, body, origin, quote)}
      onCancel={() => control.setOpen(null)}
      actions={subject === null ? [] : [suggestWordingAction(control, subject)]}
    />
  );
}

/** The node a draft was written from; null for one from the overview or from no part of the guide. */
function nodeOf(draft: LinkedDraft): string | null {
  return draft.from?.kind === "node" ? draft.from.nodeId : null;
}

/**
 * What "Suggest wording" words a comment at `location` from: its code, or for a general one, the
 * node or overview it came from with the text highlighted there. The overview is worded only from
 * highlighted text, which every comment on it has.
 */
function subjectOf(location: DraftLocation, from: CommentOrigin | null, quote: string | undefined): CommentSubject | null {
  if (location.kind !== "general") return { kind: "code", location };
  if (from?.kind === "node") return { kind: "node", nodeId: from.nodeId, quote: quote ?? null };
  return from?.kind === "overview" && quote !== undefined ? { kind: "overview", quote } : null;
}

/** Where a draft is, for its card: its place in a file, or for a general draft, the part of the guide it was written from. */
function whereOf(draft: LinkedDraft, titles: ReadonlyMap<string, string>, showPath: boolean): string {
  if (draft.location.kind === "general") {
    if (draft.from?.kind === "overview") return "Your comment on the overview";
    const nodeId = nodeOf(draft);
    const title = nodeId === null ? undefined : titles.get(nodeId);
    return title === undefined ? "Your draft on the change as a whole" : `Your comment on the concept "${plainText(title)}"`;
  }
  const path = pathOf(draft.location);
  return showPath && path !== null ? `${path} · ${describeLocation(draft.location)}` : `Your draft on ${describeLocation(draft.location)}`;
}

/** How often a comment box asks whether the guide agent has worded its comment yet. */
const SUGGESTION_POLL_MS = 1000;

/**
 * "Suggest wording": the guide agent words the comment from where it goes and what the reviewer
 * typed, and the box gets the result to edit. A failure is shown in the box, which keeps the text.
 */
export function suggestWordingAction(control: DraftsControl, subject: CommentSubject): CommentBoxAction {
  return { label: "Suggest wording", runningLabel: "Suggesting…", run: (body) => control.suggestWording(subject, body) };
}

/** A draft, with its edit and delete; editing swaps it for a comment box in the same place. */
export function DraftCard({
  control,
  draft,
  place,
  colors,
  showPath,
}: {
  control: DraftsControl;
  draft: LinkedDraft;
  /** Where this card is drawn, so its edit box opens here and not wherever else the draft shows. */
  place: string;
  colors: Colors;
  /** Name the file too, as the list does; beside its line in the diff the file goes without saying. */
  showPath?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = whereOf(draft, control.titles, showPath ?? false);
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  const open = control.open;

  if (open?.kind === "edit" && open.draftId === draft.id && open.place === place) {
    const subject = subjectOf(draft.location, draft.from, draft.quote?.text);
    return (
      <CommentBox
        colors={colors}
        title={`Edit ${where}`}
        initialBody={draft.body}
        quote={draft.quote?.text}
        onSave={(body) => control.update(draft.id, body)}
        onCancel={() => control.setOpen(null)}
        actions={subject === null ? [] : [suggestWordingAction(control, subject)]}
      />
    );
  }

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await control.remove(draft.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <View
      style={{
        gap: spacing[1],
        padding: spacing[2],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Text style={{ ...small, color: colors.foregroundMuted }}>{where}</Text>
      {draft.quote ? <Quote colors={colors} text={draft.quote.text} earlier={draft.quote.earlier} /> : null}
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
        {draft.body}
      </Text>
      {error ? <Text style={{ ...small, color: colors.statusDanger }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing[2] }}>
        {confirming ? (
          <>
            <Text style={{ ...small, color: colors.foreground }}>Delete this draft?</Text>
            <Button small colors={colors} label={deleting ? "Deleting…" : "Delete"} disabled={deleting} onPress={() => void remove()} />
            <Button small colors={colors} label="Keep" disabled={deleting} onPress={() => setConfirming(false)} />
          </>
        ) : (
          <>
            <TextLink colors={colors} label="Edit" onPress={() => control.setOpen({ kind: "edit", place, draftId: draft.id })} />
            <TextLink colors={colors} label="Delete" onPress={() => setConfirming(true)} />
          </>
        )}
      </View>
    </View>
  );
}

/**
 * The drafts written from the overview, then the ones grouped under the node each was written from,
 * in the guide's order, then the ones written from no part of this guide: started on the web, on a
 * Supporting or Unsorted file, or from a node a Regenerate changed the code of. Within a group, the
 * forge's order.
 */
export function groupDrafts(
  drafts: readonly LinkedDraft[],
  titles: ReadonlyMap<string, string>,
): { overview: LinkedDraft[]; groups: { nodeId: string; title: string; drafts: LinkedDraft[] }[]; unlinked: LinkedDraft[] } {
  const groups = [...titles].map(([nodeId, title]) => ({ nodeId, title, drafts: drafts.filter((draft) => nodeOf(draft) === nodeId) }));
  return {
    overview: drafts.filter((draft) => draft.from?.kind === "overview"),
    groups: groups.filter((group) => group.drafts.length > 0),
    unlinked: drafts.filter((draft) => {
      if (draft.from?.kind === "overview") return false;
      const nodeId = nodeOf(draft);
      return nodeId === null || !titles.has(nodeId);
    }),
  };
}

/**
 * Text of the guide the reviewer highlighted, or held in the phone app, to comment on, with the key
 * of the paragraph or bullet of its card it ends in, which the box opens under; without one, the
 * box opens at the foot of the card.
 */
export type Selected = { text: string; item?: string | undefined };

/**
 * A node's own comments, on the change as a whole, and the actions that write one: on the concept,
 * or on the text of its card the reviewer has `selected`. Under the node's card, where the reviewer
 * reads the concept. Nothing outside a review.
 */
export function NodeComments({ nodeId, colors, selected }: { nodeId: string; colors: Colors; selected: Selected | null }) {
  const control = useContext(DraftsContext);
  if (control === null) return null;
  const from: CommentOrigin = { kind: "node", nodeId };
  const comments = control.drafts.filter((draft) => nodeOf(draft) === nodeId && draft.location.kind === "general");
  const box = boxAt(control, from, undefined);
  return (
    <View style={{ gap: spacing[2] }}>
      {comments.map((draft) => (
        <DraftCard key={draft.id} control={control} draft={draft} place={placeOf(from)} colors={colors} />
      ))}
      {box ? (
        <FromBox control={control} box={box} from={from} colors={colors} />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[3] }}>
          <TextLink colors={colors} label="Comment on this concept" onPress={() => control.setOpen({ kind: "new", place: placeOf(from), location: { kind: "general" } })} />
          {selected === null ? null : <CommentOnSelection colors={colors} onOpen={() => openOn(control, from, selected)} />}
        </View>
      )}
    </View>
  );
}

/**
 * The comments on the overview, and the action that writes one on the text of it the reviewer has
 * `selected`, which is the only way to write one. Nothing outside a review, or with neither.
 */
export function OverviewComments({ colors, selected }: { colors: Colors; selected: Selected | null }) {
  const control = useContext(DraftsContext);
  if (control === null) return null;
  const from: CommentOrigin = { kind: "overview" };
  const comments = control.drafts.filter((draft) => draft.from?.kind === "overview");
  const box = boxAt(control, from, undefined);
  if (comments.length === 0 && box === null && selected === null) return null;
  return (
    <View style={{ gap: spacing[2] }}>
      {comments.map((draft) => (
        <DraftCard key={draft.id} control={control} draft={draft} place={placeOf(from)} colors={colors} />
      ))}
      {box ? (
        <FromBox control={control} box={box} from={from} colors={colors} />
      ) : selected === null ? null : (
        <CommentOnSelection colors={colors} onOpen={() => openOn(control, from, selected)} />
      )}
    </View>
  );
}

/**
 * The box for a comment on text of `from` that ends in the paragraph or bullet `item`, drawn under
 * it when it is open; `boxRef` gets the element around it.
 */
export function ItemCommentBox({
  from,
  item,
  colors,
  boxRef,
}: {
  from: CommentOrigin;
  item: string;
  colors: Colors;
  boxRef: (element: unknown) => void;
}) {
  const control = useContext(DraftsContext);
  const box = control === null ? null : boxAt(control, from, item);
  if (control === null || box === null) return null;
  return (
    <View ref={boxRef}>
      <FromBox control={control} box={box} from={from} colors={colors} />
    </View>
  );
}

type NewBox = Extract<OpenBox, { kind: "new" }>;

/** The new comment's box open on `from`, under its paragraph or bullet `item` or, without one, at the foot of its card. */
function boxAt(control: DraftsControl, from: CommentOrigin, item: string | undefined): NewBox | null {
  const open = control.open;
  return open?.kind === "new" && open.place === placeOf(from) && open.item === item ? open : null;
}

function FromBox({ control, box, from, colors }: { control: DraftsControl; box: NewBox; from: CommentOrigin; colors: Colors }) {
  return <NewCommentBox control={control} location={box.location} colors={colors} from={from} quote={box.quote} keepSelection={box.keepSelection} />;
}

function openOn(control: DraftsControl, from: CommentOrigin, { text, item }: Selected, keepSelection?: boolean): void {
  control.setOpen({ kind: "new", place: placeOf(from), location: { kind: "general" }, quote: text, item, ...(keepSelection ? { keepSelection } : {}) });
}

/** Where the general comments from `from` are listed, and their box opens. */
function placeOf(from: CommentOrigin): string {
  return from.kind === "overview" ? "overview" : `node:${from.nodeId}`;
}

/**
 * Opens the box for a comment on a whole paragraph or bullet of `from`'s text, which the phone app
 * offers on a long press, since it cannot tell what is highlighted. Null on the web and outside a review.
 */
export function useCommentOnHold(from: CommentOrigin): ((held: Selected) => void) | null {
  const control = useContext(DraftsContext);
  if (control === null || HIGHLIGHTS_TEXT) return null;
  return (held) => openOn(control, from, held);
}

/**
 * Opens the box for a comment on text of `from` the reviewer highlighted and let go of, or points
 * the one already open on a highlight in the same paragraph or bullet at it, which keeps what was
 * typed. Any other open box is left alone, since replacing or moving it would throw its text away.
 * Null outside a review.
 */
export function useCommentOnRelease(from: CommentOrigin): ((released: Selected) => void) | null {
  const control = useContext(DraftsContext);
  if (control === null) return null;
  return (released) => {
    if (control.open !== null && boxAt(control, from, released.item)?.quote === undefined) return;
    openOn(control, from, released, true);
  };
}

/** Opens on press-in: pressing anywhere clears the selection, which hides this link before a press could end. */
function CommentOnSelection({ colors, onOpen }: { colors: Colors; onOpen: () => void }) {
  return (
    <Pressable onPressIn={onOpen} accessibilityRole="button" hitSlop={4} style={{ alignSelf: "flex-start" }}>
      <Text style={{ color: colors.accent, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), fontWeight: "600" }}>Comment on selection</Text>
    </Pressable>
  );
}

/** Every draft of the review, grouped by the node it was written from, above the guide. */
export function DraftsSection({ control, colors }: { control: DraftsControl; colors: Colors }) {
  const body = { fontSize: fontSize.base, lineHeight: leading(fontSize.base) };
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  const count = control.drafts.length;
  const { overview, groups, unlinked } = groupDrafts(control.drafts, control.titles);
  const grouped = [...(overview.length > 0 ? [{ key: "overview", title: "Overview", drafts: overview }] : []), ...groups.map((group) => ({ key: group.nodeId, ...group }))];
  return (
    <View
      style={{
        gap: spacing[2],
        padding: spacing[4],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing[2] }}>
        <Text style={{ ...body, color: colors.foreground, fontWeight: "600" }}>
          Your drafts{count > 0 ? ` (${count})` : ""}
        </Text>
        <TextLink colors={colors} label="Refresh" onPress={control.refresh} />
      </View>
      {control.loading ? (
        <Text style={{ ...body, color: colors.foregroundMuted }}>Reading your drafts…</Text>
      ) : control.error ? (
        <Text style={{ ...body, color: colors.statusDanger }}>{control.error}</Text>
      ) : count === 0 ? (
        <Text style={{ ...body, color: colors.foregroundMuted }}>
          No drafts yet. Tap a line of a diff below to comment on it, drag across lines for a range (on a phone, hold first),
          comment on a whole file from its header, or on a concept from its card{HIGHLIGHTS_TEXT ? ", or highlight text in the guide to comment on it" : ", or hold a paragraph of the guide to comment on it"}.
        </Text>
      ) : (
        <>
          <Text style={{ ...body, color: colors.foregroundMuted }}>Saved on the forge, unpublished until the review is submitted.</Text>
          {grouped.map((group) => (
            <View key={group.key} style={{ gap: spacing[2] }}>
              <Text style={{ ...small, color: colors.foreground, fontWeight: "600" }}>
                <GuideText text={group.title} colors={colors} />
              </Text>
              {group.drafts.map((draft) => (
                <DraftCard key={draft.id} control={control} draft={draft} place="list" colors={colors} showPath />
              ))}
            </View>
          ))}
          {unlinked.length > 0 ? (
            <View style={{ gap: spacing[2] }}>
              {grouped.length > 0 ? (
                <Text style={{ ...small, color: colors.foreground, fontWeight: "600" }}>Not from a concept of this guide</Text>
              ) : null}
              {unlinked.map((draft) => (
                <DraftCard key={draft.id} control={control} draft={draft} place="list" colors={colors} showPath />
              ))}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

export function TextLink({ colors, label, onPress }: { colors: Colors; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={4}>
      <Text style={{ color: colors.accent, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{label}</Text>
    </Pressable>
  );
}
