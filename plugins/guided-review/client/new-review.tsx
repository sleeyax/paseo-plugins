import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "./button.tsx";
import type { ReviewStart } from "./start-review.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

/** Where `ReviewStart.from` says a start came from the New review dialog rather than a review list row. */
export const FROM_NEW_REVIEW = "new-review";

/** Starts the review of a pasted URL; the dialog closes once the start began, which the review list then follows. */
export function NewReview({ colors, starter }: { colors: Colors; starter: ReviewStart }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const ours = starter.from === FROM_NEW_REVIEW;
  const blank = url.trim() === "";

  const close = () => {
    setOpen(false);
    setUrl("");
    if (ours && starter.rejection !== null) starter.dismiss();
  };
  const confirm = async () => {
    if (blank || starter.busy) return;
    if (await starter.start(url, FROM_NEW_REVIEW)) {
      setOpen(false);
      setUrl("");
    }
  };

  return (
    <>
      <Button colors={colors} small primary label="New review" disabled={starter.busy} onPress={() => setOpen(true)} />
      <Modal title="New review" open={open} onOpenChange={(next) => (next ? setOpen(true) : starter.busy ? undefined : close())}>
        <Modal.Content>
          <View style={{ gap: spacing[2] }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
              Link to a GitHub PR or GitLab MR to review:
            </Text>
            <TextInput
              value={url}
              onChangeText={(text) => {
                setUrl(text);
                if (ours && starter.rejection !== null) starter.dismiss();
              }}
              onSubmitEditing={() => void confirm()}
              blurOnSubmit={false}
              placeholder="https://github.com/owner/repo/pull/123"
              placeholderTextColor={colors.foregroundMuted}
              editable={!starter.busy}
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
                borderColor: ours && starter.rejection !== null ? colors.statusDanger : colors.border,
                borderRadius: radius.md,
                backgroundColor: colors.surface1,
              }}
            />
            {ours && starter.rejection !== null ? (
              <Text style={{ color: colors.statusDanger, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{starter.rejection}</Text>
            ) : null}
            <View style={{ alignItems: "flex-end", marginTop: spacing[1] }}>
              <Button colors={colors} primary label={starter.busy ? "Starting…" : "Confirm"} disabled={blank || starter.busy} onPress={() => void confirm()} />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
