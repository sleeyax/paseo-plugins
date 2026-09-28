import React from "react";
import { Pressable, Text } from "react-native";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";

/**
 * The panel's one button: outlined, or filled with the accent when `primary`, the one action a step
 * leads to. `small` sets its label in the small size, as in a comment box or Finish review, where it
 * sits among small text.
 */
export function Button({
  colors,
  label,
  primary,
  small,
  disabled,
  onPress,
}: {
  colors: Colors;
  label: string;
  primary?: boolean;
  small?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const size = small ? fontSize.sm : fontSize.base;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({
        paddingVertical: spacing[1],
        paddingHorizontal: spacing[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: primary ? colors.accent : colors.border,
        backgroundColor: primary ? colors.accent : undefined,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text
        style={{
          color: primary ? colors.accentForeground : colors.foreground,
          fontSize: size,
          lineHeight: leading(size),
          fontWeight: primary ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
