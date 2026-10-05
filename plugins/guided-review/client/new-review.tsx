import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "./button.tsx";
import type { ReviewStarts } from "./start-review.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

/** Starts the review of a pasted URL; the dialog closes once the start began, which the review list then follows. */
export function NewReview({ colors, starts }: { colors: Colors; starts: ReviewStarts }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [rejection, setRejection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blank = url.trim() === "";

  const close = () => {
    setOpen(false);
    setUrl("");
    setRejection(null);
  };
  const confirm = async () => {
    if (blank || busy) return;
    setBusy(true);
    const turnedDown = await starts.start(url, { open: false, pasted: true });
    setBusy(false);
    if (turnedDown === null) close();
    else setRejection(turnedDown);
  };

  return (
    <>
      <Button colors={colors} small primary label="New review" onPress={() => setOpen(true)} />
      <Modal title="New review" open={open} onOpenChange={(next) => (next ? setOpen(true) : busy ? undefined : close())}>
        <Modal.Content>
          <View style={{ gap: spacing[2] }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
              Link to a GitHub PR or GitLab MR to review:
            </Text>
            <TextInput
              value={url}
              onChangeText={(text) => {
                setUrl(text);
                setRejection(null);
              }}
              onSubmitEditing={() => void confirm()}
              blurOnSubmit={false}
              placeholder="https://github.com/owner/repo/pull/123"
              placeholderTextColor={colors.foregroundMuted}
              editable={!busy}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              keyboardType="url"
              returnKeyType="go"
              style={{
                color: colors.foreground,
                fontSize: fontSize.base,
                lineHeight: leading(fontSize.base),
                paddingVertical: spacing[1],
                paddingHorizontal: spacing[3],
                borderWidth: 1,
                borderColor: rejection !== null ? colors.statusDanger : colors.border,
                borderRadius: radius.md,
                backgroundColor: colors.surface1,
              }}
            />
            {rejection !== null ? (
              <Text style={{ color: colors.statusDanger, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{rejection}</Text>
            ) : null}
            <View style={{ alignItems: "flex-end", marginTop: spacing[1] }}>
              <Button colors={colors} primary label={busy ? "Starting…" : "Confirm"} disabled={blank || busy} onPress={() => void confirm()} />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
