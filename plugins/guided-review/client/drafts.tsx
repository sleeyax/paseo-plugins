import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { createContext, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { describeLocation, type Draft, type DraftList, type DraftLocation } from "../shared/drafts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { BoxButton, CommentBox } from "./comment-box.tsx";
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
  drafts: readonly Draft[];
  loading: boolean;
  /** Why the drafts could not be read, as a sentence. */
  error: string | null;
  refresh: () => void;
  create: (location: DraftLocation, body: string) => Promise<void>;
  update: (draftId: string, body: string) => Promise<void>;
  remove: (draftId: string) => Promise<void>;
  open: OpenBox | null;
  setOpen: (box: OpenBox | null) => void;
};

/** Null outside a review, where the diff view offers no commenting. */
export const DraftsContext = createContext<DraftsControl | null>(null);

export function useDrafts(reviewId: string | null): DraftsControl | null {
  const listDrafts = useRpc(contracts.listDrafts);
  const createDraft = useRpc(contracts.createDraft);
  const updateDraft = useRpc(contracts.updateDraft);
  const deleteDraft = useRpc(contracts.deleteDraft);
  const queryClient = useQueryClient();
  const queryKey = [PLUGIN_ID, "drafts", reviewId];
  const query = useQuery({
    queryKey,
    queryFn: () => listDrafts({ reviewId: reviewId! }),
    enabled: reviewId !== null,
  });
  const [open, setOpen] = useState<OpenBox | null>(null);
  if (reviewId === null) return null;

  // Writes land in the cache as the forge answered them, rather than waiting on a fresh listing.
  const change = (update: (drafts: Draft[]) => Draft[]) =>
    queryClient.setQueryData<DraftList>(queryKey, (current) => ({ drafts: update(current?.drafts ?? []) }));

  return {
    drafts: query.data?.drafts ?? [],
    loading: query.isPending,
    error: query.isError ? (query.error instanceof Error ? query.error.message : String(query.error)) : null,
    refresh: () => void query.refetch(),
    create: async (location, body) => {
      const draft = await createDraft({ reviewId, location, body });
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
    open,
    setOpen,
  };
}

/**
 * The box for a new comment at `location`. Every comment box in the panel is opened through this
 * or `DraftCard`, which is where actions for all of them, like "Suggest wording", go.
 */
export function NewCommentBox({ control, location, colors }: { control: DraftsControl; location: DraftLocation; colors: Colors }) {
  return (
    <CommentBox
      colors={colors}
      title={`Comment on ${describeLocation(location)}`}
      onSave={(body) => control.create(location, body)}
      onCancel={() => control.setOpen(null)}
    />
  );
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
  draft: Draft;
  /** Where this card is drawn, so its edit box opens here and not wherever else the draft shows. */
  place: string;
  colors: Colors;
  /** Name the file too, as the list does; beside its line in the diff the file goes without saying. */
  showPath?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = showPath ? `${draft.location.path} · ${describeLocation(draft.location)}` : `Your draft on ${describeLocation(draft.location)}`;
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  const open = control.open;

  if (open?.kind === "edit" && open.draftId === draft.id && open.place === place) {
    return (
      <CommentBox
        colors={colors}
        title={`Edit ${where}`}
        initialBody={draft.body}
        onSave={(body) => control.update(draft.id, body)}
        onCancel={() => control.setOpen(null)}
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

/** Every draft of the review in one list, in the forge's order, above the guide. */
export function DraftsSection({ control, colors }: { control: DraftsControl; colors: Colors }) {
  const body = { fontSize: fontSize.base, lineHeight: leading(fontSize.base) };
  const count = control.drafts.length;
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
          or comment on a whole file from its header.
        </Text>
      ) : (
        <>
          <Text style={{ ...body, color: colors.foregroundMuted }}>Saved on the forge, unpublished until the review is submitted.</Text>
          {control.drafts.map((draft) => (
            <DraftCard key={draft.id} control={control} draft={draft} place="list" colors={colors} showPath />
          ))}
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
