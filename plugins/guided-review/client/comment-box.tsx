import React, { useState } from "react";
import { Text, View } from "react-native";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";
import { Button } from "./button.tsx";
import { GrowingTextInput } from "./growing-text-input.tsx";

/**
 * An extra button in a comment box that rewrites its text, like "Suggest wording": it gets what the
 * reviewer has typed and returns what the box should hold instead. Nothing is saved; the reviewer
 * reads, edits and saves the result like their own.
 */
export type CommentBoxAction = {
  label: string;
  /** Shown on the button while `run` is out. */
  runningLabel?: string;
  run: (body: string) => Promise<string>;
};

export type CommentBoxProps = {
  colors: Colors;
  /** What the comment is on, as a heading: "Comment on lines 10–14". */
  title: string;
  /** The text of the guide the comment is about, when the reviewer highlighted some. */
  quote?: string | undefined;
  /** Whether the box takes focus as it opens, which it does unless that would clear a highlight the reviewer may want to copy. */
  autoFocus?: boolean;
  initialBody?: string;
  saveLabel?: string;
  /** Saves the text, trimmed; a failure is shown in the box, which stays open with the text. Without it the box only asks, through `onAsk`. */
  onSave?: ((body: string) => Promise<void>) | undefined;
  /** "Ask agent": sends the text, trimmed, to the guide agent as a question instead of saving it; a failure is shown as `onSave`'s is. */
  onAsk?: ((question: string) => Promise<void>) | undefined;
  onCancel: () => void;
  actions?: readonly CommentBoxAction[];
};

/** The one box every comment is written and edited in, wherever it is anchored. */
export function CommentBox({
  colors,
  title,
  quote,
  autoFocus = true,
  initialBody = "",
  saveLabel = "Save draft",
  onSave,
  onAsk,
  onCancel,
  actions = [],
}: CommentBoxProps) {
  const [body, setBody] = useState(initialBody);
  /** What is running: "save", "ask", or an action's label. */
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };

  const run = async (key: string, work: () => Promise<void>) => {
    setRunning(key);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(null);
    }
  };

  return (
    <View
      style={{
        gap: spacing[2],
        padding: spacing[2],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.accent,
        backgroundColor: colors.surface1,
      }}
    >
      <Text style={{ ...small, color: colors.foregroundMuted, fontWeight: "600" }}>{title}</Text>
      {quote === undefined ? null : <Quote colors={colors} text={quote} />}
      <GrowingTextInput
        value={body}
        onChangeText={setBody}
        minHeight={72}
        maxHeight={320}
        autoFocus={autoFocus}
        editable={running === null}
        placeholder={!onSave ? "Ask the guide agent" : onAsk ? "Leave a comment, or ask the guide agent" : "Leave a comment"}
        placeholderTextColor={colors.foregroundMuted}
        accessibilityLabel={title}
        style={{
          padding: spacing[2],
          borderRadius: radius.base,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          color: colors.foreground,
          fontSize: fontSize.base,
          lineHeight: leading(fontSize.base),
          textAlignVertical: "top",
        }}
      />
      {error ? <Text style={{ ...small, color: colors.statusDanger }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing[2] }}>
        {onSave ? (
          <Button small
            colors={colors}
            primary
            label={running === "save" ? "Saving…" : saveLabel}
            disabled={running !== null || body.trim() === ""}
            onPress={() => void run("save", () => onSave(body.trim()))}
          />
        ) : null}
        {onAsk ? (
          <Button small
            colors={colors}
            primary={!onSave}
            label={running === "ask" ? "Asking…" : "Ask agent"}
            disabled={running !== null || body.trim() === ""}
            onPress={() => void run("ask", () => onAsk(body.trim()))}
          />
        ) : null}
        {actions.map((action) => (
          <Button small
            key={action.label}
            colors={colors}
            label={running === action.label ? (action.runningLabel ?? `${action.label}…`) : action.label}
            disabled={running !== null}
            onPress={() => void run(action.label, async () => setBody(await action.run(body)))}
          />
        ))}
        <Button small colors={colors} label="Cancel" disabled={running === "save"} onPress={onCancel} />
      </View>
    </View>
  );
}

/**
 * Text of the guide a comment is about, as the reviewer highlighted it, which is kept on this machine
 * and never posted. `earlier` says it is from a guide the one shown has replaced, so it is greyed.
 */
export function Quote({ colors, text, earlier }: { colors: Colors; text: string; earlier?: boolean }) {
  const small = { fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) };
  return (
    <View style={{ gap: spacing[1], paddingLeft: spacing[2], borderLeftWidth: 2, borderLeftColor: colors.border, opacity: earlier ? 0.6 : 1 }}>
      <Text numberOfLines={4} style={{ ...small, color: colors.foregroundMuted, fontStyle: "italic" }}>
        {text}
      </Text>
      {earlier ? <Text style={{ ...small, color: colors.foregroundMuted }}>From an earlier guide</Text> : null}
    </View>
  );
}
