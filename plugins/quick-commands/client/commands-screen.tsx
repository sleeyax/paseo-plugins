import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings, useSubscription } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { moveCommand, newCommandId, removeCommand, upsertCommand } from "../shared/command-list.ts";
import { commandIcon, commandsDocument, type Command } from "../shared/commands.ts";
import * as contracts from "../shared/contracts.ts";
import { Button, IconButton } from "./button.tsx";
import { CommandCard } from "./command-card.tsx";
import { CommandEditor, type EditorTarget } from "./command-editor.tsx";
import { ConfirmRun } from "./confirm-run.tsx";
import { fontSize, iconSize, leading, radius, spacing, touchTarget } from "./theme.ts";

const CLOCK_INTERVAL_MS = 30_000;
const MAX_CONTENT_WIDTH = 720;

/**
 * Params the Command Center opens the screen with: `focus` marks a command it just ran, `confirm` one waiting for confirmation.
 * `at` makes each pick distinct, so picking the same command twice asks twice.
 */
export type ScreenParams = { focus?: string; confirm?: string; at?: string };

export function CommandsScreen({ theme, layout, params }: PluginScreenProps) {
  const colors = theme.colors;
  const toast = useToast();
  const [state, setState] = useState<contracts.HostState | null>(null);
  const subscription = useSubscription(contracts.watchHost, {}, setState);
  const settings = useSettings(commandsDocument);
  const run = useRpc(contracts.runCommand);
  const stop = useRpc(contracts.stopCommand);

  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [confirming, setConfirming] = useState<Command | null>(null);
  const [openOutputs, setOpenOutputs] = useState<ReadonlySet<string>>(new Set());
  const now = useClock();

  const commands = state?.kind === "ready" ? state.commands : [];
  const { focus, confirm, at } = params as ScreenParams;

  const handledPick = useRef<string | null>(null);
  useEffect(() => {
    const pick = `${focus ?? ""}|${confirm ?? ""}|${at ?? ""}`;
    if (state?.kind !== "ready" || handledPick.current === pick) return;
    handledPick.current = pick;
    if (focus) setOpenOutputs((open) => new Set(open).add(focus));
    const waiting = confirm ? state.commands.find((command) => command.id === confirm) : undefined;
    if (waiting) setConfirming(waiting);
  }, [focus, confirm, at, state]);

  const start = (command: Command) => {
    setOpenOutputs((open) => new Set(open).add(command.id));
    run({ commandId: command.id }).catch((error: unknown) => toast.error(messageOf(error)));
  };

  const save = async (next: (commands: Command[]) => Command[]): Promise<boolean> => {
    if (settings.status !== "ready") return false;
    return settings.save({ ...settings.values, commands: next(settings.values.commands) }, settings.revision);
  };

  if (subscription.status === "error") return <Notice theme={theme} text={subscription.error.message} />;
  if (state === null) return <Loading />;
  if (state.kind === "unsupported") return <Notice theme={theme} text={state.message} />;

  const padding = layout.compact ? spacing[4] : spacing[6];
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding, alignItems: "center" }}>
      <View style={{ width: "100%", maxWidth: MAX_CONTENT_WIDTH, gap: spacing[3] }}>
        {commands.length > 0 ? (
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing[2] }}>
            {editing ? <Button theme={theme} label="Add" icon="Plus" onPress={() => setEditor(blankEditor())} /> : null}
            <Button theme={theme} label={editing ? "Done" : "Edit"} variant={editing ? "primary" : "outline"} onPress={() => setEditing(!editing)} />
          </View>
        ) : null}

        {settings.status === "invalid" || settings.status === "error" ? <Notice theme={theme} text={`The saved commands cannot be read: ${settings.error}`} /> : null}

        {commands.length === 0 ? (
          <View style={{ alignItems: "center", gap: spacing[3], paddingVertical: spacing[6] }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base), textAlign: "center" }}>
              Save a shell command once, then run it on this host with one tap.
            </Text>
            <Button theme={theme} label="Add command" icon="Plus" variant="primary" onPress={() => setEditor(blankEditor())} />
          </View>
        ) : null}

        {commands.map((command, index) =>
          editing ? (
            <EditRow
              key={command.id}
              theme={theme}
              command={command}
              first={index === 0}
              last={index === commands.length - 1}
              onEdit={() => setEditor({ command, isNew: false })}
              onMove={(direction) => void save((list) => moveCommand(list, command.id, direction))}
            />
          ) : (
            <CommandCard
              key={command.id}
              theme={theme}
              command={command}
              run={state.runs[command.id]}
              now={now}
              highlighted={command.id === focus}
              outputOpen={openOutputs.has(command.id)}
              onRun={() => (command.confirm ? setConfirming(command) : start(command))}
              onStop={() => stop({ commandId: command.id }).catch((error: unknown) => toast.error(messageOf(error)))}
              onToggleOutput={() => setOpenOutputs((open) => toggled(open, command.id))}
            />
          ),
        )}
      </View>

      {editor ? (
        <CommandEditor
          key={editor.command.id}
          theme={theme}
          target={editor}
          saving={settings.saving}
          saveError={settings.saveError}
          onClose={() => setEditor(null)}
          onSave={async (command) => {
            if (await save((list) => upsertCommand(list, command))) setEditor(null);
          }}
          onDelete={async () => {
            if (await save((list) => removeCommand(list, editor.command.id))) setEditor(null);
          }}
        />
      ) : null}
      {confirming ? <ConfirmRun theme={theme} command={confirming} onRun={() => start(confirming)} onClose={() => setConfirming(null)} /> : null}
    </ScrollView>
  );
}

function EditRow({
  theme,
  command,
  first,
  last,
  onEdit,
  onMove,
}: {
  theme: PluginTheme;
  command: Command;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const colors = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        paddingRight: spacing[1],
      }}
    >
      <Pressable
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${command.name}`}
        style={({ pressed }) => ({
          flex: 1,
          minHeight: touchTarget + spacing[4],
          flexDirection: "row",
          alignItems: "center",
          gap: spacing[3],
          paddingLeft: spacing[4],
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon name={commandIcon(command)} size={iconSize.lg} color={colors.foreground} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.lg, lineHeight: leading(fontSize.lg) }}>
          {command.name}
        </Text>
      </Pressable>
      <IconButton theme={theme} icon="ArrowUp" label={`Move ${command.name} up`} disabled={first} onPress={() => onMove(-1)} />
      <IconButton theme={theme} icon="ArrowDown" label={`Move ${command.name} down`} disabled={last} onPress={() => onMove(1)} />
      <IconButton theme={theme} icon="Pencil" label={`Edit ${command.name}`} onPress={onEdit} />
    </View>
  );
}

function Notice({ theme, text }: { theme: PluginTheme; text: string }) {
  return (
    <View style={{ padding: spacing[4] }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>{text}</Text>
    </View>
  );
}

/** Re-renders now and then, so "5 min ago" keeps up. */
function useClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function blankEditor(): EditorTarget {
  return { command: { id: newCommandId(), name: "", command: "", confirm: false }, isNew: true };
}

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
