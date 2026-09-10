import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { PresenceStatusPayload } from "../shared/contracts.ts";
import {
  BADGE_COLORS,
  DETAIL_LEVELS,
  DETAIL_LEVEL_LABELS,
  type DetailLevel,
  MANAGED_APPLICATION_ID,
} from "../shared/presence.ts";
import { coerceApplicationId } from "../shared/settings.ts";
import { DiscordPreview } from "./preview.tsx";
import {
  MAX_CONTENT_WIDTH,
  controlHeight,
  fontSize,
  leading,
  radius,
  spacing,
  type Palette,
} from "./theme.ts";
import {
  Button,
  Card,
  Disclosure,
  NO_OUTLINE,
  Row,
  Section,
  Select,
  type SelectOption,
  StatusDot,
  Switch,
  usePalette,
} from "./ui.tsx";

const STATUS_QUERY_KEY = ["discord-rich-presence", "status"];
const REFETCH_MS = 5_000;

type Connection = { text: string; tone: "accent" | "muted" | "danger" };

function connectionOf(status: PresenceStatusPayload): Connection {
  if (!status.settings.applicationId) {
    return { text: "No application ID — add one below", tone: "muted" };
  }
  if (!status.settings.enabled) return { text: "Off — your profile shows nothing", tone: "muted" };
  if (status.daemon.status === "failed") {
    return { text: `Cannot read Paseo: ${status.daemon.error ?? "unknown error"}`, tone: "danger" };
  }
  switch (status.discord.status) {
    case "connected":
      return { text: "Connected to Discord", tone: "accent" };
    case "connecting":
      return { text: "Connecting to Discord…", tone: "muted" };
    case "unavailable":
      return { text: `${status.discord.error ?? "Discord not running"} — retrying…`, tone: "muted" };
    case "rejected":
      return { text: status.discord.error ?? "Discord refused this application ID", tone: "danger" };
    default:
      return { text: "Idle", tone: "muted" };
  }
}

function toneColor(palette: Palette, tone: Connection["tone"]): string {
  if (tone === "accent") return palette.accent;
  if (tone === "danger") return palette.statusDanger;
  return palette.foregroundMuted;
}

function applicationSummary(savedId: string): string {
  if (savedId === MANAGED_APPLICATION_ID) return "Shared application";
  if (savedId === "") return "No application ID";
  return "Your own application";
}

function applicationHint(savedId: string): string {
  if (savedId === MANAGED_APPLICATION_ID) {
    return "The shared Paseo application, already filled in. Replace it with your own to host the presence yourself — the plugin README walks through the portal steps and the art assets.";
  }
  if (savedId === "") {
    return "Discord shows nothing until an application ID is saved. Paste your own, or go back to the shared Paseo application.";
  }
  return "Your own Discord application. Its name is the title Discord shows in bold, and it needs the six art assets from the plugin's assets folder uploaded under Rich Presence.";
}

const DEFAULT_LEVEL_HINTS: Record<DetailLevel, string> = {
  detailed: "Names the project and the workspace you are in.",
  projects: "Names the project. Workspace titles stay private.",
  hidden: "Nothing is named. Discord shows only that Paseo is running.",
};

const PROJECT_LEVEL_HINTS: Record<DetailLevel, string> = {
  detailed: "Names the project and the workspace you are in.",
  projects: "Names the project, never the workspace.",
  hidden: "Never named. Paseo shows another active project instead.",
};

const DEFAULT_LEVEL_OPTIONS: readonly SelectOption<DetailLevel>[] = DETAIL_LEVELS.map((level) => ({
  value: level,
  label: DETAIL_LEVEL_LABELS[level],
  description: DEFAULT_LEVEL_HINTS[level],
}));

/** The extra option a project row has, and the one the settings store spells as no entry at all. */
const FOLLOWS_DEFAULT = "default";

type ProjectLevelChoice = DetailLevel | typeof FOLLOWS_DEFAULT;

