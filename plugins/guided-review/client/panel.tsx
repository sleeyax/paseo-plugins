import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { ScrollView, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { ReviewHeader } from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { fontSize, leading, MAX_CONTENT_WIDTH, radius, spacing } from "./theme.ts";

/** The "Guided Review" tab: the review this workspace was created for, found by the workspace's ID. */
export function GuidePanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const getPanel = useRpc(contracts.getPanel);
  const panel = useQuery({ queryKey: [PLUGIN_ID, "panel", workspaceId], queryFn: () => getPanel({ workspaceId }) });
  const colors = theme.colors;

  let body: React.ReactNode;
  if (panel.isPending) {
    body = <Note color={colors.foregroundMuted}>Reading the review…</Note>;
  } else if (panel.isError) {
    body = <Note color={colors.statusDanger}>{panel.error instanceof Error ? panel.error.message : String(panel.error)}</Note>;
  } else if (panel.data.status === "none") {
    body = (
      <Note color={colors.foregroundMuted}>
        No guided review lives in this workspace. Start one from the Command Center with "Guided Review: start from a
        pull request URL".
      </Note>
    );
  } else {
    body = <Header header={panel.data.header} theme={theme} />;
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
      {body}
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
          {header.project} #{header.number} by {header.author}
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
