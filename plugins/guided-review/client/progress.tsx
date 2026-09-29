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
 * The panel's side of "understood": the reviewer's progress through the guide it shows, and the
 * toggle every node and every Supporting and Unsorted entry renders.
 */
export type ProgressControl = {
  /** Null until the guide is ready and its progress has been read. */
  progress: GuideProgress | null;
  toggle: (subject: GuideSubject) => void;
  /** The `subjectKey` of the subject whose mark is being written. */
  pendingKey: string | null;
  /** Why the last mark did not land, under the subject it was for. */
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
    mutationFn: (input: { reviewId: string; headSha: string; subject: GuideSubject; understood: boolean }) => setUnderstood(input),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  const subject = mutation.variables?.subject;
  return {
    progress,
    toggle: (subject) => {
      if (reviewId === null || progress === null) return;
      mutation.mutate({ reviewId, headSha: progress.headSha, subject, understood: !isUnderstood(progress, subject) });
    },
    pendingKey: mutation.isPending && subject ? subjectKey(subject) : null,
    notice:
      mutation.isError && subject
        ? { key: subjectKey(subject), message: mutation.error instanceof Error ? mutation.error.message : String(mutation.error) }
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
  const control = useContext(ProgressContext);
  if (control === null || control.progress === null) return null;
  const key = subjectKey(subject);
  const understood = isUnderstood(control.progress, subject);
  const pending = control.pendingKey === key;
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  return (
    <View style={{ gap: spacing[1], alignItems: "flex-end" }}>
      <Pressable
        onPress={() => control.toggle(subject)}
        disabled={pending}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: understood }}
        accessibilityLabel="Understood"
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
          {understood ? "✓ Understood" : "Mark understood"}
        </Text>
      </Pressable>
      {control.notice?.key === key ? <Text style={{ ...small, color: colors.statusWarning }}>{control.notice.message}</Text> : null}
    </View>
  );
}

/** Progress through the guide trunk first: each layer from the foundations up, then Supporting, Unsorted and overall. */
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
