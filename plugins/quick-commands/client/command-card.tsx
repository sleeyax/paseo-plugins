import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { commandIcon, type Command } from "../shared/commands.ts";
import type { LastRun } from "../shared/runs.ts";
import { IconButton } from "./button.tsx";
import { describeRun, type Tone } from "./run-status.ts";
import { fontSize, iconSize, leading, monospace, radius, spacing, touchTarget } from "./theme.ts";

const OUTPUT_MAX_HEIGHT = 240;

export function CommandCard({
  theme,
  command,
  run,
  now,
  highlighted,
  outputOpen,
  onRun,
  onStop,
  onToggleOutput,
}: {
  theme: PluginTheme;
  command: Command;
  run: LastRun | undefined;
  now: number;
  highlighted: boolean;
  outputOpen: boolean;
  onRun: () => void;
  onStop: () => void;
  onToggleOutput: () => void;
}) {
  const colors = theme.colors;
  const running = run?.status === "running";
  const status = describeRun(run, now);
  const toneColor = toneColors(theme)[status.tone];
  const hasOutput = (run?.output.length ?? 0) > 0;

  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: highlighted ? colors.accent : colors.border,
        backgroundColor: colors.surface1,
        overflow: "hidden",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pressable
          onPress={onRun}
          disabled={running}
          accessibilityRole="button"
          accessibilityLabel={`Run ${command.name}`}
          accessibilityHint={command.confirm ? "Asks for confirmation first" : undefined}
          accessibilityState={{ disabled: running, busy: running }}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: touchTarget + spacing[4],
            flexDirection: "row",
            alignItems: "center",
            gap: spacing[3],
            paddingVertical: spacing[3],
            paddingLeft: spacing[4],
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Icon name={running ? "LoaderCircle" : commandIcon(command)} size={iconSize.lg} color={running ? colors.accent : colors.foreground} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.lg, lineHeight: leading(fontSize.lg), fontWeight: "600" }}>
              {command.name}
            </Text>
            <Text numberOfLines={1} style={{ color: toneColor, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
              {status.label}
            </Text>
          </View>
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", paddingRight: spacing[1] }}>
          {running ? <IconButton theme={theme} icon="Square" label={`Stop ${command.name}`} color={colors.statusDanger} onPress={onStop} /> : null}
          <IconButton
            theme={theme}
            icon={outputOpen ? "ChevronUp" : "ChevronDown"}
            label={outputOpen ? "Hide output" : "Show output"}
            disabled={!hasOutput && !running}
            onPress={onToggleOutput}
          />
        </View>
      </View>
      {outputOpen ? <Output theme={theme} lines={run?.output ?? []} running={running} /> : null}
    </View>
  );
}

function Output({ theme, lines, running }: { theme: PluginTheme; lines: string[]; running: boolean }) {
  const colors = theme.colors;
  const toast = useToast();
  const text = lines.join("\n");
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface0 }}>
      <ScrollView style={{ maxHeight: OUTPUT_MAX_HEIGHT }} contentContainerStyle={{ padding: spacing[3] }}>
        <Text selectable style={{ color: lines.length > 0 ? colors.foreground : colors.foregroundMuted, fontFamily: monospace, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
          {lines.length > 0 ? text : running ? "Waiting for output…" : "No output."}
        </Text>
      </ScrollView>
      {lines.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => copyText(text).then(() => toast.show("Output copied"), () => toast.error("Could not copy the output"))}
          style={({ pressed }) => ({ alignSelf: "flex-end", padding: spacing[2], opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>Copy</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function toneColors(theme: PluginTheme): Record<Tone, string> {
  const colors = theme.colors;
  return {
    muted: colors.foregroundMuted,
    accent: colors.accent,
    success: colors.statusSuccess,
    warning: colors.statusWarning,
    danger: colors.statusDanger,
  };
}
