import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useMemo, useRef, useState } from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { GuideState } from "../shared/guide.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { useAskAbout } from "./ask-action.tsx";
import { BranchStartView, isBranchRunning } from "./branch-start.tsx";
import { DraftsContext, DraftsSection, useDrafts } from "./drafts.tsx";
import { GuideView } from "./guide-view.tsx";
import { FinishBar, FinishReview, InlineFinishReview } from "./finish-review.tsx";
import { StaleGuideBanner, useRegenerate } from "./head-check.tsx";
import { Detail } from "./detail.tsx";
import { EntryLinksContext } from "./entry-links.ts";
import { FINISH_KEY, guideGroups, layoutFor, OVERVIEW_KEY } from "./guide-entries.ts";
import { Navigator, NAVIGATOR_WIDTH, useSelection } from "./navigator.tsx";
import { ProgressContext, useProgress } from "./progress.tsx";
import { Header, Note, Sidebar, SIDEBAR_WIDTH } from "./sidebar.tsx";
import { MAX_PANEL_WIDTH, spacing } from "./theme.ts";

const POLL_MS = 2_000;
/** An empty panel is asked again now and then, since the Command Center item starts a branch's guide from outside it. */
const IDLE_POLL_MS = 5_000;

/** The "Guided Review" tab: the review this workspace was created for, found by the workspace's ID. */
export function GuidePanel({ workspaceId, theme, layout, navigation }: PluginWorkspacePanelProps) {
  const getPanel = useRpc(contracts.getPanel);
  const panel = useQuery({
    queryKey: [PLUGIN_ID, "panel", workspaceId],
    queryFn: () => getPanel({ workspaceId }),
    // The guide is written by a background job, which the panel follows until it ends.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === "none") return isBranchRunning(data.branch) ? POLL_MS : IDLE_POLL_MS;
      return data?.status === "ready" && data.guide.status === "generating" ? POLL_MS : false;
    },
  });
  const generate = useRpc(contracts.generateGuide);
  const retry = useMutation({
    mutationFn: (reviewId: string) => generate({ reviewId }),
    onSettled: () => void panel.refetch(),
  });
  const colors = theme.colors;
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const ask = useAskAbout(panel.data?.status === "ready" ? panel.data.reviewId : null, openAgent);
  const progress = useProgress(
    panel.data?.status === "ready" ? panel.data.reviewId : null,
    panel.data?.status === "ready" && panel.data.guide.status === "ready" ? panel.data.guide.agentId : null,
  );
  const drafts = useDrafts(
    panel.data?.status === "ready" ? panel.data.reviewId : null,
    panel.data?.status === "ready" ? panel.data.header.headSha : null,
    panel.data?.status === "ready" && panel.data.guide.status === "ready"
      ? { agentId: panel.data.guide.agentId, nodes: panel.data.guide.guide.nodes }
      : null,
    openAgent,
  );
  const regenerate = useRegenerate({
    reviewId: panel.data?.status === "ready" ? panel.data.reviewId : null,
    workspaceId,
    ...(navigation ? { openWorkspace: (id: string) => navigation.openWorkspace({ workspaceId: id }) } : {}),
    onRegenerated: () => void panel.refetch(),
  });

  const readyGuide = panel.data?.status === "ready" && panel.data.guide.status === "ready" ? panel.data.guide.guide : null;
  const groups = useMemo(() => (readyGuide === null ? [] : guideGroups(readyGuide)), [readyGuide]);
  const [selected, select] = useSelection(groups, progress.progress);
  const links = useMemo(() => ({ groups, select }), [groups, select]);
  /** Where Finish review's Close goes back to. */
  const lastEntry = useRef(OVERVIEW_KEY);
  if (selected !== FINISH_KEY) lastEntry.current = selected;
  const [width, setWidth] = useState<number | null>(null);
  // Until the web panel has been measured nothing is drawn, rather than the stack for a frame.
  const shape = layout.platform !== "web" ? "stack" : width === null ? null : layoutFor(width, layout.platform);
  const measure = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  if (panel.isPending || panel.isError || panel.data.status === "none" || shape === "stack") {
    let body: React.ReactNode;
    if (panel.isPending) {
      body = <Note color={colors.foregroundMuted}>Reading the review…</Note>;
    } else if (panel.isError) {
      body = <Note color={colors.statusDanger}>{panel.error instanceof Error ? panel.error.message : String(panel.error)}</Note>;
    } else if (panel.data.status === "none") {
      body = (
        <BranchStartView
          workspaceId={workspaceId}
          branch={panel.data.branch}
          theme={theme}
          {...(navigation ? { openWorkspace: (id: string) => navigation.openWorkspace({ workspaceId: id }) } : {})}
          onStarted={() => void panel.refetch()}
        />
      );
    } else {
      const { reviewId } = panel.data;
      body = (
        <View style={{ gap: spacing[3] }}>
          <Header header={panel.data.header} theme={theme} />
          <StaleGuideBanner reviewId={reviewId} header={panel.data.header} theme={theme} regenerate={regenerate} />
          {panel.data.note ? <Note color={colors.statusWarning}>{panel.data.note}</Note> : null}
          {drafts ? <DraftsSection control={drafts} colors={colors} /> : null}
          {drafts ? <InlineFinishReview reviewId={reviewId} header={panel.data.header} drafts={drafts} colors={colors} regenerate={regenerate} /> : null}
          {guideView(reviewId, panel.data.guide, true)}
        </View>
      );
    }
    return (
      <ScrollView
        onLayout={measure}
        style={{ flex: 1, backgroundColor: colors.surface0 }}
        contentContainerStyle={{
          width: "100%",
          maxWidth: MAX_PANEL_WIDTH,
          alignSelf: "center",
          padding: layout.compact ? spacing[3] : spacing[4],
        }}
      >
        <ProgressContext.Provider value={progress}>
          <DraftsContext.Provider value={drafts}>{body}</DraftsContext.Provider>
        </ProgressContext.Provider>
      </ScrollView>
    );
  }

  if (shape === null) return <View onLayout={measure} style={{ flex: 1, backgroundColor: colors.surface0 }} />;

  const { reviewId, header, note, guide } = panel.data;
  const sidebar = <Sidebar reviewId={reviewId} header={header} note={note} drafts={drafts} regenerate={regenerate} theme={theme} />;
  const navigator =
    guide.status === "ready" ? <Navigator groups={groups} selected={selected} select={select} drafts={drafts?.drafts ?? []} colors={colors} /> : null;
  const divider = { borderColor: colors.border, flexGrow: 0, flexShrink: 0 } as const;
  const finishReview = drafts ? (
    <FinishReview reviewId={reviewId} header={header} drafts={drafts} colors={colors} regenerate={regenerate} onClose={() => select(lastEntry.current)} />
  ) : null;
  const overall = progress.progress?.overall;
  const finishBar = drafts ? (
    <View style={{ padding: spacing[3], borderTopWidth: 1, borderColor: colors.border }}>
      <FinishBar
        drafts={drafts}
        colors={colors}
        onOpen={() => select(FINISH_KEY)}
        understood={overall !== undefined && overall.total > 0 && overall.understood === overall.total}
      />
    </View>
  ) : null;
  return (
    <View onLayout={measure} style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface0 }}>
      <ProgressContext.Provider value={progress}>
        <DraftsContext.Provider value={drafts}>
          <EntryLinksContext.Provider value={guide.status === "ready" ? links : null}>
            {shape === "three" ? (
              <ScrollView style={{ ...divider, width: NAVIGATOR_WIDTH, borderRightWidth: 1 }}>{navigator}</ScrollView>
            ) : (
              <View style={{ ...divider, width: SIDEBAR_WIDTH, borderRightWidth: 1 }}>
                <ScrollView style={{ flex: 1 }}>
                  {navigator}
                  <View style={{ gap: spacing[3], padding: spacing[3] }}>{sidebar}</View>
                </ScrollView>
                {finishBar}
              </View>
            )}
            {guide.status === "ready" ? (
              <Detail
                key={guide.agentId}
                reviewId={reviewId}
                agentId={guide.agentId}
                guide={guide.guide}
                groups={groups}
                selected={selected}
                select={select}
                theme={theme}
                ask={ask}
                {...(openAgent ? { openAgent } : {})}
                finish={finishReview}
              />
            ) : (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing[3], padding: spacing[4] }}>
                {selected === FINISH_KEY ? finishReview : guideView(reviewId, guide, false)}
              </ScrollView>
            )}
            {shape === "three" ? (
              <View style={{ ...divider, width: SIDEBAR_WIDTH, borderLeftWidth: 1 }}>
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing[3], padding: spacing[3] }}>
                  {sidebar}
                </ScrollView>
                {finishBar}
              </View>
            ) : null}
          </EntryLinksContext.Provider>
        </DraftsContext.Provider>
      </ProgressContext.Provider>
    </View>
  );

  function guideView(reviewId: string, state: GuideState, withProgress: boolean) {
    return (
      <GuideView
        reviewId={reviewId}
        state={state}
        theme={theme}
        {...(openAgent ? { openAgent } : {})}
        ask={ask}
        withProgress={withProgress}
        retry={{
          run: () => retry.mutate(reviewId),
          pending: retry.isPending,
          error: retry.error ? (retry.error instanceof Error ? retry.error.message : String(retry.error)) : null,
        }}
      />
    );
  }
}
