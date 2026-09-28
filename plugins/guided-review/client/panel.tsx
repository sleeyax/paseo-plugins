import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import React from "react";
import { ScrollView, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { ReviewHeader } from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { numberLabel } from "../shared/reference.ts";
import { useAskAbout } from "./ask-action.tsx";
import { DraftsContext, DraftsSection, useDrafts } from "./drafts.tsx";
import { GuideView } from "./guide-view.tsx";
import { fontSize, leading, MAX_CONTENT_WIDTH, radius, spacing } from "./theme.ts";

const POLL_MS = 2_000;

/** The "Guided Review" tab: the review this workspace was created for, found by the workspace's ID. */
export function GuidePanel({ workspaceId, theme, layout, navigation }: PluginWorkspacePanelProps) {
  const getPanel = useRpc(contracts.getPanel);
  const panel = useQuery({
    queryKey: [PLUGIN_ID, "panel", workspaceId],
    queryFn: () => getPanel({ workspaceId }),
    // The guide is written by a background job, which the panel follows until it ends.
    refetchInterval: (query) => (query.state.data?.status === "ready" && query.state.data.guide.status === "generating" ? POLL_MS : false),
  });
  const generate = useRpc(contracts.generateGuide);
  const retry = useMutation({
    mutationFn: (reviewId: string) => generate({ reviewId }),
    onSettled: () => void panel.refetch(),
  });
  const colors = theme.colors;
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const ask = useAskAbout(panel.data?.status === "ready" ? panel.data.reviewId : null, openAgent);
  const drafts = useDrafts(panel.data?.status === "ready" ? panel.data.reviewId : null);

  let body: React.ReactNode;
  if (panel.isPending) {
    body = <Note color={colors.foregroundMuted}>Reading the review…</Note>;
  } else if (panel.isError) {
    body = <Note color={colors.statusDanger}>{panel.error instanceof Error ? panel.error.message : String(panel.error)}</Note>;
  } else if (panel.data.status === "none") {
    body = (
      <Note color={colors.foregroundMuted}>
        No guided review lives in this workspace. Start one from the Command Center with "Guided Review: start from a
        PR or MR URL".
      </Note>
    );
  } else {
    const { reviewId } = panel.data;
    body = (
      <View style={{ gap: spacing[3] }}>
        <Header header={panel.data.header} theme={theme} />
        {drafts ? <DraftsSection control={drafts} colors={colors} /> : null}
        <GuideView
          reviewId={reviewId}
          state={panel.data.guide}
          theme={theme}
          {...(openAgent ? { openAgent } : {})}
          ask={ask}
          retry={{
            run: () => retry.mutate(reviewId),
            pending: retry.isPending,
            error: retry.error ? (retry.error instanceof Error ? retry.error.message : String(retry.error)) : null,
          }}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{
        width: "100%",
        maxWidth: MAX_CONTENT_WIDTH,
        alignSelf: "center",
        padding: layout.compact ? spacing[3] : spacing[4],
      }}
    >
      <DraftsContext.Provider value={drafts}>{body}</DraftsContext.Provider>
    </ScrollView>
  );
}

const STATE_LABELS = { open: "Open", closed: "Closed", merged: "Merged" } as const;
const FORGE_LABELS = { github: "GitHub", gitlab: "GitLab" } as const;

function Header({ header, theme }: { header: ReviewHeader; theme: PluginTheme }) {
  const colors = theme.colors;
  const stateColor = header.isDraft
    ? colors.foregroundMuted
    : { open: colors.statusSuccess, merged: colors.accent, closed: colors.statusDanger }[header.state];
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };

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
      <Text style={{ color: colors.foreground, fontSize: fontSize.lg, lineHeight: leading(fontSize.lg), fontWeight: "600" }}>
        {header.title}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing[2] }}>
        <View style={{ paddingHorizontal: spacing[2], borderRadius: radius.full, borderWidth: 1, borderColor: stateColor }}>
          <Text style={{ ...small, color: stateColor }}>{header.isDraft ? "Draft" : STATE_LABELS[header.state]}</Text>
        </View>
        <Text style={{ ...small, color: colors.foregroundMuted }}>
          {header.project} {numberLabel(header.forge, header.number)} by {header.author}
        </Text>
      </View>
      <Text style={{ ...small, color: colors.foregroundMuted }}>
        {header.fileCount === 1 ? "1 file" : `${header.fileCount} files`}
        {"  "}
        <Text style={{ color: colors.statusSuccess }}>+{header.additions}</Text>{" "}
        <Text style={{ color: colors.statusDanger }}>−{header.deletions}</Text>
      </Text>
      <ExternalLink href={header.url}>Open on {FORGE_LABELS[header.forge]}</ExternalLink>
    </View>
  );
}

function Note({ color, children }: { color: string; children: React.ReactNode }) {
  return <Text style={{ color, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>{children}</Text>;
}
