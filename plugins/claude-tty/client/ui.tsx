import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Modal, Platform, Pressable, Text, View } from "react-native";
import {
  controlHeight,
  derivePalette,
  fontSize,
  iconSize,
  leading,
  radius,
  spacing,
  switchGeometry,
  type Palette,
} from "./theme.ts";

export function usePalette(theme: PluginTheme): Palette {
  const colors = theme.colors;
  return useMemo(
    () => derivePalette(theme),
    [
      colors.surface0,
      colors.surface1,
      colors.surface2,
      colors.border,
      colors.foreground,
      colors.foregroundMuted,
      colors.accent,
      colors.accentForeground,
      colors.statusSuccess,
      colors.statusWarning,
      colors.statusDanger,
    ],
  );
}

/**
 * React Native types a pressable's style callback without `hovered`, which the web renderer does pass
 * and which every paseo control styles itself with.
 */
export type PressState = { pressed: boolean; hovered?: boolean };

export function pressable(
  style: (state: PressState) => StyleProp<ViewStyle>,
): (state: { pressed: boolean }) => StyleProp<ViewStyle> {
  return style as (state: { pressed: boolean }) => StyleProp<ViewStyle>;
}

/** Web focus rings do not belong on a control that already draws its own border. */
export const NO_OUTLINE = (Platform.OS === "web"
  ? ({ outlineStyle: "none", outlineWidth: 0 } as unknown as TextStyle)
  : null) as TextStyle | null;

const SWITCH_DURATION_MS = 180;

export function Switch({
  palette,
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
}: {
  palette: Palette;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: SWITCH_DURATION_MS,
      useNativeDriver: false,
    }).start();
  }, [progress, value]);

  const interpolate = (from: string, to: string) =>
    progress.interpolate({ inputRange: [0, 1], outputRange: [from, to] });

  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      accessibilityLabel={accessibilityLabel}
      style={{ minHeight: controlHeight.compact, justifyContent: "center", opacity: disabled ? 0.5 : 1 }}
    >
      <Animated.View
        style={{
          width: switchGeometry.trackWidth,
          height: switchGeometry.trackHeight,
          borderRadius: switchGeometry.trackHeight / 2,
          padding: (switchGeometry.trackHeight - switchGeometry.thumbSize) / 2,
          justifyContent: "center",
          backgroundColor: interpolate(palette.surface3, palette.accent),
        }}
      >
        <Animated.View
          style={{
            width: switchGeometry.thumbSize,
            height: switchGeometry.thumbSize,
            borderRadius: switchGeometry.thumbSize / 2,
            backgroundColor: interpolate("#ffffff", palette.accentForeground),
            transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, switchGeometry.thumbTravel] }) }],
            shadowColor: "rgba(0, 0, 0, 0.25)",
            shadowOffset: { width: 0, height: 1 },
            shadowRadius: 2,
            shadowOpacity: 1,
            elevation: 2,
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

export type SelectOption<Value extends string> = {
  value: Value;
  label: string;
  description?: string;
};

type Anchor = { x: number; y: number; width: number; height: number };

const MENU_MIN_WIDTH = 240;
const MENU_MARGIN = 8;
const MENU_GAP = 4;

/**
 * Places the menu under its trigger and right-aligned with it, unless the window has no room, in
 * which case it goes above. Nothing else in the panel can hold it: the cards clip their overflow
 * and the surface is a scroll view, so the menu is drawn in a `Modal` and positioned by hand.
 */
function menuPosition(anchor: Anchor, height: number, width: number) {
  const window = Dimensions.get("window");
  const below = anchor.y + anchor.height + MENU_GAP;
  const fitsBelow = below + height + MENU_MARGIN <= window.height;
  return {
    top: fitsBelow ? below : Math.max(MENU_MARGIN, anchor.y - MENU_GAP - height),
    left: Math.max(MENU_MARGIN, Math.min(anchor.x + anchor.width - width, window.width - width - MENU_MARGIN)),
  };
}

