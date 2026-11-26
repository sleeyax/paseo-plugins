import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Pressable, Text } from "react-native";
import { fontSize, iconSize, leading, radius, spacing, touchTarget } from "./theme.ts";

type Variant = "outline" | "primary" | "danger";

export function Button({
  theme,
  label,
  icon,
  variant = "outline",
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  variant?: Variant;
  disabled?: boolean;
  onPress: () => void;
}) {
  const colors = theme.colors;
  const filled = variant === "primary";
  const foreground = filled ? colors.accentForeground : variant === "danger" ? colors.statusDanger : colors.foreground;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({
        minHeight: touchTarget,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing[2],
        paddingHorizontal: spacing[4],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: filled ? colors.accent : variant === "danger" ? colors.statusDanger : colors.border,
        backgroundColor: filled ? colors.accent : colors.surface1,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={iconSize.md} color={foreground} /> : null}
      <Text style={{ color: foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base), fontWeight: filled ? "600" : "400" }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function IconButton({
  theme,
  icon,
  label,
  color,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  /** Accessibility label; the button shows only the icon. */
  label: string;
  color?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={spacing[1]}
      style={({ pressed }) => ({
        width: touchTarget,
        height: touchTarget,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.md,
        opacity: disabled ? 0.35 : pressed ? 0.6 : 1,
      })}
    >
      <Icon name={icon} size={iconSize.lg} color={color ?? theme.colors.foregroundMuted} />
    </Pressable>
  );
}
