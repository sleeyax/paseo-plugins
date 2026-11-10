import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type TextInput as NativeTextInput } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { settingsDocument } from "../shared/settings.ts";
import { isRunActive, type NxStatus, type RunState, type Task } from "../shared/task.ts";
import { buildSections, type TaskSection } from "./task-list.ts";
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

export function TasksPanel({ theme, layout, workspaceId, revision }: PluginWorkspacePanelProps) {
  const { colors } = theme;
  const search = useRef<NativeTextInput>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [selected, setSelected] = useState(0);
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

  // Opening the panel again, as Run Task... does, bumps the revision: that is a rescan and a fresh start at the top.
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (!layout.compact) search.current?.focus();
    setSelected(0);
    if (seenRevision.current !== revision) rescan();
    seenRevision.current = revision;
  }, [revision]);

  const ready = tasks.data?.kind === "ready" ? tasks.data : null;
  const { sections, navigable } = buildSections(ready?.tasks ?? [], { query, recentIds: ready?.recentTaskIds ?? [], collapsed });
  const highlighted = searchFocused ? Math.min(selected, navigable.length - 1) : -1;

  const moveSelection = (key: string): boolean => {
    if (key !== "ArrowDown" && key !== "ArrowUp") return false;
    setSelected((current) => Math.max(0, Math.min(navigable.length - 1, Math.min(current, navigable.length - 1) + (key === "ArrowDown" ? 1 : -1))));
    return true;
  };
  const runHighlighted = () => {
    const task = navigable[highlighted];
    if (task !== undefined && task.disabledReason === null) actions.run(task);
  };

  const runsByTask = new Map((runs.data?.runs ?? []).map((run) => [run.taskId, run]));
  const toggleSection = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
  };

  const sectionHeader = (section: TaskSection) => {
    if (section.title === null || !section.collapsible) return null;
    return (
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: section.open }} onPress={() => toggleSection(section.key)} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: GROUP_HEADER_PADDING, paddingVertical: 4 }}>
        <Icon name={section.open ? "ChevronDown" : "ChevronRight"} size={CHEVRON_SIZE} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
          {section.title}
        </Text>
      </Pressable>
    );
  };

  const body = () => {
    if (tasks.isPending) return <Text style={{ color: colors.foregroundMuted, padding: 8 }}>Scanning…</Text>;
    if (tasks.isError) return <Text style={{ color: colors.statusDanger, padding: 8 }}>{message(tasks.error)}</Text>;
    if (tasks.data.kind === "unsupported") return <Text style={{ color: colors.foregroundMuted, padding: 8 }}>{tasks.data.message}</Text>;

    const { nx, tasks: all } = tasks.data;
    return (
      <>
        {nx !== null ? <NxNotice colors={colors} status={nx} onChange={(enabled) => void setInferredTargets(enabled)} /> : null}
        {all.length === 0 ? <Text style={{ color: colors.foregroundMuted, padding: 8 }}>No tasks found in package.json, a Makefile, Nx or .vscode/tasks.json.</Text> : null}
        {all.length > 0 && sections.length === 0 ? <Text style={{ color: colors.foregroundMuted, padding: 8 }}>No tasks match.</Text> : null}
        {sections.map((section) => (
          <View key={section.key}>
            {sectionHeader(section)}
            {section.rows.length > 0 ? (
              <View style={section.title !== null ? { marginLeft: GROUP_GUIDE_INSET, borderLeftWidth: 1, borderColor: colors.border, marginBottom: 4 } : undefined}>
                {section.rows.map(({ task, index, showGroup }) => (
                  <TaskRow
                    key={task.id}
                    colors={colors}
                    task={task}
                    groupName={showGroup ? task.group : null}
                    highlighted={index === highlighted}
                    run={runsByTask.get(task.id) ?? null}
                    busy={action.isPending}
                    actions={actions}
                  />
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderBottomWidth: 1, borderColor: colors.border }}>
        <TextInput
          ref={search}
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setSelected(0);
          }}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onKeyPress={(event) => {
            if (moveSelection(event.nativeEvent.key)) event.preventDefault();
          }}
          onSubmitEditing={runHighlighted}
          submitBehavior="submit"
          placeholder="Search tasks"
          placeholderTextColor={colors.foregroundMuted}
          accessibilityLabel="Search tasks"
          style={{ flex: 1, minWidth: 0, color: colors.foreground, backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13 }} />
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
