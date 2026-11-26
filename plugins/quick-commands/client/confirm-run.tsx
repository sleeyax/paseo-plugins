import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Text, View } from "react-native";
import type { Command } from "../shared/commands.ts";
import { Button } from "./button.tsx";
import { fontSize, iconSize, leading, monospace, radius, spacing } from "./theme.ts";

export function ConfirmRun({
  theme,
  command,
  onRun,
  onClose,
}: {
  theme: PluginTheme;
  command: Command;
  onRun: () => void;
  onClose: () => void;
}) {
  const colors = theme.colors;
  return (
    <Modal
      title={`Run ${command.name}?`}
      icon={<Icon name="TriangleAlert" size={iconSize.md} color={colors.statusWarning} />}
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <Modal.Content>
        <View style={{ padding: spacing[3], borderRadius: radius.md, backgroundColor: colors.surface2 }}>
          <Text selectable style={{ color: colors.foreground, fontFamily: monospace, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
            {command.command}
          </Text>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing[2] }}>
          <Button theme={theme} label="Cancel" onPress={onClose} />
          <Button
            theme={theme}
            label="Run"
            variant="primary"
            onPress={() => {
              onClose();
              onRun();
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
