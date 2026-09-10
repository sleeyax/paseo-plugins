import React, { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import type { PresenceStatusPayload } from "../shared/contracts.ts";
import { BADGE_COLORS } from "../shared/presence.ts";
import { PASEO_ICON_DATA_URL } from "./artwork.ts";
import { formatElapsed } from "./elapsed.ts";
import { fontSize, leading, radius, spacing } from "./theme.ts";
import { MONO_FONT } from "./ui.tsx";

/**
 * Discord's dark activity card, held to its own colours rather than the paseo theme's: the point of
 * the preview is what the other side sees, and it is the same card whichever theme paseo is wearing.
 */
const DISCORD = {
  surface: "#232428",
  raised: "#2b2d31",
  border: "#1e1f22",
  foreground: "#f2f3f5",
  foregroundMuted: "#b5bac1",
  timer: "#3ba55d",
} as const;

const ART_SIZE = 72;
const BADGE_SIZE = 26;
const BADGE_RING = 3;

function useElapsed(startTimestamp: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startTimestamp === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startTimestamp]);
  if (startTimestamp === null) return null;
  return formatElapsed(now - startTimestamp);
}

function Art({ badgeKey }: { badgeKey: string | undefined }) {
  const badgeColor = badgeKey ? BADGE_COLORS[badgeKey] : undefined;
  return (
    <View>
      <Image
        source={{ uri: PASEO_ICON_DATA_URL }}
        accessibilityLabel="Paseo"
        style={{ width: ART_SIZE, height: ART_SIZE, borderRadius: radius.xl, backgroundColor: DISCORD.border }}
      />
      {badgeColor ? (
        <View
          style={{
            position: "absolute",
            right: -BADGE_RING,
            bottom: -BADGE_RING,
            width: BADGE_SIZE,
            height: BADGE_SIZE,
            borderRadius: BADGE_SIZE / 2,
            borderWidth: BADGE_RING,
            borderColor: DISCORD.raised,
            backgroundColor: badgeColor,
          }}
        />
      ) : null}
    </View>
  );
}

export function DiscordPreview({ status }: { status: PresenceStatusPayload }) {
  const activity = status.activity;
  const elapsed = useElapsed(activity?.startTimestamp ?? null);

  return (
    <View
      style={{
        backgroundColor: DISCORD.surface,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: DISCORD.border,
        padding: spacing[4],
        gap: spacing[3],
      }}
    >
      <Text style={{ color: DISCORD.foreground, fontSize: fontSize.base, fontWeight: "600" }}>
        {activity ? "Playing" : "Nothing right now"}
      </Text>
      {activity ? (
        <View style={{ flexDirection: "row", gap: spacing[4], alignItems: "center" }}>
          <Art badgeKey={activity.smallImageKey} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: DISCORD.foreground, fontSize: fontSize.lg, fontWeight: "600" }}>
              {activity.largeImageText}
            </Text>
            <Text numberOfLines={1} style={{ color: DISCORD.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
              {activity.details}
            </Text>
            {activity.state ? (
              <Text numberOfLines={1} style={{ color: DISCORD.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
                {activity.state}
              </Text>
            ) : null}
            {elapsed ? (
              <Text style={{ color: DISCORD.timer, fontFamily: MONO_FONT, fontSize: fontSize.base, marginTop: 2 }}>
                {elapsed} elapsed
              </Text>
            ) : null}
          </View>
        </View>
      ) : (
        <Text style={{ color: DISCORD.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
          Your profile shows no Paseo activity.
        </Text>
      )}
    </View>
  );
}

