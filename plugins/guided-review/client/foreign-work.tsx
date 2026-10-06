import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import React, { useState } from "react";
import { View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { ForeignWorkView, ReviewHeader } from "../shared/contracts.ts";
import { changeRequestKind, describeForeignCount, headsUpNote, type ForeignChangeRequest } from "../shared/foreign-work.ts";
import { shortSha } from "../shared/head-change.ts";
import { numberLabel } from "../shared/reference.ts";
import { Button } from "./button.tsx";
import { CommentBox } from "./comment-box.tsx";
import { Line, Section, useFlat } from "./section.tsx";
import { spacing, type Colors } from "./theme.ts";

export type ForeignWorkBannerProps = {
  reviewId: string;
  header: ReviewHeader;
  foreign: ForeignWorkView | undefined;
  colors: Colors;
};

/**
 * "Commits from other MRs": shown while the change request carries commits of others its target does
 * not have, which the diff, and so the guide, shows as its own. The reviewer can ask the author to
 * take them out with a comment they edit first; their own change request they fix themselves.
 */
export function ForeignWorkBanner({ reviewId, header, foreign, colors }: ForeignWorkBannerProps) {
  const flat = useFlat();
  const postHeadsUp = useRpc(contracts.postHeadsUp);
  const [writing, setWriting] = useState(false);
  const [posted, setPosted] = useState(false);
  if (foreign === undefined) return null;

  const { work, viewerIsAuthor } = foreign;
  const kind = changeRequestKind(header.forge);
  const title = `Commits from other ${kind}s`;
  const count = describeForeignCount(work, header.forge);

  return (
    <Section colors={colors} title={title} tone={colors.statusWarning}>
      {flat ? null : (
        <Line colors={colors} color={colors.statusWarning}>
          {title}
        </Line>
      )}
      <Line colors={colors} muted>
        {count.charAt(0).toUpperCase() + count.slice(1)} come from other {kind}s, so the diff and the guide show their changes as this {kind}'s.
        {work.ownFrom === null ? null : ` Its own work starts at ${shortSha(work.ownFrom)}.`}
      </Line>
      {work.changeRequests.map((other) => (
        <View key={other.number} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: spacing[1] }}>
          <ExternalLink href={other.url}>
            {numberLabel(header.forge, other.number)} {other.title}
          </ExternalLink>
          <Line colors={colors} muted>
            · {whereItIs(other)}
          </Line>
        </View>
      ))}
      {viewerIsAuthor ? (
        <Line colors={colors} muted>
          Retarget it, or bring them into {work.targetBranch}, so the diff shows only your own work.
        </Line>
      ) : posted ? (
        <Line colors={colors} muted>
          Your comment is posted on the {kind}.
        </Line>
      ) : writing ? (
        <CommentBox
          colors={colors}
          title={`Comment to ${header.author}`}
          initialBody={headsUpNote(work, header.forge)}
          saveLabel="Post"
          onSave={async (body) => {
            await postHeadsUp({ reviewId, body });
            setPosted(true);
            setWriting(false);
          }}
          onCancel={() => setWriting(false)}
        />
      ) : (
        <View style={{ alignItems: "flex-start" }}>
          <Button colors={colors} label="Ask the author to fix it" onPress={() => setWriting(true)} />
        </View>
      )}
    </Section>
  );
}

function whereItIs(other: ForeignChangeRequest): string {
  return other.state === "merged" ? `merged into ${other.targetBranch}` : `open against ${other.targetBranch}`;
}
