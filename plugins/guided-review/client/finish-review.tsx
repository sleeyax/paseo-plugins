import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { ReviewHeader } from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { VERDICT_LABELS, type SubmitResult, type SubmitStep, type Verdict } from "../shared/submit.ts";
import { DraftCard, TextLink, type DraftsControl } from "./drafts.tsx";
import { useSetHeadCheck, type RegenerateControl } from "./head-check.tsx";
import { useFlat } from "./section.tsx";
import { fontSize, leading, radius, spacing, tint, type Colors } from "./theme.ts";
import { Button } from "./button.tsx";
import { GrowingTextInput } from "./growing-text-input.tsx";

export type FinishReviewProps = {
  reviewId: string;
  header: ReviewHeader;
  drafts: DraftsControl;
  colors: Colors;
  /** The panel's one Regenerate, offered here when the head moved. */
  regenerate: RegenerateControl;
  onClose: () => void;
};

/** Finish review in the stack: the bar, opening into the form in its place. */
export function InlineFinishReview(props: Omit<FinishReviewProps, "onClose">) {
  const [open, setOpen] = useState(false);
  return open ? (
    <FinishReview {...props} onClose={() => setOpen(false)} />
  ) : (
    <FinishBar drafts={props.drafts} colors={props.colors} onOpen={() => setOpen(true)} />
  );
}

/**
 * What is waiting to be submitted, and the button that opens Finish review. It takes the accent once
 * every entry is `understood`, as the step the reviewer is on.
 */
export function FinishBar({ drafts, colors, onOpen, understood }: { drafts: DraftsControl; colors: Colors; onOpen: () => void; understood?: boolean }) {
  const flat = useFlat();
  const count = drafts.drafts.length;
  const text = { fontSize: fontSize.base, lineHeight: leading(fontSize.base) };
  const row = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing[2] }}>
      <Text style={{ ...text, color: understood ? colors.foreground : colors.foregroundMuted, flexShrink: 1 }}>
        {count > 0 ? `${count === 1 ? "1 draft" : `${count} drafts`} waiting to be submitted.` : understood ? "Everything is understood." : "Done reading?"}
      </Text>
      <Button small colors={colors} primary label="Finish review" onPress={onOpen} />
    </View>
  );
  if (flat) return <View style={{ padding: spacing[3], backgroundColor: understood ? tint(colors.accent, colors.surface0, 0.12) : undefined }}>{row}</View>;
  return (
    <Card colors={colors} accent={understood}>
      {row}
    </Card>
  );
}

/**
 * "Finish review": the review body and every draft with where it sits, then Approve, Request changes
 * or Comment, or Discard. The server decides which verdicts are on offer and checks again at submit;
 * this only shows what it says, and after a submit, which of its steps landed.
 */
