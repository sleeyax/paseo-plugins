import { Modal } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { Button } from "./button.tsx";
import { GrowingTextInput } from "./growing-text-input.tsx";
import { pastedUrls } from "./pasted-urls.ts";
import type { ReviewStarts } from "./start-review.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

type Rejected = { url: string; message: string };

/**
 * Starts the review of every URL pasted, one per line, each on its own, which the review list then follows.
 * The URLs turned down stay in the box with the reasons under it; the dialog closes once none are left.
 */
export function NewReview({ colors, starts }: { colors: Colors; starts: ReviewStarts }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [busy, setBusy] = useState(false);
  const urls = pastedUrls(text);

  const close = () => {
    setOpen(false);
    setText("");
    setRejected([]);
  };
  const confirm = async () => {
    if (urls.length === 0 || busy) return;
    setBusy(true);
    const answers = await Promise.all(urls.map(async (url) => ({ url, message: await starts.start(url, { open: false, pasted: true }) })));
    setBusy(false);
    const left = answers.flatMap(({ url, message }) => (message === null ? [] : [{ url, message }]));
    if (left.length === 0) return close();
    setText(left.map((entry) => entry.url).join("\n"));
    setRejected(left);
  };
  // Enter is a new line, so a web keyboard confirms with Ctrl or Cmd held; a native key event carries no modifiers.
  const confirmOnModifiedEnter = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = event.nativeEvent as TextInputKeyPressEventData & { ctrlKey?: boolean; metaKey?: boolean };
    if (key.key !== "Enter" || !(key.ctrlKey || key.metaKey)) return;
    event.preventDefault();
    void confirm();
  };

  return (
    <>
      <Button colors={colors} small primary label="New review" onPress={() => setOpen(true)} />
      <Modal title="New review" open={open} onOpenChange={(next) => (next ? setOpen(true) : busy ? undefined : close())}>
        <Modal.Content>
          <View style={{ gap: spacing[2] }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
              Links to GitHub PRs or GitLab MRs to review, one per line:
            </Text>
            <GrowingTextInput
              value={text}
              onChangeText={(next) => {
                setText(next);
                setRejected([]);
              }}
              onKeyPress={confirmOnModifiedEnter}
              minHeight={72}
              maxHeight={320}
              placeholder="https://github.com/owner/repo/pull/123"
              placeholderTextColor={colors.foregroundMuted}
              editable={!busy}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              keyboardType="url"
              style={{
                color: colors.foreground,
                fontSize: fontSize.base,
                lineHeight: leading(fontSize.base),
                paddingVertical: spacing[1],
                paddingHorizontal: spacing[3],
                borderWidth: 1,
                borderColor: rejected.length > 0 ? colors.statusDanger : colors.border,
                borderRadius: radius.md,
                backgroundColor: colors.surface1,
              }}
            />
            {rejected.map((entry) => (
              <Text key={entry.url} style={{ color: colors.statusDanger, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
                {entry.url}: {entry.message}
              </Text>
            ))}
            <View style={{ alignItems: "flex-end", marginTop: spacing[1] }}>
              <Button
                colors={colors}
                primary
                label={busy ? "Starting…" : urls.length > 1 ? `Start ${urls.length} reviews` : "Start review"}
                disabled={urls.length === 0 || busy}
                onPress={() => void confirm()}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
