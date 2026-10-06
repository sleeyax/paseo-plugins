import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { ForeignWorkView, ReviewHeader } from "../shared/contracts.ts";
import { changeRequestKind, describeForeignCount, headsUpNote, type ForeignChangeRequest, type ReviewScope } from "../shared/foreign-work.ts";
import { shortSha } from "../shared/head-change.ts";
import { numberLabel } from "../shared/reference.ts";
import { Button } from "./button.tsx";
import { CommentBox } from "./comment-box.tsx";
import { openLink } from "./open-link.ts";
import { Line, Section, useFlat } from "./section.tsx";
import { spacing, tint, type Colors } from "./theme.ts";

export type ForeignWorkBannerProps = {
  reviewId: string;
  header: ReviewHeader;
  foreign: ForeignWorkView | undefined;
  colors: Colors;
  /** The guide waits for the reviewer to choose what it explains, which the banner then asks. */
  choosing: boolean;
  /** Called once the guide is being written from the chosen scope, so the panel follows it. */
  onScopeChosen: () => void;
};

/**
 * "Commits from other MRs": shown while the change request carries commits of others its target does
 * not have, which the diff, and so the guide, shows as its own. The reviewer can ask the author to
 * take them out with a comment they edit first; their own change request they fix themselves. When
 * the own work can be told apart, it asks whether the guide explains the whole diff or the own work,
 * and once there is a guide, switches it to the other.
 */
export function ForeignWorkBanner({ reviewId, header, foreign, colors, choosing, onScopeChosen }: ForeignWorkBannerProps) {
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
  const labels = work.changeRequests.map((other) => numberLabel(header.forge, other.number));
  const theirChanges = labels.length === 1 ? `${labels[0]}'s changes` : `the changes from ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  const commits = `${work.truncated ? "at least " : ""}${work.foreignCommits} ${work.foreignCommits === 1 ? "commit" : "commits"}`;
  const from = work.changeRequests.length === 1 ? `another ${kind}` : `other ${kind}s`;
  const intro = `This ${kind}'s diff includes ${commits} from ${from} that ${work.targetBranch} doesn't have yet:`;
  const switchable = choosing || foreign.scope !== null;
  const askable = !viewerIsAuthor && !posted && !writing;

  return (
    <Section colors={colors} title={title} tone={colors.statusWarning}>
      {flat ? null : (
        <Line colors={colors} color={colors.statusWarning}>
          {title}
        </Line>
      )}
      <Line colors={colors}>{intro}</Line>
      {work.changeRequests.map((other) => (
        <View key={other.number} style={{ paddingLeft: spacing[3] }}>
          <Line colors={colors}>
            • {other.commits.length} {other.commits.length === 1 ? "commit" : "commits"} from{" "}
            <Text accessibilityRole="link" onPress={() => void openLink(other.url)} style={{ color: colors.accent, textDecorationLine: "underline" }}>
              {numberLabel(header.forge, other.number)} {other.title}
            </Text>{" "}
            ({whereItIs(other)})
          </Line>
        </View>
      ))}
      {work.ownFrom === null ? null : (
        <Line colors={colors}>
          This {kind}'s own work starts at {shortSha(work.ownFrom)}.
        </Line>
      )}
      {choosing ? (
        <Line colors={colors}>
          Choose what the guide should cover: only this {kind}'s own work, or the whole diff including {theirChanges}.
        </Line>
      ) : foreign.scope === null ? null : (
        <Line colors={colors}>
          {foreign.scope === "own"
            ? `This guide explains only the ${kind}'s own work; the files only the others change are listed apart.`
            : "This guide explains the whole diff."}{" "}
          Switching writes a new guide; what you marked understood carries over where the code is the same.
        </Line>
      )}
      {viewerIsAuthor ? (
        <Line colors={colors}>
          Retarget it, or bring them into {work.targetBranch}, so the diff shows only your own work.
        </Line>
      ) : posted ? (
        <Line colors={colors}>
          Your comment is posted on the {kind}.
        </Line>
      ) : null}
      {!switchable && !askable ? null : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[2] }}>
          {choosing ? (
            <>
              <Button colors={colors} primary label="Own work only" disabled={rescope.isPending} onPress={() => rescope.mutate("own")} />
              <Button colors={colors} label="Whole diff" disabled={rescope.isPending} onPress={() => rescope.mutate("full")} />
            </>
          ) : foreign.scope === null ? null : (
            <Button
              colors={colors}
              label={rescope.isPending ? "Switching…" : foreign.scope === "own" ? "Guide the whole diff" : "Guide own work only"}
              disabled={rescope.isPending}
              onPress={() => rescope.mutate(foreign.scope === "own" ? "full" : "own")}
            />
          )}
          {askable ? <Button colors={colors} label="Ask the author to fix it" onPress={() => setWriting(true)} /> : null}
        </View>
      )}
      {rescope.error ? (
        <Line colors={colors} color={colors.statusDanger}>
          {rescope.error instanceof Error ? rescope.error.message : String(rescope.error)}
        </Line>
      ) : null}
      {writing ? (
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
      ) : null}
    </Section>
  );
}

export type ForeignWorkStripProps = {
  header: ReviewHeader;
  foreign: ForeignWorkView | undefined;
  colors: Colors;
  /** Opens the overview, whose banner says which change requests and offers what to do. */
  onFix: () => void;
};

/**
 * The foreign work in one line across the top of the guide's pane, on every page, so a reviewer
 * reading the guide cannot miss it, with Fix to go where it can be dealt with.
 */
export function ForeignWorkStrip({ header, foreign, colors, onFix }: ForeignWorkStripProps) {
  if (foreign === undefined) return null;
  const count = describeForeignCount(foreign.work, header.forge);
  const others = foreign.work.changeRequests.map((other) => numberLabel(header.forge, other.number)).join(", ");
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing[2],
        paddingVertical: spacing[2],
        paddingHorizontal: spacing[4],
        borderBottomWidth: 1,
        borderColor: colors.statusWarning,
        backgroundColor: tint(colors.statusWarning, colors.surface0, 0.14),
      }}
    >
      <Line colors={colors} color={colors.statusWarning}>
        ⚠
      </Line>
      <View style={{ flex: 1 }}>
        <Line colors={colors}>
          {count.charAt(0).toUpperCase() + count.slice(1)} come from {others}.
        </Line>
      </View>
      <Button small colors={colors} label="Fix" onPress={onFix} />
    </View>
  );
}

/**
 * What the guide shows while it waits on the choice the banner asks for: on the Issues page, which
 * `onOpen` opens, or above, in the stack, which has none.
 */
export function IssuesPending({ header, colors, onOpen }: { header: ReviewHeader; colors: Colors; onOpen: (() => void) | null }) {
  const kind = changeRequestKind(header.forge);
  if (onOpen === null) return <Line colors={colors}>The guide is not written yet: choose what it explains in the warning about this {kind}'s commits above.</Line>;
  return (
    <>
      <Line colors={colors}>The guide is not written yet: this {kind} has issues to settle first.</Line>
      <View style={{ alignItems: "flex-start" }}>
        <Button colors={colors} primary label="Open Issues" onPress={onOpen} />
      </View>
    </>
  );
}

function whereItIs(other: ForeignChangeRequest): string {
  return other.state === "merged" ? `merged into ${other.targetBranch}` : `open against ${other.targetBranch}`;
}
