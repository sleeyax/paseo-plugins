import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import React, { useState } from "react";
import { Text } from "react-native";
import { DEFAULT_GUIDE_AGENT, type settingsDocument } from "../shared/settings.ts";
import { fontSize, leading, spacing } from "./theme.ts";

type Saved = Extract<SettingsState<typeof settingsDocument.schema>, { status: "ready" }>;

/**
 * The guide agent's provider and model, typed as Paseo names them. Saved as typed, like the CLI paths:
 * whether the provider has that model is the daemon's to say, when the next guide agent is created.
 */
export function GuideAgentSettings({ theme, settings }: { theme: PluginSurfaceProps["theme"]; settings: Saved }) {
  const saved = settings.values.guideAgent;
  const [typed, setTyped] = useState(saved);

  return (
    <SettingsSection title="Guide agent">
      <SettingsCard>
        <SettingsInput
          label="Provider and model"
          hint="A provider for its default model, or provider/model"
          error={settings.saveError}
          initialValue={saved}
          placeholder={DEFAULT_GUIDE_AGENT}
          disabled={settings.saving}
          onChangeText={setTyped}
        />
        <SettingsAction
          label="Use this for new guides"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving || typed === saved}
          onPress={() => void settings.save({ ...settings.values, guideAgent: typed }, settings.revision)}
        />
      </SettingsCard>
      <Text
        style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), marginTop: spacing[2] }}
      >
        The agent that writes each guide and answers questions about it, such as claude, claude/claude-opus-5-5 or
        codex/gpt-5.5. It runs read-only: in plan or read-only mode where the provider has one, and with every request to
        edit, write or run a command denied.
      </Text>
    </SettingsSection>
  );
}
