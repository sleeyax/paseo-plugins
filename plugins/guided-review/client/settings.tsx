import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import React, { useState } from "react";
import { Text } from "react-native";
import { settingsDocument } from "../shared/settings.ts";
import { fontSize, leading, spacing } from "./theme.ts";

type Saved = Extract<SettingsState<typeof settingsDocument.schema>, { status: "ready" }>;

export function GuidedReviewSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(settingsDocument);

  if (settings.status === "loading") {
    return <Note color={theme.colors.foregroundMuted}>Reading the settings…</Note>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Settings">
        <Note color={theme.colors.statusDanger}>{settings.error}</Note>
        <SettingsCard>
          <SettingsAction label="Read them again" actionLabel="Reload" onPress={() => void settings.reload()} />
          {settings.status === "invalid" ? (
            <SettingsAction label="Restore the defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <ForgeClis theme={theme} settings={settings} />;
}

/**
 * A path is saved as typed: the store cannot tell whether it runs, and a start that cannot run it
 * says so in a sentence naming this setting.
 */
function ForgeClis({ theme, settings }: { theme: PluginSurfaceProps["theme"]; settings: Saved }) {
  const saved = settings.values.ghPath;
  // Held here and saved on purpose rather than on every keystroke, each of which would be a document.
  const [typed, setTyped] = useState(saved);

  return (
    <SettingsSection title="Forge CLIs">
      <SettingsCard>
        <SettingsInput
          label="gh path"
          hint="A command on the daemon's PATH, or an absolute path"
          error={settings.saveError}
          initialValue={saved}
          placeholder="gh"
          disabled={settings.saving}
          onChangeText={setTyped}
        />
        <SettingsAction
          label="Use this gh"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving || typed === saved}
          onPress={() => void settings.save({ ...settings.values, ghPath: typed }, settings.revision)}
        />
      </SettingsCard>
      <Note color={theme.colors.foregroundMuted}>
        The daemon runs gh with its own PATH, which is often shorter than your shell's. If a start says gh could not
        run, put the output of `command -v gh` here. gh uses the login you already have.
      </Note>
    </SettingsSection>
  );
}

function Note({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <Text style={{ color, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), marginTop: spacing[2] }}>{children}</Text>
  );
}