export function FinishReview({ reviewId, header, drafts, colors, regenerate, onClose }: FinishReviewProps) {
  const getFinish = useRpc(contracts.getFinish);
  const saveReviewBody = useRpc(contracts.saveReviewBody);
  const submitReview = useRpc(contracts.submitReview);
  const discardReview = useRpc(contracts.discardReview);
  const setHeadCheck = useSetHeadCheck();
  const finish = useQuery({
    queryKey: [PLUGIN_ID, "finish", reviewId, header.headSha],
    queryFn: () => getFinish({ reviewId }),
  });
  /** The body as edited here; null while it is the one the server has. */
  const [edited, setEdited] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // The banner reads the same head check, so it agrees with the verdicts on offer here.
  useEffect(() => {
    if (finish.data) setHeadCheck(reviewId, finish.data.head);
  }, [finish.data]);

  const saved = finish.data?.body ?? "";
  const body = edited ?? saved;
  const afterPublishing = async () => {
    drafts.refresh();
    await finish.refetch();
    setEdited(null);
  };

  const save = useMutation({
    mutationFn: () => saveReviewBody({ reviewId, body }),
    onSuccess: async () => {
      await finish.refetch();
      setEdited(null);
    },
  });
  const submit = useMutation({
    mutationFn: (verdict: Verdict) =>
      submitReview({ reviewId, headSha: header.headSha, forgeHeadSha: finish.data?.head.forgeHeadSha ?? null, verdict, body }),
    onMutate: () => {
      setResult(null);
      setNotice(null);
    },
    onSuccess: async (answer) => {
      setResult(answer);
      if (answer.status === "refused") await finish.refetch();
      else if (answer.published) await afterPublishing();
      // GitHub's general comments are posted before the review, so some may be out even when it is not.
      else drafts.refresh();
    },
  });
  const discard = useMutation({
    mutationFn: () => discardReview({ reviewId }),
    onMutate: () => {
      setResult(null);
      setNotice(null);
    },
    onSuccess: async () => {
      setConfirmingDiscard(false);
      setNotice("Your pending review was discarded, with its drafts and body.");
      await afterPublishing();
    },
  });

  const text = { fontSize: fontSize.base, lineHeight: leading(fontSize.base) };
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  const busy = save.isPending || submit.isPending || discard.isPending;
  const count = drafts.drafts.length;

  const verdicts = finish.data?.verdicts ?? [];
  const reasons = [...new Set(verdicts.flatMap((option) => (option.reason === null ? [] : [option.reason])))];
  const warnings = [...new Set(verdicts.flatMap((option) => (option.warning === null ? [] : [option.warning])))];
  const offerRegenerate = verdicts.some((option) => option.regenerate);
  const error = [save.error, submit.error, discard.error].find((failure) => failure);

  return (
    <Card colors={colors}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing[2] }}>
        <Text style={{ ...text, color: colors.foreground, fontWeight: "600" }}>Finish review</Text>
        <TextLink colors={colors} label="Close" onPress={onClose} />
      </View>

      {finish.isPending ? (
        <Text style={{ ...text, color: colors.foregroundMuted }}>Reading your review…</Text>
      ) : finish.isError ? (
        <Text style={{ ...text, color: colors.statusDanger }}>{messageOf(finish.error)}</Text>
      ) : (
        <>
          <Text style={{ ...small, color: colors.foregroundMuted, fontWeight: "600" }}>Review body</Text>
          <GrowingTextInput
            value={body}
            onChangeText={setEdited}
            minHeight={96}
            maxHeight={400}
            editable={!busy}
            placeholder="What you think of the change as a whole (optional)"
            placeholderTextColor={colors.foregroundMuted}
            accessibilityLabel="Review body"
            style={{
              padding: spacing[2],
              borderRadius: radius.base,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface0,
              color: colors.foreground,
              ...text,
              textAlignVertical: "top",
            }}
          />
          {header.forge === "github" && drafts.drafts.some((draft) => draft.location.kind === "general") ? (
            <Text style={{ ...small, color: colors.foregroundMuted }}>
              Your comments on concepts, listed below, go after this text in the review body, a paragraph each.
            </Text>
          ) : null}
          {body !== saved ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
              <Button small colors={colors} label={save.isPending ? "Saving…" : "Save body"} disabled={busy} onPress={() => save.mutate()} />
              <Text style={{ ...small, color: colors.foregroundMuted }}>Unsaved; a submit sends it as it is here.</Text>
            </View>
          ) : null}

          <Text style={{ ...small, color: colors.foregroundMuted, fontWeight: "600" }}>
            {count === 0 ? "No drafts" : count === 1 ? "1 draft" : `${count} drafts`}
          </Text>
          {drafts.loading ? (
            <Text style={{ ...text, color: colors.foregroundMuted }}>Reading your drafts…</Text>
          ) : drafts.error ? (
            <Text style={{ ...text, color: colors.statusDanger }}>{drafts.error}</Text>
          ) : (
            drafts.drafts.map((draft) => <DraftCard key={draft.id} control={drafts} draft={draft} place="finish" colors={colors} showPath />)
          )}

          {warnings.map((warning) => (
            <Text key={warning} style={{ ...small, color: colors.statusWarning }}>
              {warning}
            </Text>
          ))}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing[2] }}>
            {verdicts.map((option) => (
              <Button small
                key={option.verdict}
                colors={colors}
                primary={option.allowed}
                label={submit.isPending && submit.variables === option.verdict ? "Submitting…" : VERDICT_LABELS[option.verdict]}
                disabled={busy || !option.allowed}
                onPress={() => submit.mutate(option.verdict)}
              />
            ))}
          </View>
          {reasons.map((reason) => (
            <Text key={reason} style={{ ...small, color: colors.foregroundMuted }}>
              {reason}
            </Text>
          ))}
          {offerRegenerate ? (
            <View style={{ gap: spacing[1], alignItems: "flex-start" }}>
              <Button small
                colors={colors}
                label={regenerate.busy ? "Regenerating…" : "Regenerate the guide"}
                disabled={regenerate.busy}
                onPress={regenerate.run}
              />
              {regenerate.status ? <Text style={{ ...small, color: colors.foregroundMuted }}>{regenerate.status}</Text> : null}
              {regenerate.error ? <Text style={{ ...small, color: colors.statusDanger }}>{regenerate.error}</Text> : null}
            </View>
          ) : null}

          {result ? <SubmitReport result={result} colors={colors} /> : null}
          {notice ? <Text style={{ ...text, color: colors.foreground }}>{notice}</Text> : null}
          {error ? <Text style={{ ...text, color: colors.statusDanger }}>{messageOf(error)}</Text> : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing[2] }}>
            {confirmingDiscard ? (
              <>
                <Text style={{ ...small, color: colors.foreground }}>
                  Discard your pending review{count > 0 ? ` and its ${count === 1 ? "draft" : `${count} drafts`}` : ""}? This cannot be undone.
                </Text>
                <Button small colors={colors} label={discard.isPending ? "Discarding…" : "Discard"} disabled={busy} onPress={() => discard.mutate()} />
                <Button small colors={colors} label="Keep" disabled={discard.isPending} onPress={() => setConfirmingDiscard(false)} />
              </>
            ) : (
              <TextLink colors={colors} label="Discard review" onPress={() => setConfirmingDiscard(true)} />
            )}
          </View>
        </>
      )}
    </Card>
  );
}

