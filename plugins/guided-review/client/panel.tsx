import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { GuideState } from "../shared/guide.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { BranchStartView, isBranchRunning } from "./branch-start.tsx";
import { ResizeHandle, useColumnWidths } from "./column-resize.tsx";
import { DescriptionCard, useDescriptionEdited } from "./description.tsx";
import { DraftsContext, DraftsSection, useDrafts } from "./drafts.tsx";
import { GuideView } from "./guide-view.tsx";
import { FinishBar, FinishReview, InlineFinishReview } from "./finish-review.tsx";
import { ForeignWorkBanner, ForeignWorkStrip, IssuesPending } from "./foreign-work.tsx";
import { StaleGuideBanner, useRegenerate } from "./head-check.tsx";
import { Detail } from "./detail.tsx";
import { EntryLinksContext } from "./entry-links.ts";
import { DESCRIPTION_KEY, FINISH_KEY, guideGroups, ISSUES_KEY, layoutFor, OVERVIEW_KEY } from "./guide-entries.ts";
import { Navigator, useSelection } from "./navigator.tsx";
import { ProgressContext, useProgress } from "./progress.tsx";
import { FlatContext, Strip } from "./section.tsx";
import { Header, Note, Sidebar } from "./sidebar.tsx";
import { fontSize, leading, MAX_PANEL_WIDTH, spacing } from "./theme.ts";
import { onVisibleWidth } from "./visible-width.ts";

const POLL_MS = 2_000;
/** An empty panel is asked again now and then, since the Command Center item starts a branch's guide from outside it. */
const IDLE_POLL_MS = 5_000;

