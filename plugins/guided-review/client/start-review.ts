import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import * as contracts from "../shared/contracts.ts";
import type { ReviewHeader } from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { numberLabel } from "../shared/reference.ts";
import { openPanelWhenReady } from "./open-panel.ts";
import { describeProgress, isFinished, type Tone } from "./start-progress.ts";

const POLL_MS = 1_000;

/** Starting a review from the start surface: the New review dialog's and every review list row's one job. */
export type ReviewStart = {
  /** Starts the review `url` names; `from` says where, so only that place shows how it goes. True once it began. */
  start(url: string, from: string): Promise<boolean>;
  /** Where the latest start came from; null before any. */
  from: string | null;
  busy: boolean;
  /** Why the latest start was turned down before it began. */
  rejection: string | null;
  /** The latest start once it began: the URL it was given, and the change request once that was read. */
  started: { url: string; header: ReviewHeader | null } | null;
  /** Forgets the latest start, as once the URL it was turned down for is edited or its line is closed. */
  dismiss(): void;
  /** How the latest start is going, once it began. */
  status: { text: string; tone: Tone } | null;
};

/**
 * Starts a review, follows its background job and opens its panel once the workspace is ready, listing the reviews again so its row shows it.
 * One start at a time, so a second waits on `busy`.
 */
export function useStartReview(openPanel: (workspaceId: string) => void): ReviewStart {
  const startReview = useRpc(contracts.startReview);
  const getProgress = useRpc(contracts.getStartProgress);
  const queryClient = useQueryClient();
  const [from, setFrom] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
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
    void queryClient.invalidateQueries({ queryKey: [PLUGIN_ID, "inbox"] });
    let cancelled = false;
    setPanel("opening");
    void openPanelWhenReady(() => openPanel(workspaceId)).then((opened) => {
      if (!cancelled) setPanel(opened ? "opened" : "unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const start = async (target: string, origin: string) => {
    setFrom(origin);
    setSubmitting(true);
    setRejection(null);
    setReviewId(null);
    try {
      const result = await startReview({ url: target });
      if (result.status === "rejected") {
        setRejection(result.message);
        return false;
      }
      setUrl(target.trim());
      setReviewId(result.reviewId);
      return true;
    } catch (error) {
      setRejection(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const dismiss = () => {
    setFrom(null);
    setRejection(null);
    setReviewId(null);
  };

  const line = current === null ? null : describeProgress(current);
  const number = current?.header ? numberLabel(current.header.forge, current.header.number) : null;
  const status =
    current?.phase === "ready" && panel !== "opening" && number
      ? {
          text: panel === "opened" ? `Opened ${number} in its workspace.` : `The workspace for ${number} is ready; open "Review ${number}" from the sidebar.`,
          tone: "muted" as const,
        }
      : line;

  const started = reviewId === null ? null : { url, header: current?.header ?? null };

  return { start, from, busy, rejection, started, dismiss, status };
}
