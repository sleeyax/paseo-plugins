import React, { useContext } from "react";
import { View } from "react-native";
import { subjectKey, type CommentSubject, type GuideSubject } from "../shared/contracts.ts";
import { Button } from "./button.tsx";
import { CommentBox } from "./comment-box.tsx";
import { DraftsContext } from "./drafts.tsx";
import type { Colors } from "./theme.ts";

/**
 * The panel's "Ask about this", shared by every place that offers it: a node, and an entry of the
 * Supporting or Unsorted group. It opens a box for the reviewer's question, which "Ask agent" sends
 * to the guide agent about the subject. Nothing where "Ask agent" is not offered: outside a review,
 * or on a host that cannot open the agent's chat.
 */
export function AskAction({ subject, colors }: { subject: GuideSubject; colors: Colors }) {
  const control = useContext(DraftsContext);
  if (control === null || control.askQuestion === null) return null;
  const { askQuestion } = control;
  const place = `ask:${subjectKey(subject)}`;
  if (control.open?.kind === "ask" && control.open.place === place) {
    return (
      <CommentBox
        colors={colors}
        title={subject.kind === "node" ? "Ask the guide agent about this concept" : `Ask the guide agent about ${subject.path}`}
        onAsk={(question) => askQuestion(questionSubjectOf(subject), question)}
        onCancel={() => control.setOpen(null)}
      />
    );
  }
  return (
    <View style={{ alignItems: "flex-start" }}>
      <Button small colors={colors} label="Ask about this" onPress={() => control.setOpen({ kind: "ask", place })} />
    </View>
  );
}

/** A Supporting or Unsorted entry is asked about as its file as a whole, whose prompt names where the guide put it. */
function questionSubjectOf(subject: GuideSubject): CommentSubject {
  return subject.kind === "node" ? { kind: "node", nodeId: subject.nodeId } : { kind: "code", location: { kind: "file", path: subject.path } };
}
