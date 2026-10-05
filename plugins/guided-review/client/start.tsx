import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ReviewInbox } from "./inbox.tsx";
import { useStartReview, type ReviewStart } from "./start-review.ts";
import { fontSize, leading, MAX_CONTENT_WIDTH, MAX_PANEL_WIDTH, spacing, type Colors } from "./theme.ts";

/** Where `ReviewStart.from` says a start came from the URL card rather than a review list row. */
const FROM_URL = "url";

/**
 * Where a review is started, opened from the sidebar: a PR or MR URL pasted in, or one picked from
 * the review list under it, which is wider since it lays its rows out as a table.
 * A surface is not handed the client context, so the panel opener comes in through the closure.
 */
export function createStartSurface(openPanel: (workspaceId: string) => void) {
  return function StartSurface({ theme, layout }: PluginSurfaceProps) {
    const starter = useStartReview(openPanel);
    const column = (maxWidth: number) => ({ width: "100%" as const, maxWidth, alignSelf: "center" as const });

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
        contentContainerStyle={{ padding: layout.compact ? spacing[3] : spacing[4], paddingTop: spacing[6], gap: spacing[6] }}
      >
        <View style={column(MAX_CONTENT_WIDTH)}>
          <UrlStart colors={theme.colors} starter={starter} />
        </View>
        <View style={column(MAX_PANEL_WIDTH)}>
          <ReviewInbox colors={theme.colors} compact={layout.compact} starter={starter} />
        </View>
      </ScrollView>
    );
  };
}

function UrlStart({ colors, starter }: { colors: Colors; starter: ReviewStart }) {
  const [url, setUrl] = useState("");
  const ours = starter.from === FROM_URL;
  const status = ours ? starter.status : null;

  return (
    <SettingsSection title="Start a guided review">
      <SettingsCard>
        <SettingsInput
          label="Pull request or merge request URL"
          hint="A GitHub PR, or a GitLab MR on a host glab is logged in to. The guide is prepared in a Paseo workspace checked out at it"
          placeholder="https://github.com/owner/repo/pull/123"
          error={ours ? starter.rejection : null}
          disabled={starter.busy}
          onChangeText={(text) => {
            setUrl(text);
            if (ours) starter.dismiss();
          }}
        />
        <SettingsAction
          label="Read it and open its workspace"
          actionLabel={starter.busy && ours ? "Starting…" : "Start"}
          disabled={starter.busy || url.trim() === ""}
          onPress={() => void starter.start(url, FROM_URL)}
        />
      </SettingsCard>
      {status ? (
        <Text
          style={{
            color: status.tone === "danger" ? colors.statusDanger : colors.foregroundMuted,
            fontSize: fontSize.sm,
            lineHeight: leading(fontSize.sm),
            marginTop: spacing[2],
          }}
        >
          {status.text}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
