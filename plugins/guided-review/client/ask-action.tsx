import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { subjectKey, type GuideSubject } from "../shared/contracts.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

/**
 * The panel's "Ask about this", shared by every place that offers it: a node, and an entry of the
 * Supporting or Unsorted group. The panel sends and opens the agent's chat; this only shows the
 * action and, under the subject that asked, why nothing was sent.
 */
export type AskControl = {
  run: (subject: GuideSubject) => void;
  /** The `subjectKey` of the subject being asked about, while the request is out. */
  pendingKey: string | null;
  /** Why the last ask sent nothing, under the subject it was about. */
  notice: { key: string; message: string } | null;
};

/**
 * The panel's side of "Ask about this": sends through the `askAbout` RPC and opens the guide agent's
 * chat once the prompt is in it, or keeps the reason nothing was sent for `AskAction` to show.
 */
export function useAskAbout(reviewId: string | null, openAgent: ((agentId: string) => void) | undefined): AskControl {
  const askAbout = useRpc(contracts.askAbout);
  const [notice, setNotice] = useState<AskControl["notice"]>(null);
  const mutation = useMutation({
    mutationFn: ({ reviewId, subject }: { reviewId: string; subject: GuideSubject }) => askAbout({ reviewId, subject }),
    onMutate: () => setNotice(null),
    onSuccess: (result, { subject }) => {
      const key = subjectKey(subject);
      if (result.status === "not-sent") setNotice({ key, message: result.message });
      else if (openAgent) openAgent(result.agentId);
      else setNotice({ key, message: "Sent. Open the guide agent's chat to read the answer." });
    },
    onError: (error, { subject }) =>
      setNotice({ key: subjectKey(subject), message: error instanceof Error ? error.message : String(error) }),
  });
  return {
    run: (subject) => {
      if (reviewId !== null) mutation.mutate({ reviewId, subject });
    },
    pendingKey: mutation.isPending && mutation.variables ? subjectKey(mutation.variables.subject) : null,
    notice,
  };
}

export function AskAction({ subject, ask, colors }: { subject: GuideSubject; ask: AskControl; colors: Colors }) {
  const key = subjectKey(subject);
  const pending = ask.pendingKey === key;
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  return (
    <View style={{ gap: spacing[1], alignItems: "flex-start" }}>
      <Pressable
        onPress={() => ask.run(subject)}
        disabled={ask.pendingKey !== null}
        accessibilityRole="button"
        accessibilityLabel="Ask the guide agent about this"
        style={({ pressed }) => ({
          paddingVertical: spacing[1],
          paddingHorizontal: spacing[2],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          opacity: ask.pendingKey !== null ? 0.5 : pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ ...small, color: colors.foreground }}>{pending ? "Asking…" : "Ask about this"}</Text>
      </Pressable>
      {ask.notice?.key === key ? <Text style={{ ...small, color: colors.statusWarning }}>{ask.notice.message}</Text> : null}
    </View>
  );
}
