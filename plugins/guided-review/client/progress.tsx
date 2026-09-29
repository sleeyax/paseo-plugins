import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { createContext, useContext, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { subjectKey, type GuideSubject } from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { isUnderstood, type GuideProgress, type Tally } from "../shared/progress.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

/**
 * The panel's side of "understood": the reviewer's progress through the guide it shows, the toggle
 * every node and every Supporting and Unsorted entry renders, and the one on each group's heading.
 */
export type ProgressControl = {
  /** Null until the guide is ready and its progress has been read. */
  progress: GuideProgress | null;
  /** Marks every one of `subjects` understood, or takes their marks back; `place` names the toggle that asked. */
  set: (place: string, subjects: readonly GuideSubject[], understood: boolean) => void;
  /** The place of the toggle whose marks are being written. */
  pendingKey: string | null;
  /** Why the last marks did not land, under the toggle they were for. */
  notice: { key: string; message: string } | null;
};

/**
 * The progress control of the guide being drawn, so a node or an entry anywhere in the tree can draw
 * its toggle without it being handed down. Null where the panel has none.
 */
export const ProgressContext = createContext<ProgressControl | null>(null);

/**
 * Reads the progress of the review's ready guide, which `guideAgentId` names: a guide generated again
 * has a new agent, and its own progress to read.
 */
export function useProgress(reviewId: string | null, guideAgentId: string | null): ProgressControl {
  const getProgress = useRpc(contracts.getProgress);
  const setUnderstood = useRpc(contracts.setUnderstood);
  const queryClient = useQueryClient();
  const queryKey = [PLUGIN_ID, "progress", reviewId, guideAgentId];
  const query = useQuery({
    queryKey,
    queryFn: () => getProgress({ reviewId: reviewId! }),
    enabled: reviewId !== null && guideAgentId !== null,
  });
  const progress = query.data ?? null;
  const mutation = useMutation({
    mutationFn: ({ input }: { place: string; input: { reviewId: string; headSha: string; subjects: GuideSubject[]; understood: boolean } }) =>
      setUnderstood(input),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  const place = mutation.variables?.place;
  return {
    progress,
    set: (place, subjects, understood) => {
      if (reviewId === null || progress === null || subjects.length === 0) return;
      mutation.mutate({ place, input: { reviewId, headSha: progress.headSha, subjects: [...subjects], understood } });
    },
    pendingKey: mutation.isPending && place !== undefined ? place : null,
    notice:
      mutation.isError && place !== undefined
        ? { key: place, message: mutation.error instanceof Error ? mutation.error.message : String(mutation.error) }
        : null,
  };
}

/**
 * Whether the card of `subject` is collapsed to its title row: it starts collapsed when the subject is understood, collapses when the reviewer marks it and expands when they take the mark back.
 * In between, the reviewer collapses and expands it freely.
 */
export function useCollapsed(subject: GuideSubject): [boolean, (collapsed: boolean) => void] {
  const progress = useContext(ProgressContext)?.progress ?? null;
  const understood = progress !== null && isUnderstood(progress, subject);
  const [collapsed, setCollapsed] = useState(understood);
  const [followed, setFollowed] = useState(understood);
  if (understood !== followed) {
    setFollowed(understood);
    setCollapsed(understood);
  }
  return [collapsed, setCollapsed];
}

/** Marks the subject understood, or takes the mark back. Draws nothing until the progress is known. */
export function UnderstoodToggle({ subject, colors }: { subject: GuideSubject; colors: Colors }) {
  return <MarkToggle place={subjectKey(subject)} subjects={[subject]} label="Understood" colors={colors} />;
}

/**
 * Marks every subject of a group (a layer's nodes, or the entries of Tests, Documentation, Supporting or Unsorted) understood, or takes every mark back once all are.
 * `group` is the group's title, unique among the guide's groups.
 */
export function GroupUnderstoodToggle({ group, subjects, colors }: { group: string; subjects: readonly GuideSubject[]; colors: Colors }) {
  return <MarkToggle place={`group:${group}`} subjects={subjects} label="All understood" colors={colors} />;
}

function MarkToggle({ place, subjects, label, colors }: { place: string; subjects: readonly GuideSubject[]; label: string; colors: Colors }) {
  const control = useContext(ProgressContext);
  if (control === null || control.progress === null || subjects.length === 0) return null;
  const { progress } = control;
  const understood = subjects.every((subject) => isUnderstood(progress, subject));
  const pending = control.pendingKey === place;
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  return (
    <View style={{ gap: spacing[1], alignItems: "flex-end" }}>
      <Pressable
        onPress={() => control.set(place, subjects, !understood)}
        disabled={pending}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: understood }}
        accessibilityLabel={label}
        style={({ pressed }) => ({
          paddingVertical: spacing[1],
          paddingHorizontal: spacing[2],
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: understood ? colors.statusSuccess : colors.border,
          opacity: pending ? 0.5 : pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ ...small, color: understood ? colors.statusSuccess : colors.foregroundMuted }}>
          {understood ? `✓ ${label}` : `Mark ${label.toLowerCase()}`}
        </Text>
      </Pressable>
      {control.notice?.key === place ? <Text style={{ ...small, color: colors.statusWarning }}>{control.notice.message}</Text> : null}
    </View>
  );
}

/** Progress through the guide trunk first: each layer from the foundations up, then Tests, Documentation, Supporting, Unsorted and overall. */
export function ProgressSummary({ colors, layerTitle }: { colors: Colors; layerTitle: (layer: number) => string }) {
  const progress = useContext(ProgressContext)?.progress ?? null;
  if (progress === null) return null;
  const next =
    progress.nextLayer === null
      ? "Every concept is understood."
      : progress.nextLayer === 0
        ? `Next: ${layerTitle(0)}, which everything else builds on.`
        : `Next: ${layerTitle(progress.nextLayer)}. Everything it builds on is understood.`;
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
      <Row colors={colors} label="Understood" tally={progress.overall} strong />
      {progress.layers.map((tally, layer) => (
        <Row key={layer} colors={colors} label={layerTitle(layer)} tally={tally} />
      ))}
      {progress.tests.total > 0 ? <Row colors={colors} label="Tests" tally={progress.tests} /> : null}
      {progress.docs.total > 0 ? <Row colors={colors} label="Documentation" tally={progress.docs} /> : null}
      {progress.supporting.total > 0 ? <Row colors={colors} label="Supporting" tally={progress.supporting} /> : null}
      {progress.unsorted.total > 0 ? <Row colors={colors} label="Unsorted" tally={progress.unsorted} /> : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{next}</Text>
    </View>
  );
}

function Row({ colors, label, tally, strong }: { colors: Colors; label: string; tally: Tally; strong?: boolean }) {
  const done = tally.total > 0 && tally.understood === tally.total;
  const size = strong ? fontSize.base : fontSize.sm;
  const text = { fontSize: size, lineHeight: leading(size), fontWeight: strong ? ("600" as const) : ("400" as const) };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[3] }}>
      <Text style={{ ...text, width: 110, color: colors.foreground }} numberOfLines={1}>
        {label}
      </Text>
      <View style={{ flex: 1, height: 6, borderRadius: radius.full, backgroundColor: colors.surface2, overflow: "hidden" }}>
        <View
          style={{
            width: `${tally.total === 0 ? 0 : (tally.understood / tally.total) * 100}%`,
            height: "100%",
            backgroundColor: done ? colors.statusSuccess : colors.accent,
          }}
        />
      </View>
      <Text style={{ ...text, minWidth: 40, textAlign: "right", color: done ? colors.statusSuccess : colors.foregroundMuted }}>
        {tally.understood}/{tally.total}
      </Text>
    </View>
  );
}
