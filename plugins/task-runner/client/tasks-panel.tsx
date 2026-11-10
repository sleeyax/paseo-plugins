import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { settingsDocument } from "../shared/settings.ts";
import { isRunActive, type NxStatus, type RunState, type Task } from "../shared/task.ts";
import { filterTasks, groupTasks } from "./task-list.ts";
import { TaskRow, type TaskActions } from "./task-row.tsx";

type Colors = PluginTheme["colors"];

const RUNS_POLL_MS = 1_500;
const INFERRED_POLL_MS = 3_000;
const GROUP_HEADER_PADDING = 6;
const CHEVRON_SIZE = 14;
/** Puts a group's guide line under its chevron's centre. */
const GROUP_GUIDE_INSET = GROUP_HEADER_PADDING + CHEVRON_SIZE / 2 - 1;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function LinkButton({ colors, label, onPress }: { colors: Colors; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      <Text style={{ color: colors.accent, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function NxNotice({ colors, status, onChange }: { colors: Colors; status: NxStatus; onChange: (enabled: boolean) => void }) {
  const text = {
    off: "Targets inferred by Nx plugins are hidden.",
    loading: "Loading inferred targets…",
    on: "Showing targets inferred by Nx plugins.",
    failed: `Could not load inferred targets, so these come from the files. ${status.failure ?? ""}`,
  }[status.inferred];
  return (
    <View style={{ gap: 4, paddingHorizontal: 8, paddingVertical: 6 }}>
      <Text style={{ color: status.inferred === "failed" ? colors.statusWarning : colors.foregroundMuted, fontSize: 12 }}>{text}</Text>
      {status.inferred === "off" ? <LinkButton colors={colors} label="Load inferred targets (runs this repo's nx)" onPress={() => onChange(true)} /> : <LinkButton colors={colors} label="Use files only" onPress={() => onChange(false)} />}
    </View>
  );
}

export function TasksPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const { colors } = theme;
  const toast = useToast();
  const queryClient = useQueryClient();
  const settings = useSettings(settingsDocument);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const listTasks = useRpc(contracts.listTasks);
  const getRuns = useRpc(contracts.getRuns);
  const runTask = useRpc(contracts.runTask);
  const stopTask = useRpc(contracts.stopTask);
  const forceKillTask = useRpc(contracts.forceKillTask);

  const tasks = useQuery({
    queryKey: [PLUGIN_ID, "tasks", workspaceId],
    queryFn: () => listTasks({ workspaceId }),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchInterval: (current) => (current.state.data?.kind === "ready" && current.state.data.nx?.inferred === "loading" ? INFERRED_POLL_MS : false),
  });

  const runsKey = [PLUGIN_ID, "runs", workspaceId];
  const runs = useQuery({
    queryKey: runsKey,
    queryFn: () => getRuns({ workspaceId }),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchInterval: (current) => (current.state.data?.runs.some(isRunActive) ? RUNS_POLL_MS : false),
  });

  const refreshRuns = () => queryClient.invalidateQueries({ queryKey: runsKey });
  const action = useMutation({
    mutationFn: (perform: () => Promise<unknown>) => perform(),
    onError: (error) => toast.error(message(error)),
    onSettled: refreshRuns,
  });

  const actions: TaskActions = {
    run: (task: Task) => action.mutate(() => runTask({ workspaceId, task })),
    stop: (run: RunState) => action.mutate(() => stopTask({ workspaceId, terminalId: run.terminalId })),
    forceKill: (run: RunState) => action.mutate(() => forceKillTask({ workspaceId, terminalId: run.terminalId })),
  };

  const setInferredTargets = async (enabled: boolean) => {
    if (settings.status !== "ready") return;
    const others = settings.values.inferredTargetWorkspaces.filter((id) => id !== workspaceId);
    const saved = await settings.save({ ...settings.values, inferredTargetWorkspaces: enabled ? [...others, workspaceId] : others }, settings.revision);
    if (saved) await tasks.refetch();
    else toast.error("Could not save that choice.");
  };

  const rescan = () => {
    void tasks.refetch();
    void refreshRuns();
  };

  const runsByTask = new Map((runs.data?.runs ?? []).map((run) => [run.taskId, run]));
  const toggleGroup = (name: string) => {
    const next = new Set(collapsed);
    if (!next.delete(name)) next.add(name);
    setCollapsed(next);
  };

  const body = () => {
    if (tasks.isPending) return <Text style={{ color: colors.foregroundMuted, padding: 8 }}>Scanning…</Text>;
    if (tasks.isError) return <Text style={{ color: colors.statusDanger, padding: 8 }}>{message(tasks.error)}</Text>;
    if (tasks.data.kind === "unsupported") return <Text style={{ color: colors.foregroundMuted, padding: 8 }}>{tasks.data.message}</Text>;

    const shown = filterTasks(tasks.data.tasks, query);
    const groups = groupTasks(shown);
    const grouped = groupTasks(tasks.data.tasks).length > 1;
    return (
      <>
        {tasks.data.nx !== null ? <NxNotice colors={colors} status={tasks.data.nx} onChange={(enabled) => void setInferredTargets(enabled)} /> : null}
        {tasks.data.tasks.length === 0 ? <Text style={{ color: colors.foregroundMuted, padding: 8 }}>No tasks found in package.json, a Makefile, Nx or .vscode/tasks.json.</Text> : null}
        {tasks.data.tasks.length > 0 && shown.length === 0 ? <Text style={{ color: colors.foregroundMuted, padding: 8 }}>No tasks match.</Text> : null}
        {groups.map((group) => {
          const open = query.trim() !== "" || !collapsed.has(group.name);
          return (
            <View key={group.name}>
              {grouped ? (
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => toggleGroup(group.name)} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: GROUP_HEADER_PADDING, paddingVertical: 4 }}>
                  <Icon name={open ? "ChevronDown" : "ChevronRight"} size={CHEVRON_SIZE} color={colors.foregroundMuted} />
                  <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
                    {group.name}
                  </Text>
                </Pressable>
              ) : null}
              {open ? (
                <View style={grouped ? { marginLeft: GROUP_GUIDE_INSET, borderLeftWidth: 1, borderColor: colors.border, marginBottom: 4 } : undefined}>
                  {group.tasks.map((task) => (
                    <TaskRow key={task.id} colors={colors} task={task} run={runsByTask.get(task.id) ?? null} busy={action.isPending} actions={actions} />
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderBottomWidth: 1, borderColor: colors.border }}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search tasks" placeholderTextColor={colors.foregroundMuted} accessibilityLabel="Search tasks" style={{ flex: 1, minWidth: 0, color: colors.foreground, backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh tasks" onPress={rescan} hitSlop={4} style={{ padding: 4 }}>
          <Icon name="RefreshCw" size={15} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 4 }}>
        {body()}
      </ScrollView>
    </View>
  );
}
