import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import React, { useState } from "react";
import { View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { ForeignWorkView, ReviewHeader } from "../shared/contracts.ts";
import { changeRequestKind, describeForeignCount, headsUpNote, type ForeignChangeRequest, type ReviewScope } from "../shared/foreign-work.ts";
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
  /** Called once the guide is being written from the other scope, so the panel follows it. */
  onScopeChosen: () => void;
};

/**
 * "Commits from other MRs": shown while the change request carries commits of others its target does
 * not have, which the diff, and so the guide, shows as its own. The reviewer can ask the author to
 * take them out with a comment they edit first; their own change request they fix themselves. When
 * the own work can be told apart, it switches the guide between the whole diff and the own work.
 */
export function ForeignWorkBanner({ reviewId, header, foreign, colors, onScopeChosen }: ForeignWorkBannerProps) {
  const flat = useFlat();
  const postHeadsUp = useRpc(contracts.postHeadsUp);
  const chooseScope = useRpc(contracts.chooseScope);
  const rescope = useMutation({ mutationFn: (scope: ReviewScope) => chooseScope({ reviewId, scope }), onSuccess: onScopeChosen });
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
      {foreign.scope === null ? null : (
        <>
          <Line colors={colors} muted>
            {foreign.scope === "own"
              ? `This guide explains only the ${kind}'s own work; the files only the others change are listed apart.`
              : "This guide explains the whole diff."}{" "}
            Switching writes a new guide; what you marked understood carries over where the code is the same.
          </Line>
          {rescope.error ? (
            <Line colors={colors} color={colors.statusDanger}>
              {rescope.error instanceof Error ? rescope.error.message : String(rescope.error)}
            </Line>
          ) : null}
          <View style={{ alignItems: "flex-start" }}>
            <Button
              colors={colors}
              label={rescope.isPending ? "Switching…" : foreign.scope === "own" ? "Guide the whole diff" : "Guide own work only"}
              disabled={rescope.isPending}
              onPress={() => rescope.mutate(foreign.scope === "own" ? "full" : "own")}
            />
          </View>
        </>
      )}
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

export type ScopeChoiceProps = {
  reviewId: string;
  header: ReviewHeader;
  foreign: ForeignWorkView | undefined;
  colors: Colors;
  /** Called once the choice is made, so the panel reads the guide being generated. */
  onChosen: () => void;
};

/**
 * Asks, before the guide is generated, whether it is to explain the whole diff or only the files the
 * change request's own work changes, when its own work can be told from the other change requests'.
 */
export function ScopeChoice({ reviewId, header, foreign, colors, onChosen }: ScopeChoiceProps) {
  const chooseScope = useRpc(contracts.chooseScope);
  const choose = useMutation({ mutationFn: (scope: ReviewScope) => chooseScope({ reviewId, scope }), onSuccess: onChosen });
  if (foreign === undefined) return null;

  const { work } = foreign;
  const kind = changeRequestKind(header.forge);
  const count = describeForeignCount(work, header.forge);
  const others = work.changeRequests.map((other) => numberLabel(header.forge, other.number)).join(", ");
  const busy = choose.isPending;
  return (
    <>
      <Line colors={colors}>
        {count.charAt(0).toUpperCase() + count.slice(1)} come from {others}. The guide can explain the whole diff, or only this {kind}'s own work
        {work.ownFrom === null ? "" : `, from ${shortSha(work.ownFrom)} on`}.
      </Line>
      <Line colors={colors} muted>
        With its own work only, the files just the others change are listed apart, unexplained, and a file both change is explained whole.
      </Line>
      {choose.error ? (
        <Line colors={colors} color={colors.statusDanger}>
          {choose.error instanceof Error ? choose.error.message : String(choose.error)}
        </Line>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[2] }}>
        <Button colors={colors} primary label="Own work only" disabled={busy} onPress={() => choose.mutate("own")} />
        <Button colors={colors} label="Whole diff" disabled={busy} onPress={() => choose.mutate("full")} />
      </View>
    </>
  );
}

function whereItIs(other: ForeignChangeRequest): string {
  return other.state === "merged" ? `merged into ${other.targetBranch}` : `open against ${other.targetBranch}`;
}
