import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import React, { useState } from "react";
import { Text } from "react-native";
import { settingsDocument } from "../shared/settings.ts";
import { GuideAgentSettings } from "./guide-agent-settings.tsx";
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
  return (
    <>
      <ForgeClis theme={theme} settings={settings} />
      <GuideAgentSettings theme={theme} settings={settings} />
    </>
  );
}

/**
 * A path is saved as typed: the store cannot tell whether it runs, and a start that cannot run it
 * says so in a sentence naming this setting.
 */
function ForgeClis({ theme, settings }: { theme: PluginSurfaceProps["theme"]; settings: Saved }) {
  const saved = settings.values.ghPath;
  // Held here and saved on purpose rather than on every keystroke, each of which would be a document.
  const [typed, setTyped] = useState(saved);
  const savedGlab = settings.values.glabPath;
  const [typedGlab, setTypedGlab] = useState(savedGlab);
  // One save error for the document, shown under the path whose save failed.
  const [lastSaved, setLastSaved] = useState<"gh" | "glab">("gh");

  return (
    <SettingsSection title="Forge CLIs">
      <SettingsCard>
        <SettingsInput
          label="gh path"
          hint="A command on the daemon's PATH, or an absolute path"
          error={lastSaved === "gh" ? settings.saveError : null}
          initialValue={saved}
          placeholder="gh"
          disabled={settings.saving}
          onChangeText={setTyped}
        />
        <SettingsAction
          label="Use this gh"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving || typed === saved}
          onPress={() => {
            setLastSaved("gh");
            void settings.save({ ...settings.values, ghPath: typed }, settings.revision);
          }}
        />
        <SettingsInput
          label="glab path"
          hint="A command on the daemon's PATH, or an absolute path"
          error={lastSaved === "glab" ? settings.saveError : null}
          initialValue={savedGlab}
          placeholder="glab"
          disabled={settings.saving}
          onChangeText={setTypedGlab}
        />
        <SettingsAction
          label="Use this glab"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving || typedGlab === savedGlab}
          onPress={() => {
            setLastSaved("glab");
            void settings.save({ ...settings.values, glabPath: typedGlab }, settings.revision);
          }}
        />
      </SettingsCard>
      <Note color={theme.colors.foregroundMuted}>
        The daemon runs gh and glab with its own PATH, which is often shorter than your shell's. If a start says one
        could not run, put the output of `command -v gh` or `command -v glab` here. Both use the logins you already
        have.
      </Note>
    </SettingsSection>
  );
}

function Note({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <Text style={{ color, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), marginTop: spacing[2] }}>{children}</Text>
  );
}