export function Select<Value extends string>({
  palette,
  options,
  value,
  onValueChange,
  label,
  accessibilityLabel,
  disabled,
}: {
  palette: Palette;
  options: readonly SelectOption<Value>[];
  value: Value;
  onValueChange: (value: Value) => void;
  /** What the closed trigger reads, when it says more than the selected option's label. */
  label?: string;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  const trigger = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const selected = options.find((option) => option.value === value);

  const open = () => {
    trigger.current?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
  };
  const close = () => {
    setAnchor(null);
    setSize(null);
  };

  const placed = anchor && size ? menuPosition(anchor, size.height, size.width) : null;

  return (
    <View ref={trigger} collapsable={false}>
      <Pressable
        onPress={open}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ expanded: anchor !== null, disabled: Boolean(disabled) }}
        accessibilityLabel={accessibilityLabel}
        style={pressable(({ hovered, pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: spacing[2],
          minHeight: controlHeight.compact,
          paddingLeft: spacing[3],
          paddingRight: spacing[2],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: palette.borderAccent,
          backgroundColor: hovered || pressed ? palette.surface2 : "transparent",
          opacity: disabled ? 0.5 : 1,
        }))}
      >
        <Text numberOfLines={1} style={{ color: palette.foreground, fontSize: fontSize.base }}>
          {label ?? selected?.label ?? ""}
        </Text>
        <Icon name="ChevronDown" size={iconSize.sm} color={palette.foregroundMuted} />
      </Pressable>

      <Modal visible={anchor !== null} transparent animationType="none" onRequestClose={close}>
        <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close menu">
          <View
            onLayout={(event) => {
              const { width, height } = event.nativeEvent.layout;
              setSize({ width: Math.max(width, MENU_MIN_WIDTH), height });
            }}
            style={{
              position: "absolute",
              minWidth: MENU_MIN_WIDTH,
              maxWidth: 320,
              top: placed?.top ?? 0,
              left: placed?.left ?? 0,
              opacity: placed ? 1 : 0,
              backgroundColor: palette.surface2,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: palette.border,
              paddingVertical: spacing[1],
              shadowColor: "rgba(0, 0, 0, 0.4)",
              shadowOffset: { width: 0, height: 4 },
              shadowRadius: 12,
              shadowOpacity: 1,
              elevation: 8,
            }}
          >
            {options.map((option) => {
              const active = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    close();
                    onValueChange(option.value);
                  }}
                  style={pressable(({ hovered, pressed }) => ({
                    flexDirection: "row",
                    alignItems: "flex-start",
                    gap: spacing[2],
                    paddingVertical: spacing[2],
                    paddingHorizontal: spacing[3],
                    backgroundColor: hovered || pressed ? palette.surface3 : "transparent",
                  }))}
                >
                  <View style={{ paddingTop: (leading(fontSize.base) - 6) / 2 }}>
                    <StatusDot color={active ? palette.accent : "transparent"} size={6} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        color: palette.foreground,
                        fontSize: fontSize.base,
                        lineHeight: leading(fontSize.base),
                      }}
                    >
                      {option.label}
                    </Text>
                    {option.description ? (
                      <Text
                        style={{
                          color: palette.foregroundMuted,
                          fontSize: fontSize.sm,
                          lineHeight: leading(fontSize.sm),
                        }}
                      >
                        {option.description}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

export type ButtonVariant = "default" | "outline" | "ghost";

export function Button({
  palette,
  label,
  onPress,
  disabled,
  variant = "outline",
}: {
  palette: Palette;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
}) {
  const surface = {
    default: { backgroundColor: palette.accent, borderColor: palette.accent },
    outline: { backgroundColor: "transparent", borderColor: palette.borderAccent },
    ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={pressable(({ hovered, pressed }) => [
        {
          minHeight: controlHeight.compact,
          paddingHorizontal: spacing[3],
          borderRadius: radius.md,
          borderWidth: 1,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        surface,
        variant !== "default" && (hovered || pressed) ? { backgroundColor: palette.surface2 } : null,
      ])}
    >
      <Text style={{ color: variant === "default" ? palette.accentForeground : palette.foreground, fontSize: fontSize.base }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The muted label paseo puts above every settings block. */
export function Section({
  palette,
  title,
  trailing,
  children,
}: {
  palette: Palette;
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: spacing[3] }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: spacing[2],
          marginLeft: spacing[1],
        }}
      >
        <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.sm }}>{title}</Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

/** The bordered surface1 block every settings row lives in. */
export function Card({
  palette,
  children,
  style,
}: {
  palette: Palette;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          backgroundColor: palette.surface1,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: palette.border,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Row({
  palette,
  title,
  hint,
  hintColor,
  leading: leadingSlot,
  trailing,
  divided,
  dimmed,
}: {
  palette: Palette;
  title: string;
  hint?: string;
  hintColor?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  divided?: boolean;
  dimmed?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: spacing[4],
        paddingHorizontal: spacing[4],
        gap: spacing[3],
        borderTopWidth: divided ? 1 : 0,
        borderTopColor: palette.border,
      }}
    >
      {leadingSlot}
      <View style={{ flex: 1, opacity: dimmed ? 0.6 : 1 }}>
        <Text numberOfLines={1} style={{ color: palette.foreground, fontSize: fontSize.base }}>
          {title}
        </Text>
        {hint ? (
          <Text
            numberOfLines={1}
            style={{
              color: hintColor ?? palette.foregroundMuted,
              fontSize: fontSize.sm,
              lineHeight: leading(fontSize.sm),
              marginTop: spacing[1],
            }}
          >
            {hint}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}

/** A card that opens on its header row, for settings that most installs never touch. */
export function Disclosure({
  palette,
  title,
  summary,
  initialOpen = false,
  children,
}: {
  palette: Palette;
  title: string;
  summary?: string;
  initialOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <Card palette={palette}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={pressable(({ hovered, pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: spacing[2],
          paddingVertical: spacing[4],
          paddingHorizontal: spacing[4],
          backgroundColor: hovered || pressed ? palette.surface2 : "transparent",
        }))}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={iconSize.sm}
          color={palette.foregroundMuted}
        />
        <Text style={{ flex: 1, color: palette.foreground, fontSize: fontSize.base }}>{title}</Text>
        {summary ? (
          <Text numberOfLines={1} style={{ color: palette.foregroundMuted, fontSize: fontSize.sm }}>
            {summary}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={{ borderTopWidth: 1, borderTopColor: palette.border }}>{children}</View>
      ) : null}
    </Card>
  );
}

export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export const MONO_FONT =
  Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  }) ?? "monospace";
