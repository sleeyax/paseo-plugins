import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { createContext, useContext, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { describeLocation, pathOf, type DraftList, type DraftLocation, type LinkedDraft } from "../shared/drafts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import type { CommentSubject } from "../shared/contracts.ts";
import { BoxButton, CommentBox, type CommentBoxAction } from "./comment-box.tsx";
import { fontSize, leading, radius, spacing } from "./theme.ts";

type Colors = PluginTheme["colors"];

/**
 * Where in the panel a comment box is open. The same line can be drawn twice (two nodes may cover
 * one file), so a box belongs to the place that opened it, not only to its location.
 */
export type OpenBox = { kind: "new"; place: string; location: DraftLocation } | { kind: "edit"; place: string; draftId: string };

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
  /** Saves a comment; `nodeId` is the node it was written from, which the panel groups it under. */
  create: (location: DraftLocation, body: string, nodeId: string | null) => Promise<void>;
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
    create: async (location, body, nodeId) => {
      const draft = await createDraft({ reviewId, headSha, location, body, nodeId });
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
 * is linked to the node whose code the box is drawn in, or for a node's own comment (a `general`
 * location) to `nodeId`.
 */
export function NewCommentBox({
  control,
  location,
  colors,
  nodeId,
}: {
  control: DraftsControl;
  location: DraftLocation;
  colors: Colors;
  nodeId?: string;
}) {
  const drawnIn = useContext(CommentNodeContext);
  const node = nodeId ?? drawnIn;
  const subject = subjectOf(location, node);
  return (
    <CommentBox
      colors={colors}
      title={location.kind === "general" ? "Comment on this concept, posted on the change as a whole" : `Comment on ${describeLocation(location)}`}
      onSave={(body) => control.create(location, body, node)}
      onCancel={() => control.setOpen(null)}
      actions={subject === null ? [] : [suggestWordingAction(control, subject)]}
    />
  );
}

/** What "Suggest wording" words a comment at `location` from: its code, or for a general one, its node. */
function subjectOf(location: DraftLocation, nodeId: string | null): CommentSubject | null {
  if (location.kind !== "general") return { kind: "code", location };
  return nodeId === null ? null : { kind: "node", nodeId };
}

/** Where a draft is, for its card: its place in a file, or for a general draft, the node it was written from. */
function whereOf(draft: LinkedDraft, titles: ReadonlyMap<string, string>, showPath: boolean): string {
  if (draft.location.kind === "general") {
    const title = draft.nodeId === null ? undefined : titles.get(draft.nodeId);
    return title === undefined ? "Your draft on the change as a whole" : `Your comment on the concept "${title}"`;
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
    const subject = subjectOf(draft.location, draft.nodeId);
    return (
      <CommentBox
        colors={colors}
        title={`Edit ${where}`}
        initialBody={draft.body}
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
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
        {draft.body}
      </Text>
      {error ? <Text style={{ ...small, color: colors.statusDanger }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing[2] }}>
        {confirming ? (
          <>
            <Text style={{ ...small, color: colors.foreground }}>Delete this draft?</Text>
            <BoxButton colors={colors} label={deleting ? "Deleting…" : "Delete"} disabled={deleting} onPress={() => void remove()} />
            <BoxButton colors={colors} label="Keep" disabled={deleting} onPress={() => setConfirming(false)} />
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
 * The drafts grouped under the node each was written from, in the guide's order, then the ones
 * written from no node of this guide: started on the web, on a Supporting or Unsorted file, or from
 * a node a Regenerate changed the code of. Within a group, the forge's order.
 */
export function groupByNode(
  drafts: readonly LinkedDraft[],
  titles: ReadonlyMap<string, string>,
): { groups: { nodeId: string; title: string; drafts: LinkedDraft[] }[]; unlinked: LinkedDraft[] } {
  const groups = [...titles].map(([nodeId, title]) => ({ nodeId, title, drafts: drafts.filter((draft) => draft.nodeId === nodeId) }));
  return {
    groups: groups.filter((group) => group.drafts.length > 0),
    unlinked: drafts.filter((draft) => draft.nodeId === null || !titles.has(draft.nodeId)),
  };
}

/**
 * A node's own comments, on the change as a whole, and the action that writes one: under the node's
 * card, where the reviewer reads the concept. Nothing outside a review.
 */
export function NodeComments({ nodeId, colors }: { nodeId: string; colors: Colors }) {
  const control = useContext(DraftsContext);
  if (control === null) return null;
  const place = `node:${nodeId}`;
  const comments = control.drafts.filter((draft) => draft.nodeId === nodeId && draft.location.kind === "general");
  const box = control.open?.kind === "new" && control.open.place === place ? control.open : null;
  return (
    <View style={{ gap: spacing[2] }}>
      {comments.map((draft) => (
        <DraftCard key={draft.id} control={control} draft={draft} place={place} colors={colors} />
      ))}
      {box ? (
        <NewCommentBox control={control} location={box.location} colors={colors} nodeId={nodeId} />
      ) : (
        <View style={{ alignItems: "flex-start" }}>
          <TextLink colors={colors} label="Comment on this concept" onPress={() => control.setOpen({ kind: "new", place, location: { kind: "general" } })} />
        </View>
      )}
    </View>
  );
}

/** Every draft of the review, grouped by the node it was written from, above the guide. */
export function DraftsSection({ control, colors }: { control: DraftsControl; colors: Colors }) {
  const body = { fontSize: fontSize.base, lineHeight: leading(fontSize.base) };
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  const count = control.drafts.length;
  const { groups, unlinked } = groupByNode(control.drafts, control.titles);
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
          comment on a whole file from its header, or on a concept from its card.
        </Text>
      ) : (
        <>
          <Text style={{ ...body, color: colors.foregroundMuted }}>Saved on the forge, unpublished until the review is submitted.</Text>
          {groups.map((group) => (
            <View key={group.nodeId} style={{ gap: spacing[2] }}>
              <Text style={{ ...small, color: colors.foreground, fontWeight: "600" }}>{group.title}</Text>
              {group.drafts.map((draft) => (
                <DraftCard key={draft.id} control={control} draft={draft} place="list" colors={colors} showPath />
              ))}
            </View>
          ))}
          {unlinked.length > 0 ? (
            <View style={{ gap: spacing[2] }}>
              {groups.length > 0 ? (
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
