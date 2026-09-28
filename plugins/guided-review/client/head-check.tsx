import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { HeadCheck, ReviewHeader } from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { describeProgress, isFinished } from "./start-progress.ts";
import { fontSize, leading, radius, spacing } from "./theme.ts";

type Colors = PluginTheme["colors"];

/** How often an open panel asks the forge whether the head has moved. */
const HEAD_CHECK_MS = 60_000;
const POLL_MS = 2_000;

/**
 * Where the forge has the review's head now, asked when the panel opens and every minute while it is
 * open. One query per review, so every part of the panel that needs to know whether the head moved,
 * the banner and the verdicts alike, shares the one answer. Null until it is known.
 */
export function useHeadCheck(reviewId: string | null): HeadCheck | null {
  const checkHead = useRpc(contracts.checkHead);
  const query = useQuery({
    queryKey: headCheckKey(reviewId),
    queryFn: () => checkHead({ reviewId: reviewId! }),
    enabled: reviewId !== null,
    refetchInterval: HEAD_CHECK_MS,
  });
  return query.data ?? null;
}

function headCheckKey(reviewId: string | null) {
  return [PLUGIN_ID, "head", reviewId];
}

/** Seeds the shared head check with an answer read elsewhere, like the Finish review step's. */
export function useSetHeadCheck(): (reviewId: string, head: HeadCheck) => void {
  const queryClient = useQueryClient();
  return (reviewId, head) => queryClient.setQueryData(headCheckKey(reviewId), head);
}

export type RegenerateOptions = {
  reviewId: string | null;
  /** The workspace the panel is in; a regenerated guide may end up in another. */
  workspaceId: string;
  /** Opens another workspace; absent on hosts without client navigation. */
  openWorkspace?: (workspaceId: string) => void;
  /** Called once a regeneration has moved the review, so the panel reads the guide at the new head. */
  onRegenerated: () => void;
};

/**
 * "Regenerate" and the job it starts, followed until it ends. One per panel, so the banner and the
 * Finish review step's offer to regenerate drive and show the same job.
 */
export type RegenerateControl = {
  run: () => void;
  /** A regeneration is being asked for, or followed until its guide is ready. */
  active: boolean;
  busy: boolean;
  /** Where the job has got to, while busy. */
  status: string | null;
  error: string | null;
};

export function useRegenerate({ reviewId, workspaceId, openWorkspace, onRegenerated }: RegenerateOptions): RegenerateControl {
  const queryClient = useQueryClient();
  const regenerateGuide = useRpc(contracts.regenerateGuide);
  const getStartProgress = useRpc(contracts.getStartProgress);
  /** Counts the regenerations asked for here, so each follows its own job rather than the last one's answer. */
  const [runs, setRuns] = useState(0);
  const [running, setRunning] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  const regenerate = useMutation({
    mutationFn: () => regenerateGuide({ reviewId: reviewId! }),
    onSuccess: (result) => {
      if (result.status === "rejected") setRejection(result.message);
      else {
        setRuns((count) => count + 1);
        setRunning(true);
      }
    },
  });
  const progress = useQuery({
    queryKey: [PLUGIN_ID, "regenerate-progress", reviewId, runs],
    queryFn: () => getStartProgress({ reviewId: reviewId! }),
    enabled: running && reviewId !== null,
    refetchInterval: (query) => (query.state.data && isFinished(query.state.data.phase) ? false : POLL_MS),
  });
  const current = running ? (progress.data ?? null) : null;
  const finished = current !== null && isFinished(current.phase);
  const movedTo = current?.phase === "ready" && current.workspaceId !== workspaceId ? current.workspaceId : null;

  useEffect(() => {
    if (!finished) return;
    void queryClient.invalidateQueries({ queryKey: headCheckKey(reviewId) });
    onRegenerated();
    if (movedTo !== null && openWorkspace) openWorkspace(movedTo);
    if (current?.phase === "ready") setRunning(false);
  }, [finished]);

  const busy = regenerate.isPending || (running && !finished);
  const line = current === null ? null : describeProgress(current);
  return {
    run: () => {
      setRejection(null);
      setRunning(false);
      regenerate.mutate();
    },
    active: running || regenerate.isPending,
    busy,
    status: busy && line && line.tone !== "danger" ? line.text : null,
    error:
      rejection ??
      (regenerate.error ? (regenerate.error instanceof Error ? regenerate.error.message : String(regenerate.error)) : null) ??
      (line?.tone === "danger" ? line.text : null),
  };
}

export type StaleGuideBannerProps = {
  reviewId: string;
  header: ReviewHeader;
  theme: PluginTheme;
  regenerate: RegenerateControl;
};

/**
 * "PR updated since this guide": shown while the forge's head is not the guide's, with Regenerate,
 * which is the only way to a guide at the new head. Draws nothing while the guide is current.
 */
export function StaleGuideBanner({ reviewId, header, theme, regenerate }: StaleGuideBannerProps) {
  const colors = theme.colors;
  const head = useHeadCheck(reviewId);
  if (!regenerate.active && (head === null || !head.moved)) return null;

  const kind = header.forge === "gitlab" ? "MR" : "PR";
  const { busy, status, error } = regenerate;

  return (
    <View
      style={{
        gap: spacing[2],
        padding: spacing[4],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.statusWarning,
        backgroundColor: colors.surface1,
      }}
    >
      <Line colors={colors} color={colors.statusWarning}>
        {kind} updated since this guide
      </Line>
      <Line colors={colors} muted>
        {head?.forgeHeadSha
          ? `New commits were pushed: the guide explains ${short(head.guideHeadSha)}, the ${kind} is at ${short(head.forgeHeadSha)}. `
          : null}
        Regenerate writes a guide for the new head; what you marked understood carries over where the code did not change.
      </Line>
      {status ? (
        <Line colors={colors} muted>
          {status}
        </Line>
      ) : null}
      {error ? (
        <Line colors={colors} color={colors.statusDanger}>
          {error}
        </Line>
      ) : null}
      <View style={{ alignItems: "flex-start" }}>
        <Button
          colors={colors}
          label={busy ? "Regenerating…" : "Regenerate"}
          disabled={busy}
          onPress={regenerate.run}
        />
      </View>
    </View>
  );
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function Line({ colors, muted, color, children }: { colors: Colors; muted?: boolean; color?: string; children: React.ReactNode }) {
  return (
    <Text
      style={{
        color: color ?? (muted ? colors.foregroundMuted : colors.foreground),
        fontSize: fontSize.base,
        lineHeight: leading(fontSize.base),
      }}
    >
      {children}
    </Text>
  );
}

function Button({ colors, label, disabled, onPress }: { colors: Colors; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({
        paddingVertical: spacing[1],
        paddingHorizontal: spacing[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>{label}</Text>
    </Pressable>
  );
}
