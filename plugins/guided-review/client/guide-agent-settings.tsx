import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import React, { useState } from "react";
import { Text } from "react-native";
import { DEFAULT_GUIDE_AGENT, type settingsDocument } from "../shared/settings.ts";
import { fontSize, leading, spacing } from "./theme.ts";

type Saved = Extract<SettingsState<typeof settingsDocument.schema>, { status: "ready" }>;

/**
 * The guide agent's provider and model, effort and mode, typed as Paseo names them. Saved as typed, like the CLI
 * paths: whether the provider has them is the daemon's to say, when the next guide agent is created.
 */
export function GuideAgentSettings({ theme, settings }: { theme: PluginSurfaceProps["theme"]; settings: Saved }) {
  const { guideAgent, guideAgentEffort, guideAgentMode } = settings.values;
  const [agent, setAgent] = useState(guideAgent);
  const [effort, setEffort] = useState(guideAgentEffort);
  const [mode, setMode] = useState(guideAgentMode);
  const changed = agent !== guideAgent || effort !== guideAgentEffort || mode !== guideAgentMode;

  return (
    <SettingsSection title="Guide agent">
      <SettingsCard>
        <SettingsInput
          label="Provider and model"
          hint="A provider for its default model, or provider/model"
          initialValue={guideAgent}
          placeholder={DEFAULT_GUIDE_AGENT}
          disabled={settings.saving}
          onChangeText={setAgent}
        />
        <SettingsInput
          label="Effort"
          hint="One of the model's effort levels, like high; blank for the model's default"
          initialValue={guideAgentEffort}
          placeholder="Model default"
          disabled={settings.saving}
          onChangeText={setEffort}
        />
        <SettingsInput
          label="Mode"
          hint="A mode that asks before a tool runs, like plan or default; blank for plan or read-only"
          error={settings.saveError}
          initialValue={guideAgentMode}
          placeholder="Read-only"
          disabled={settings.saving}
          onChangeText={setMode}
        />
        <SettingsAction
          label="Use these for new guides"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving || !changed}
          onPress={() =>
            void settings.save({ ...settings.values, guideAgent: agent, guideAgentEffort: effort, guideAgentMode: mode }, settings.revision)
          }
        />
      </SettingsCard>
      <Text
        style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), marginTop: spacing[2] }}
      >
        The agent that writes each guide and answers questions about it, such as claude-tty, claude/claude-opus-5-5 or
        codex/gpt-5.5. The default, claude-tty, becomes claude where the claude-tty plugin is not available. It runs
        read-only: in plan or read-only mode unless you pick another mode that asks first, and with every request to
        edit, write or run a command denied. A mode that runs tools without asking, like acceptEdits or auto, is
        refused.
      </Text>
    </SettingsSection>
  );
}