const PROJECT_LEVEL_OPTIONS: readonly SelectOption<ProjectLevelChoice>[] = [
  {
    value: FOLLOWS_DEFAULT,
    label: "Default",
    description: "Follows the level set for all projects.",
  },
  ...DETAIL_LEVELS.map((level) => ({
    value: level,
    label: DETAIL_LEVEL_LABELS[level],
    description: PROJECT_LEVEL_HINTS[level],
  })),
];

type KnownProject = PresenceStatusPayload["projects"][number];

function ProjectLevelRow({
  palette,
  project,
  defaultLevel,
  onChange,
}: {
  palette: Palette;
  project: KnownProject;
  defaultLevel: DetailLevel;
  onChange: (level: DetailLevel | null) => void;
}) {
  const effective = project.level ?? defaultLevel;
  const label = DETAIL_LEVEL_LABELS[effective];
  return (
    <Row
      palette={palette}
      title={project.displayName}
      hint={project.rootPath}
      dimmed={effective === "hidden"}
      divided
      trailing={
        <Select
          palette={palette}
          value={project.level ?? FOLLOWS_DEFAULT}
          options={PROJECT_LEVEL_OPTIONS}
          label={project.level === null ? `Default · ${label}` : label}
          accessibilityLabel={
            project.level === null
              ? `Detail level for ${project.displayName}: follows the default, ${label}`
              : `Detail level for ${project.displayName}: ${label}`
          }
          onValueChange={(choice) => onChange(choice === FOLLOWS_DEFAULT ? null : choice)}
        />
      }
    />
  );
}

function ApplicationIdField({
  palette,
  value,
  onChangeText,
  onSubmit,
}: {
  palette: Palette;
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onSubmitEditing={onSubmit}
      placeholder={MANAGED_APPLICATION_ID}
      placeholderTextColor={palette.foregroundExtraMuted}
      accessibilityLabel="Discord application ID"
      style={[
        {
          flex: 1,
          minWidth: 160,
          minHeight: controlHeight.compact,
          color: palette.foreground,
          backgroundColor: palette.surface0,
          borderWidth: 1,
          borderColor: palette.borderAccent,
          borderRadius: radius.md,
          paddingHorizontal: spacing[3],
          fontSize: fontSize.base,
        },
        NO_OUTLINE,
      ]}
    />
  );
}

