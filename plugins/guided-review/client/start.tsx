import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { numberLabel } from "../shared/reference.ts";
import { openPanelWhenReady } from "./open-panel.ts";
import { describeProgress, isFinished } from "./start-progress.ts";
import { fontSize, leading, MAX_CONTENT_WIDTH, spacing } from "./theme.ts";

const POLL_MS = 1_000;

/**
 * Where a PR or MR URL is pasted, opened from the sidebar.
 * A surface is not handed the client context, so the panel opener comes in through the closure.
 */
export function createStartSurface(openPanel: (workspaceId: string) => void) {
  return function StartSurface({ theme, layout }: PluginSurfaceProps) {
    const start = useRpc(contracts.startReview);
    const getProgress = useRpc(contracts.getStartProgress);
    const [url, setUrl] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [rejection, setRejection] = useState<string | null>(null);
    const [reviewId, setReviewId] = useState<string | null>(null);
    const [panel, setPanel] = useState<"opening" | "opened" | "unavailable">("opening");

    const progress = useQuery({
      queryKey: [PLUGIN_ID, "start-progress", reviewId],
      queryFn: () => getProgress({ reviewId: reviewId! }),
      enabled: reviewId !== null,
      refetchInterval: (query) => (query.state.data && isFinished(query.state.data.phase) ? false : POLL_MS),
    });
    const current = reviewId === null ? null : (progress.data ?? null);
    const busy = submitting || (current !== null && !isFinished(current.phase));
    const workspaceId = current?.phase === "ready" ? current.workspaceId : null;

    useEffect(() => {
      if (workspaceId === null) return;
      let cancelled = false;
      setPanel("opening");
      void openPanelWhenReady(() => openPanel(workspaceId)).then((opened) => {
        if (!cancelled) setPanel(opened ? "opened" : "unavailable");
      });
      return () => {
        cancelled = true;
      };
    }, [workspaceId]);

    const submit = async () => {
      setSubmitting(true);
      setRejection(null);
      setReviewId(null);
      try {
        const result = await start({ url });
        if (result.status === "rejected") setRejection(result.message);
        else setReviewId(result.reviewId);
      } catch (error) {
        setRejection(error instanceof Error ? error.message : String(error));
      } finally {
        setSubmitting(false);
      }
    };

    const line = current === null ? null : describeProgress(current);
    const number = current?.header ? numberLabel(current.header.forge, current.header.number) : null;
    const status =
      current?.phase === "ready" && panel !== "opening" && number
        ? panel === "opened"
          ? `Opened ${number} in its workspace.`
          : `The workspace for ${number} is ready; open "Review ${number}" from the sidebar.`
        : line?.text;

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
        contentContainerStyle={{
          width: "100%",
          maxWidth: MAX_CONTENT_WIDTH,
          alignSelf: "center",
          padding: layout.compact ? spacing[3] : spacing[4],
          paddingTop: spacing[6],
        }}
      >
        <SettingsSection title="Start a guided review">
          <SettingsCard>
            <SettingsInput
              label="Pull request or merge request URL"
              hint="A GitHub PR, or a GitLab MR on a host glab is logged in to. The guide is prepared in a Paseo workspace checked out at it"
              placeholder="https://github.com/owner/repo/pull/123"
              error={rejection}
              disabled={busy}
              onChangeText={(text) => {
                setUrl(text);
                setRejection(null);
              }}
            />
            <SettingsAction
              label="Read it and open its workspace"
              actionLabel={busy ? "Starting…" : "Start"}
              disabled={busy || url.trim() === ""}
              onPress={() => void submit()}
            />
          </SettingsCard>
          {status ? (
            <Text
              style={{
                color: line?.tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted,
                fontSize: fontSize.sm,
                lineHeight: leading(fontSize.sm),
                marginTop: spacing[2],
              }}
            >
              {status}
            </Text>
          ) : null}
        </SettingsSection>
      </ScrollView>
    );
  };
}
