import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import React, { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { COMMAND_ICONS, commandIcon, type Command, type CommandIcon } from "../shared/commands.ts";
import { Button } from "./button.tsx";
import { fontSize, iconSize, leading, monospace, radius, spacing, touchTarget } from "./theme.ts";

/** The command being edited, or a blank one with a fresh ID for a new command. */
export type EditorTarget = { command: Command; isNew: boolean };

export function CommandEditor({
  theme,
  target,
  saving,
  saveError,
  onSave,
  onDelete,
  onClose,
}: {
  theme: PluginTheme;
  target: EditorTarget;
  saving: boolean;
  saveError: string | null;
  onSave: (command: Command) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const colors = theme.colors;
  const [name, setName] = useState(target.command.name);
  const [command, setCommand] = useState(target.command.command);
  const [icon, setIcon] = useState<CommandIcon>(commandIcon(target.command));
  const [confirm, setConfirm] = useState(target.command.confirm);
  const complete = name.trim() !== "" && command.trim() !== "";

  const inputStyle = {
    minHeight: touchTarget,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
    color: colors.foreground,
    fontSize: fontSize.base,
  } as const;

  return (
    <Modal title={target.isNew ? "Add command" : "Edit command"} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Field theme={theme} label="Name">
          <TextInput value={name} onChangeText={setName} placeholder="Reboot" placeholderTextColor={colors.foregroundMuted} style={inputStyle} />
        </Field>
        <Field theme={theme} label="Command" hint="Runs in your login shell in your home directory. It cannot ask for input, such as a sudo password.">
          <TextInput
            value={command}
            onChangeText={setCommand}
            placeholder="systemctl reboot"
            placeholderTextColor={colors.foregroundMuted}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={{ ...inputStyle, fontFamily: monospace, minHeight: touchTarget * 2, textAlignVertical: "top" }}
          />
        </Field>
        <Field theme={theme} label="Icon">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[1] }}>
            {COMMAND_ICONS.map((option) => {
              const selected = option === icon;
              return (
                <Pressable
                  key={option}
                  onPress={() => setIcon(option)}
                  accessibilityRole="radio"
                  accessibilityLabel={option}
                  accessibilityState={{ selected }}
                  style={{
                    width: touchTarget,
                    height: touchTarget,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: selected ? colors.accent : "transparent",
                    backgroundColor: selected ? colors.surface2 : undefined,
                  }}
                >
                  <Icon name={option} size={iconSize.lg} color={selected ? colors.accent : colors.foregroundMuted} />
                </Pressable>
              );
            })}
          </View>
        </Field>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[3] }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>Ask before running</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>For commands like shutdown.</Text>
          </View>
          <Switch
            value={confirm}
            onValueChange={setConfirm}
            trackColor={{ true: colors.accent, false: colors.surface2 }}
            accessibilityLabel="Ask before running"
          />
        </View>
        {saveError ? <Text style={{ color: colors.statusDanger, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{saveError}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[2] }}>
          {target.isNew ? null : <Button theme={theme} label="Delete" variant="danger" disabled={saving} onPress={onDelete} />}
          <View style={{ flex: 1 }} />
          <Button theme={theme} label="Cancel" onPress={onClose} />
          <Button
            theme={theme}
            label="Save"
            variant="primary"
            disabled={!complete || saving}
            onPress={() => onSave({ id: target.command.id, name: name.trim(), command: command.trim(), icon, confirm })}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function Field({ theme, label, hint, children }: { theme: PluginTheme; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing[1] }}>
      <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base), fontWeight: "600" }}>{label}</Text>
      {children}
      {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{hint}</Text> : null}
    </View>
  );
}