export function DiscordPresenceSurface({ theme, layout }: PluginSurfaceProps) {
  const palette = usePalette(theme);
  const queryClient = useQueryClient();
  const getStatus = useRpc(contracts.getStatus);
  const setSettings = useRpc(contracts.setSettings);
  const setProjectLevel = useRpc(contracts.setProjectLevel);

  const query = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => getStatus({}),
    refetchInterval: REFETCH_MS,
  });
  const apply = useMutation({
    mutationFn: (next: PresenceStatusPayload["settings"]) => setSettings(next),
    onSuccess: (next) => queryClient.setQueryData(STATUS_QUERY_KEY, next),
  });
  const setLevel = useMutation({
    mutationFn: (input: { rootPath: string; displayName: string; level: DetailLevel | null }) =>
      setProjectLevel(input),
    onSuccess: (next) => queryClient.setQueryData(STATUS_QUERY_KEY, next),
  });

  const status = query.data ?? null;
  const [draftId, setDraftId] = useState<string | null>(null);
  const connection = useMemo(() => (status ? connectionOf(status) : null), [status]);

  if (!status || !connection) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.surface0, padding: spacing[4] }}>
        <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.base }}>Loading…</Text>
      </View>
    );
  }

  const settings = status.settings;
  const savedId = settings.applicationId ?? "";
  const applicationId = draftId ?? savedId;
  const parsedId = coerceApplicationId(applicationId);
  const idChanged = applicationId.trim() !== savedId;
  const idInvalid = applicationId.trim().length > 0 && parsedId === null;
  const badgeColor = status.activity?.smallImageKey
    ? (BADGE_COLORS[status.activity.smallImageKey] ?? null)
    : null;

  const saveApplicationId = () => {
    if (idInvalid || !idChanged) return;
    apply.mutate({ ...settings, applicationId: parsedId });
    setDraftId(null);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.surface0 }}
      contentContainerStyle={{
        width: "100%",
        maxWidth: MAX_CONTENT_WIDTH,
        alignSelf: "center",
        padding: layout.compact ? spacing[3] : spacing[4],
        paddingTop: spacing[6],
        paddingBottom: spacing[8],
        gap: spacing[6],
      }}
    >
      <Card palette={palette}>
        <Row
          palette={palette}
          title="Show my activity on Discord"
          hint={connection.text}
          hintColor={toneColor(palette, connection.tone)}
          leading={
            <View style={{ paddingRight: spacing[1] }}>
              <StatusDot color={toneColor(palette, connection.tone)} />
            </View>
          }
          trailing={
            <Switch
              palette={palette}
              value={settings.enabled}
              onValueChange={(enabled) => apply.mutate({ ...settings, enabled })}
              accessibilityLabel="Show my activity on Discord"
            />
          }
        />
      </Card>

      <Section
        palette={palette}
        title="Preview"
        trailing={
          badgeColor && status.activity?.smallImageText ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
              <StatusDot color={badgeColor} size={6} />
              <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.sm }}>
                {status.activity.smallImageText}
              </Text>
            </View>
          ) : null
        }
      >
        <DiscordPreview status={status} />
      </Section>

      <Section palette={palette} title="Detail level">
        <Card palette={palette}>
          <Row
            palette={palette}
            title="All projects"
            hint="What a project shows unless it says otherwise"
            trailing={
              <Select
                palette={palette}
                value={settings.defaultDetailLevel}
                options={DEFAULT_LEVEL_OPTIONS}
                accessibilityLabel={`Detail level for all projects: ${DETAIL_LEVEL_LABELS[settings.defaultDetailLevel]}`}
                onValueChange={(defaultDetailLevel) =>
                  apply.mutate({ ...settings, defaultDetailLevel })
                }
              />
            }
          />
          {status.projects.length === 0 ? (
            <Row palette={palette} title="Paseo has no projects." dimmed divided />
          ) : (
            status.projects.map((project) => (
              <ProjectLevelRow
                key={project.rootPath}
                palette={palette}
                project={project}
                defaultLevel={settings.defaultDetailLevel}
                onChange={(level) =>
                  setLevel.mutate({
                    rootPath: project.rootPath,
                    displayName: project.displayName,
                    level,
                  })
                }
              />
            ))
          )}
        </Card>
        <Text
          style={{
            color: palette.foregroundMuted,
            fontSize: fontSize.sm,
            lineHeight: leading(fontSize.sm),
            marginLeft: spacing[1],
          }}
        >
          A project set to Hidden is never named. Paseo shows another project with active work
          instead, or shows only that you are running Paseo.
        </Text>
      </Section>

      <Disclosure
        palette={palette}
        title="Advanced"
        summary={applicationSummary(savedId)}
        initialOpen={savedId === "" || status.discord.status === "rejected"}
      >
        <View style={{ padding: spacing[4], gap: spacing[3] }}>
          <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.sm }}>Application ID</Text>
          <View style={{ flexDirection: "row", gap: spacing[2], alignItems: "center", flexWrap: "wrap" }}>
            <ApplicationIdField
              palette={palette}
              value={applicationId}
              onChangeText={setDraftId}
              onSubmit={saveApplicationId}
            />
            <Button
              palette={palette}
              label="Save"
              variant="default"
              disabled={!idChanged || idInvalid}
              onPress={saveApplicationId}
            />
            {savedId !== MANAGED_APPLICATION_ID ? (
              <Button
                palette={palette}
                label="Use the shared one"
                variant="ghost"
                onPress={() => {
                  apply.mutate({ ...settings, applicationId: MANAGED_APPLICATION_ID });
                  setDraftId(null);
                }}
              />
            ) : null}
          </View>
          <Text
            style={{
              color: idInvalid ? palette.statusDanger : palette.foregroundMuted,
              fontSize: fontSize.sm,
              lineHeight: leading(fontSize.sm),
            }}
          >
            {idInvalid ? "An application ID is 17 to 20 digits." : applicationHint(savedId)}
          </Text>
        </View>
      </Disclosure>
    </ScrollView>
  );
}
