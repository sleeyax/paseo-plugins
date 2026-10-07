import type { PluginScreenProps } from "@getpaseo/plugin/client";
import React from "react";
import { ScrollView, View } from "react-native";
import { ReviewInbox } from "./inbox.tsx";
import { MAX_PANEL_WIDTH, spacing } from "./theme.ts";

/**
 * Where a review is started, opened from the sidebar: one picked from the review list, or a PR or MR URL pasted into its New review dialog.
 * A screen is not handed the client context, so the panel opener comes in through the closure.
 */
export function createStartScreen(openPanel: (workspaceId: string) => void) {
  return function StartScreen({ theme, layout }: PluginScreenProps) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
        contentContainerStyle={{ padding: layout.compact ? spacing[3] : spacing[4], paddingTop: spacing[6] }}
      >
        <View style={{ width: "100%", maxWidth: MAX_PANEL_WIDTH, alignSelf: "center" }}>
          <ReviewInbox colors={theme.colors} compact={layout.compact} openPanel={openPanel} />
        </View>
      </ScrollView>
    );
  };
}