/** The "Guided Review" tab: the review this workspace was created for, found by the workspace's ID. */
export function GuidePanel({ workspaceId, theme, layout, navigation, openPanel }: PluginWorkspacePanelProps & { openPanel: (workspaceId: string) => void }) {
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
  const descriptionEdited = useDescriptionEdited(
    panel.data?.status === "ready" ? panel.data.reviewId : null,
    panel.data?.status === "ready" ? panel.data.header.headSha : null,
  );
  const regenerate = useRegenerate({
    reviewId: panel.data?.status === "ready" ? panel.data.reviewId : null,
    workspaceId,
    openPanel,
    onRegenerated: () => void panel.refetch(),
  });

  const readyGuide = panel.data?.status === "ready" && panel.data.guide.status === "ready" ? panel.data.guide.guide : null;
  const forge = panel.data?.status === "ready" ? panel.data.header.forge : null;
  const groups = useMemo(() => (readyGuide === null || forge === null ? [] : guideGroups(readyGuide, forge)), [readyGuide, forge]);
  const [selected, select] = useSelection(groups, progress.progress);
  const links = useMemo(() => ({ groups, select }), [groups, select]);
  /** Where Finish review's Close goes back to. */
  const lastEntry = useRef(OVERVIEW_KEY);
  if (selected !== FINISH_KEY) lastEntry.current = selected;
  const [width, setWidth] = useState<number | null>(null);
  // Until the web panel has been measured nothing is drawn, rather than the stack for a frame.
  const shape = layout.platform !== "web" ? "stack" : width === null ? null : layoutFor(width, layout.platform);
  const columns = useColumnWidths(workspaceId, shape, width);
  // One element measures the panel whatever is drawn in it, so switching layouts never remounts what reports the width.
  const frame = (children?: React.ReactNode) => (
    <View onLayout={onVisibleWidth(setWidth)} style={{ flex: 1, backgroundColor: colors.surface0 }}>
      {children}
    </View>
  );

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
          openPanel={openPanel}
          onStarted={() => void panel.refetch()}
        />
      );
    } else {
      const { reviewId } = panel.data;
      body = (
        <View style={{ gap: spacing[3] }}>
          <Header header={panel.data.header} theme={theme} />
          <StaleGuideBanner reviewId={reviewId} header={panel.data.header} theme={theme} regenerate={regenerate} />
          <ForeignWorkBanner
            reviewId={reviewId}
            header={panel.data.header}
            foreign={panel.data.foreign}
            colors={colors}
            choosing={panel.data.guide.status === "choosing-scope"}
            onScopeChosen={() => void panel.refetch()}
          />
          {panel.data.note ? <Note color={colors.statusWarning}>{panel.data.note}</Note> : null}
          {drafts ? <DraftsSection control={drafts} colors={colors} /> : null}
          {drafts ? <InlineFinishReview reviewId={reviewId} header={panel.data.header} drafts={drafts} colors={colors} regenerate={regenerate} /> : null}
          <DescriptionCard reviewId={reviewId} headSha={panel.data.header.headSha} colors={colors} />
          {guideView(reviewId, panel.data.guide, true)}
        </View>
      );
    }
    return frame(
      <ScrollView
        style={{ flex: 1 }}
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

  if (shape === null) return frame();

  const { reviewId, header, note, foreign, guide } = panel.data;
  const sidebar = <Sidebar reviewId={reviewId} header={header} note={note} drafts={drafts} regenerate={regenerate} theme={theme} />;
  const navigator = (
    <View style={{ borderBottomWidth: shape === "two" ? 1 : 0, borderColor: colors.border }}>
      <Strip colors={colors} title="Guide" />
      <Navigator groups={groups} selected={selected} select={select} drafts={drafts?.drafts ?? []} descriptionEdited={descriptionEdited} issues={foreign ? 1 : 0} colors={colors} />
      {guide.status === "ready" ? null : (
        <Text style={{ paddingHorizontal: spacing[3], paddingBottom: spacing[3], color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
          {guide.status === "generating"
            ? "Its entries appear once the guide is written."
            : guide.status === "choosing-scope"
              ? "Its entries appear once you choose what it explains."
              : "No guide to list."}
        </Text>
      )}
    </View>
  );
  // Above the detail pane, so the half of a handle that overhangs it takes the pointer.
  const divider = { borderColor: colors.border, flexGrow: 0, flexShrink: 0, zIndex: 1 } as const;
  const descriptionCard = <DescriptionCard reviewId={reviewId} headSha={header.headSha} colors={colors} />;
  // A card on a page of its own, where the strip's Fix leads, rather than a pane of the grid.
  const issuesPage = (
    <FlatContext.Provider value={false}>
      <ForeignWorkBanner
        reviewId={reviewId}
        header={header}
        foreign={foreign}
        colors={colors}
        choosing={guide.status === "choosing-scope"}
        onScopeChosen={() => void panel.refetch()}
      />
    </FlatContext.Provider>
  );
  const finishReview = drafts ? (
    <FinishReview reviewId={reviewId} header={header} drafts={drafts} colors={colors} regenerate={regenerate} onClose={() => select(lastEntry.current)} />
  ) : null;
  const overall = progress.progress?.overall;
  const finishBar = drafts ? (
    <View style={{ borderTopWidth: 1, borderColor: colors.border }}>
      <FinishBar
        drafts={drafts}
        colors={colors}
        onOpen={() => select(FINISH_KEY)}
        understood={overall !== undefined && overall.total > 0 && overall.understood === overall.total}
      />
    </View>
  ) : null;
  return frame(
    <View style={{ flex: 1, flexDirection: "row" }}>
      <FlatContext.Provider value={true}>
        <ProgressContext.Provider value={progress}>
          <DraftsContext.Provider value={drafts}>
            <EntryLinksContext.Provider value={guide.status === "ready" ? links : null}>
              {shape === "three" ? (
                <View style={{ ...divider, width: columns.drawn.navigator, borderRightWidth: 1 }}>
                  <ScrollView style={{ flex: 1 }}>{navigator}</ScrollView>
                  <ResizeHandle control={columns.handle("navigator")} colors={colors} />
                </View>
              ) : (
                <View style={{ ...divider, width: columns.drawn.sidebar, borderRightWidth: 1 }}>
                  <ScrollView style={{ flex: 1 }}>
                    {navigator}
                    {sidebar}
                  </ScrollView>
                  {finishBar}
                  <ResizeHandle control={columns.handle("sidebar")} colors={colors} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <ForeignWorkStrip header={header} foreign={foreign} colors={colors} onFix={() => select(ISSUES_KEY)} />
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
                    {...(openAgent ? { openAgent } : {})}
                    finish={finishReview}
                    description={descriptionCard}
                    issues={issuesPage}
                  />
                ) : (
                  <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing[3], padding: spacing[4] }}>
                    {selected === FINISH_KEY ? (
                      finishReview
                    ) : selected === DESCRIPTION_KEY ? (
                      descriptionCard
                    ) : selected === ISSUES_KEY ? (
                      issuesPage
                    ) : (
                      guideView(reviewId, guide, false, <IssuesPending header={header} colors={colors} onOpen={() => select(ISSUES_KEY)} />)
                    )}
                  </ScrollView>
                )}
              </View>
              {shape === "three" ? (
                <View style={{ ...divider, width: columns.drawn.sidebar, borderLeftWidth: 1 }}>
                  <ScrollView style={{ flex: 1 }}>{sidebar}</ScrollView>
                  {finishBar}
                  <ResizeHandle control={columns.handle("sidebar")} colors={colors} />
                </View>
              ) : null}
            </EntryLinksContext.Provider>
          </DraftsContext.Provider>
        </ProgressContext.Provider>
      </FlatContext.Provider>
    </View>
  );

  /** `waiting` is what it shows while the guide waits for the reviewer to choose what it explains. */
  function stackWaiting() {
    return panel.data?.status === "ready" ? <IssuesPending header={panel.data.header} colors={colors} onOpen={null} /> : null;
  }

  function guideView(reviewId: string, state: GuideState, withProgress: boolean, waiting: React.ReactNode = stackWaiting()) {
    return (
      <GuideView
        reviewId={reviewId}
        state={state}
        theme={theme}
        {...(openAgent ? { openAgent } : {})}
        withProgress={withProgress}
        forge={forge ?? "github"}
        scopeChoice={waiting}
        retry={{
          run: () => retry.mutate(reviewId),
          pending: retry.isPending,
          error: retry.error ? (retry.error instanceof Error ? retry.error.message : String(retry.error)) : null,
        }}
      />
    );
  }
}
