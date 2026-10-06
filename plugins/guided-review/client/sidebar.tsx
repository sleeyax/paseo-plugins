import type { PluginTheme } from "@getpaseo/plugin";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Text, View } from "react-native";
import type { ReviewHeader } from "../shared/contracts.ts";
import { numberLabel } from "../shared/reference.ts";
import { DraftsSection, type DraftsControl } from "./drafts.tsx";
import { layerTitle } from "./guide-entries.ts";
import { StaleGuideBanner, type RegenerateControl } from "./head-check.tsx";
import { ProgressSummary } from "./progress.tsx";
import { Section } from "./section.tsx";
import { fontSize, leading, radius, spacing } from "./theme.ts";

export type SidebarProps = {
  reviewId: string;
  header: ReviewHeader;
  note: string | null | undefined;
  drafts: DraftsControl | null;
  regenerate: RegenerateControl;
  theme: PluginTheme;
};

/** What stays in view beside the guide, as flat sections: the change request, whether the guide is still current, the reviewer's progress and their drafts. Finish review is pinned under it by the panel. */
export function Sidebar({ reviewId, header, note, drafts, regenerate, theme }: SidebarProps) {
  const colors = theme.colors;
  return (
    <>
      <Header header={header} theme={theme} />
      <StaleGuideBanner reviewId={reviewId} header={header} theme={theme} regenerate={regenerate} />
      {note ? (
        <Section colors={colors} title="Workspace" tone={colors.statusWarning}>
          <Note color={colors.statusWarning}>{note}</Note>
        </Section>
      ) : null}
      <ProgressSummary colors={colors} layerTitle={layerTitle} />
      {drafts ? <DraftsSection control={drafts} colors={colors} /> : null}
    </>
  );
}

const STATE_LABELS = { open: "Open", closed: "Closed", merged: "Merged" } as const;
const FORGE_LABELS = { github: "GitHub", gitlab: "GitLab" } as const;

export function Header({ header, theme }: { header: ReviewHeader; theme: PluginTheme }) {
  const colors = theme.colors;
  const stateColor = header.isDraft
    ? colors.foregroundMuted
    : { open: colors.statusSuccess, merged: colors.accent, closed: colors.statusDanger }[header.state];
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };

  return (
    <Section colors={colors} title={header.forge === "gitlab" ? "Merge request" : "Pull request"}>
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
    </Section>
  );
}

export function Note({ color, children }: { color: string; children: React.ReactNode }) {
  return <Text style={{ color, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>{children}</Text>;
}
