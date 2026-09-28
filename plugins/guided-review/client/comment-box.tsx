import React, { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";
import { Button } from "./button.tsx";

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
  initialBody?: string;
  saveLabel?: string;
  /** Saves the text, trimmed; a failure is shown in the box, which stays open with the text. */
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
  actions?: readonly CommentBoxAction[];
};

/** The one box every comment is written and edited in, wherever it is anchored. */
export function CommentBox({ colors, title, initialBody = "", saveLabel = "Save draft", onSave, onCancel, actions = [] }: CommentBoxProps) {
  const [body, setBody] = useState(initialBody);
  /** What is running: "save", or an action's label. */
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
      <TextInput
        value={body}
        onChangeText={setBody}
        multiline
        autoFocus
        editable={running === null}
        placeholder="Leave a comment"
        placeholderTextColor={colors.foregroundMuted}
        accessibilityLabel={title}
        style={{
          minHeight: 72,
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
        <Button small
          colors={colors}
          primary
          label={running === "save" ? "Saving…" : saveLabel}
          disabled={running !== null || body.trim() === ""}
          onPress={() => void run("save", () => onSave(body.trim()))}
        />
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

