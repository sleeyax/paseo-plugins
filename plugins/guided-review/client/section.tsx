import React, { createContext, useContext } from "react";
import { Text, View } from "react-native";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

/**
 * Whether sections are panes of the grid rather than cards of the stack. In a column of its own a
 * card's border and padding only box the column in again, and take its width from every row.
 */
export const FlatContext = createContext(false);

/**
 * One part of the panel's chrome: a card in the stack, and in the grid a block under a header strip
 * naming it, with `action` at the strip's end, divided from the next by a line. `tone` colours a
 * card's border, or a strip's title, for a section that warns.
 */
export function Section({
  colors,
  title,
  action,
  tone,
  children,
}: {
  colors: Colors;
  title: string;
  action?: React.ReactNode;
  tone?: string | undefined;
  children: React.ReactNode;
}) {
  const flat = useContext(FlatContext);
  if (!flat) {
    return (
      <View
        style={{
          gap: spacing[2],
          padding: spacing[4],
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: tone ?? colors.border,
          backgroundColor: colors.surface1,
        }}
      >
        {children}
      </View>
    );
  }
  return (
    <View style={{ borderBottomWidth: 1, borderColor: colors.border }}>
      <Strip colors={colors} title={title} action={action} tone={tone} />
      <View style={{ gap: spacing[2], paddingHorizontal: spacing[3], paddingBottom: spacing[3] }}>{children}</View>
    </View>
  );
}

export function Strip({ colors, title, action, tone }: { colors: Colors; title: string; action?: React.ReactNode; tone?: string | undefined }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2], paddingHorizontal: spacing[3], paddingVertical: spacing[2] }}>
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          color: tone ?? colors.foregroundMuted,
          fontSize: 11,
          lineHeight: leading(fontSize.sm),
          fontWeight: "600",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {title}
      </Text>
      {action}
    </View>
  );
}

/** Whether the section drawing this is a flat pane, for content that draws its own title only on a card. */
export function useFlat(): boolean {
  return useContext(FlatContext);
}

/** A line of a section's prose, muted for what explains rather than tells, or in `color` for one that warns. */
export function Line({ colors, muted, color, children }: { colors: Colors; muted?: boolean; color?: string; children: React.ReactNode }) {
  return (
    <Text
      style={{
        color: color ?? (muted ? colors.foregroundMuted : colors.foreground),
        fontSize: fontSize.base,
        lineHeight: leading(fontSize.base),
      }}
    >
      {children}
    </Text>
  );
}
