import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { isRunActive, type RunState, type Task } from "../shared/task.ts";

type Colors = PluginTheme["colors"];

const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export type TaskActions = {
  run(task: Task): void;
  stop(run: RunState): void;
  forceKill(run: RunState): void;
};

function statusText(run: RunState): string {
  switch (run.status) {
    case "running":
      return "Running";
    case "stopping":
      return "Stopping…";
    case "stopped":
      return "Stopped";
    case "succeeded":
      return "Done";
    case "failed":
      return `Failed (exit ${run.exitCode ?? "?"})`;
  }
}

function statusColor(run: RunState, colors: Colors): string {
  switch (run.status) {
    case "running":
    case "stopping":
      return colors.accent;
    case "succeeded":
      return colors.statusSuccess;
    case "failed":
      return colors.statusDanger;
    case "stopped":
      return colors.statusWarning;
  }
}

function IconButton({ colors, icon, label, disabled, onPress }: { colors: Colors; icon: string; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={4} style={{ padding: 4, opacity: disabled ? 0.4 : 1 }}>
      <Icon name={icon} size={15} color={colors.foregroundMuted} />
    </Pressable>
  );
}

function Controls({ colors, task, run, busy, actions }: { colors: Colors; task: Task; run: RunState | null; busy: boolean; actions: TaskActions }) {
  if (task.disabledReason !== null) return null;
  if (run === null || !isRunActive(run)) return <IconButton colors={colors} icon="Play" label={`Run ${task.label}`} disabled={busy} onPress={() => actions.run(task)} />;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      {run.canForceKill ? (
        <Pressable accessibilityRole="button" onPress={() => actions.forceKill(run)} hitSlop={4} style={{ paddingHorizontal: 4 }}>
          <Text style={{ color: colors.statusDanger, fontSize: 12 }}>Force kill</Text>
        </Pressable>
      ) : null}
      {run.status === "running" ? <IconButton colors={colors} icon="Square" label={`Stop ${task.label}`} disabled={busy} onPress={() => actions.stop(run)} /> : null}
      <IconButton colors={colors} icon="RotateCw" label={`Restart ${task.label}`} disabled={busy} onPress={() => actions.run(task)} />
    </View>
  );
}

export type TaskRowProps = {
  colors: Colors;
  task: Task;
  /** Named when the row is listed outside its group, as under Recent. */
  groupName: string | null;
  /** The row Enter runs from the search box. */
  highlighted: boolean;
  run: RunState | null;
  busy: boolean;
  actions: TaskActions;
};

export function TaskRow({ colors, task, groupName, highlighted, run, busy, actions }: TaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const lastLine = run?.output.at(-1) ?? null;
  const hasOutput = lastLine !== null;
  const muted = task.disabledReason !== null;
  return (
    <View style={{ paddingVertical: 4, paddingHorizontal: 8, gap: 2, borderRadius: 4, backgroundColor: highlighted ? colors.surface2 : undefined }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }} disabled={!hasOutput} onPress={() => setExpanded(!expanded)} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: run === null ? colors.border : statusColor(run, colors) }} />
          {groupName !== null ? (
            <Text numberOfLines={1} style={{ flexShrink: 2, color: colors.foregroundMuted, fontSize: 13 }}>
              {groupName} ›
            </Text>
          ) : null}
          <Text numberOfLines={1} style={{ flexShrink: 1, color: muted ? colors.foregroundMuted : colors.foreground, fontSize: 13 }}>
            {task.label}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
            {run === null ? task.source : statusText(run)}
          </Text>
        </Pressable>
        <Controls colors={colors} task={task} run={run} busy={busy} actions={actions} />
      </View>
      {task.disabledReason !== null || task.description !== null ? (
        <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 12, paddingLeft: 13 }}>
          {task.disabledReason ?? task.description}
        </Text>
      ) : null}
      {hasOutput && !expanded ? (
        <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11, fontFamily: MONOSPACE, paddingLeft: 13 }}>
          {lastLine}
        </Text>
      ) : null}
      {hasOutput && expanded ? (
        <Text selectable style={{ color: colors.foreground, fontSize: 11, fontFamily: MONOSPACE, padding: 6, marginLeft: 13, borderRadius: 4, backgroundColor: colors.surface2 }}>
          {run?.output.join("\n")}
        </Text>
      ) : null}
    </View>
  );
}