const STEP_LABELS: Record<SubmitStep["status"], string> = { done: "Done", failed: "Failed", skipped: "Not tried" };

/** What a submit did, step by step, so a partial failure says what is left to do on the forge. */
function SubmitReport({ result, colors }: { result: SubmitResult; colors: Colors }) {
  const text = { fontSize: fontSize.base, lineHeight: leading(fontSize.base) };
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  if (result.status === "refused") return <Text style={{ ...text, color: colors.statusWarning }}>{result.message}</Text>;

  const summary = {
    submitted: { text: "Your review was submitted.", color: colors.statusSuccess },
    partial: { text: "Only part of your review went through. What failed below is left to do on the forge.", color: colors.statusWarning },
    failed: { text: "Your review was not submitted; your drafts are still pending.", color: colors.statusDanger },
  }[result.status];
  const tone = { done: colors.statusSuccess, failed: colors.statusDanger, skipped: colors.foregroundMuted };

  return (
    <View style={{ gap: spacing[1] }}>
      <Text style={{ ...text, color: summary.color }}>{summary.text}</Text>
      {result.status === "submitted" && result.steps.length === 1
        ? null
        : result.steps.map((step, index) => (
            <Text key={`${step.id}-${index}`} style={{ ...small, color: colors.foreground }}>
              <Text style={{ color: tone[step.status], fontWeight: "600" }}>{STEP_LABELS[step.status]}</Text>
              {`  ${step.label}`}
              {step.message ? <Text style={{ color: colors.foregroundMuted }}>{`: ${step.message}`}</Text> : null}
            </Text>
          ))}
    </View>
  );
}

function Card({ colors, accent, children }: { colors: Colors; accent?: boolean | undefined; children: React.ReactNode }) {
  return (
    <View
      style={{
        gap: spacing[2],
        padding: spacing[4],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: accent ? colors.accent : colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
