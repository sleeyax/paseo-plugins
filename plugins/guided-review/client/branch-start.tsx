import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import React from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { BranchStart } from "../shared/contracts.ts";
import { numberLabel } from "../shared/reference.ts";
import { describeProgress, isFinished } from "./start-progress.ts";
import { fontSize, leading, radius, spacing } from "./theme.ts";

type Colors = PluginTheme["colors"];

export type BranchStartViewProps = {
  workspaceId: string;
  /** Where guiding this workspace's branch has got to; absent when it was never asked for. */
  branch: BranchStart | undefined;
  theme: PluginTheme;
  /** Opens another workspace; absent on hosts without client navigation. */
  openWorkspace?: (workspaceId: string) => void;
  /** Called once a start was asked for, so the panel reads the new state. */
  onStarted: () => void;
};

/** Whether the panel should keep asking: the branch's PR/MR is being found or its review prepared. */
export function isBranchRunning(branch: BranchStart | undefined): boolean {
  if (branch === undefined) return false;
  return branch.status === "finding" || (branch.status === "started" && !isFinished(branch.progress.phase));
}

/**
 * A panel in a workspace with no guide in it: "Guide this branch's PR/MR", and where that has got to,
 * which ends either with the guide here, or with the reason the branch was left alone and a link to
 * the PR workspace the guide went to instead.
 */
export function BranchStartView({ workspaceId, branch, theme, openWorkspace, onStarted }: BranchStartViewProps) {
  const colors = theme.colors;
  const startBranch = useRpc(contracts.startBranchReview);
  const start = useMutation({
    mutationFn: (url: string | null) => startBranch({ workspaceId, url }),
    onSettled: onStarted,
  });
  const startError = start.error ? (start.error instanceof Error ? start.error.message : String(start.error)) : null;
  const guideButton = (label: string) => (
    <Button colors={colors} label={start.isPending ? "Starting…" : label} disabled={start.isPending} onPress={() => start.mutate(null)} />
  );

  let body: React.ReactNode;
  switch (branch?.status) {
    case undefined:
      body = (
        <>
          <Line colors={colors} muted>
            No guided review lives in this workspace. Guide the PR or MR this workspace's branch is the source of, or start one
            from any URL with "Guided Review: start from a PR or MR URL" in the Command Center.
          </Line>
          <View style={{ alignItems: "flex-start" }}>{guideButton("Guide this branch's PR/MR")}</View>
        </>
      );
      break;
    case "finding":
      body = (
        <Line colors={colors} muted>
          Looking for the PR or MR this branch is the source of…
        </Line>
      );
      break;
    case "none":
    case "failed":
      body = (
        <>
          <Line colors={colors} color={branch.status === "failed" ? colors.statusDanger : undefined} muted>
            {branch.message}
          </Line>
          <View style={{ alignItems: "flex-start" }}>{guideButton("Look again")}</View>
        </>
      );
      break;
    case "choose":
      body = (
        <>
          <Line colors={colors}>Several open PRs or MRs come from {branch.branch}. Which one should be guided?</Line>
          {branch.candidates.map((candidate) => (
            <Pressable
              key={candidate.url}
              onPress={() => start.mutate(candidate.url)}
              disabled={start.isPending}
              accessibilityRole="button"
              style={({ pressed }) => ({
                padding: spacing[3],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface2,
                opacity: start.isPending ? 0.5 : pressed ? 0.85 : 1,
              })}
            >
              <Line colors={colors}>
                {numberLabel(candidate.forge, candidate.number)} {candidate.title}
              </Line>
              <Line colors={colors} muted small>
                by {candidate.author}
              </Line>
            </Pressable>
          ))}
        </>
      );
      break;
    case "started": {
      const { progress, note } = branch;
      const elsewhere = progress.phase === "ready" && progress.workspaceId !== null && progress.workspaceId !== workspaceId;
      const line = describeProgress(progress);
      body = (
        <>
          {note ? <Line colors={colors} color={colors.statusWarning}>{note}</Line> : null}
          {elsewhere ? null : (
            <Line colors={colors} color={line.tone === "danger" ? colors.statusDanger : undefined} muted>
              {line.text}
            </Line>
          )}
          {elsewhere && openWorkspace ? (
            <View style={{ alignItems: "flex-start" }}>
              <Button colors={colors} label="Open the PR workspace" onPress={() => openWorkspace(progress.workspaceId!)} />
            </View>
          ) : null}
          {elsewhere && !openWorkspace ? (
            <Line colors={colors} muted>
              Open "Review {progress.header ? numberLabel(progress.header.forge, progress.header.number) : "the PR or MR"}" from the
              sidebar.
            </Line>
          ) : null}
          {progress.phase === "failed" || progress.phase === "unknown" ? (
            <View style={{ alignItems: "flex-start" }}>{guideButton("Try again")}</View>
          ) : null}
        </>
      );
      break;
    }
  }

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
      {body}
      {startError ? (
        <Line colors={colors} color={colors.statusDanger}>
          {startError}
        </Line>
      ) : null}
    </View>
  );
}

function Line({
  colors,
  muted,
  small,
  color,
  children,
}: {
  colors: Colors;
  muted?: boolean;
  small?: boolean;
  color?: string | undefined;
  children: React.ReactNode;
}) {
  const size = small ? fontSize.sm : fontSize.base;
  return (
    <Text style={{ color: color ?? (muted ? colors.foregroundMuted : colors.foreground), fontSize: size, lineHeight: leading(size) }}>
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
