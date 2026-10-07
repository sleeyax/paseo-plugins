import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo } from "react";
import { Text } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { Card, Label } from "./guide-view.tsx";
import { useHeadCheck } from "./head-check.tsx";
import { parseMarkdown } from "./markdown.ts";
import { MarkdownView } from "./markdown-view.tsx";
import { shownDescription } from "./shown-description.ts";
import { fontSize, leading, type Colors } from "./theme.ts";

/** The description read with the guide at `headSha`, which only Regenerate changes. */
function useDescription(reviewId: string | null, headSha: string | null) {
  const getDescription = useRpc(contracts.getDescription);
  return useQuery({
    queryKey: [PLUGIN_ID, "description", reviewId, headSha],
    queryFn: () => getDescription({ reviewId: reviewId! }),
    enabled: reviewId !== null && headSha !== null,
    staleTime: Infinity,
  });
}

/** Whether the forge has the description edited since the guide was read, for the navigator to flag. */
export function useDescriptionEdited(reviewId: string | null, headSha: string | null): boolean {
  const description = useDescription(reviewId, headSha).data;
  const head = useHeadCheck(reviewId);
  return description !== undefined && shownDescription(description, head).edited;
}

/** The PR/MR description in full, as the author wrote it; there is nothing to mark or comment on in it. */
export function DescriptionCard({ reviewId, headSha, colors }: { reviewId: string; headSha: string; colors: Colors }) {
  const query = useDescription(reviewId, headSha);
  const description = query.data;
  const head = useHeadCheck(reviewId);
  const shown = description === undefined ? null : shownDescription(description, head);
  const blocks = useMemo(() => (shown === null ? [] : parseMarkdown(shown.text)), [shown?.text]);
  const muted = { color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };

  return (
    <Card colors={colors}>
      <Label colors={colors}>Description</Label>
      {shown?.edited ? <Text style={{ ...muted, color: colors.statusWarning }}>Edited since this guide was written.</Text> : null}
      {query.isError ? (
        <Text style={{ ...muted, color: colors.statusDanger }}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text>
      ) : description === undefined || shown === null ? (
        <Text style={muted}>Reading the description…</Text>
      ) : shown.text.trim() === "" ? (
        <Text style={muted}>The author wrote no description.</Text>
      ) : (
        <MarkdownView blocks={blocks} reviewId={reviewId} projectUrl={description.projectUrl} colors={colors} />
      )}
    </Card>
  );
}
