import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { Text } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { StatusPayload } from "../shared/contracts.ts";
import { IDLE_TIMEOUT_ENV, IDLE_TIMEOUT_OPTIONS } from "../shared/settings.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { Card, Row, Section, Select } from "./ui.tsx";

const STATUS_QUERY_KEY = ["claude-tty", "status"];

const OPTIONS = IDLE_TIMEOUT_OPTIONS.map((option) => ({
  value: String(option.value),
  label: option.label,
  description:
    option.value === 0
      ? "Keep native Claude processes alive until their tabs close"
      : `Stop the native process after ${option.label} without a foreground prompt`,
}));

export function SettingsSection({ palette, status }: { palette: Palette; status: StatusPayload }) {
  const queryClient = useQueryClient();
  const setSettings = useRpc(contracts.setSettings);
  const apply = useMutation({
    mutationFn: (idleTimeoutMs: number) => setSettings({ idleTimeoutMs }),
    onSuccess: (next) => queryClient.setQueryData(STATUS_QUERY_KEY, next),
    // A save can fail after the file was written, so the shown value is re-read rather than left as it was.
    onError: () => queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY }),
  });
  const override = status.settings.envOverrideMs;
  const selected = String(status.settings.idleTimeoutMs);
  const options = OPTIONS.some((option) => option.value === selected)
    ? OPTIONS
    : [{ value: selected, label: formatTimeout(status.settings.idleTimeoutMs), description: "Saved value" }, ...OPTIONS];

  return (
    <Section palette={palette} title="Settings">
      <Card palette={palette}>
        <Row
          palette={palette}
          title="Suspend idle Claude"
          hint={
            override === null
              ? "Measured from the end of the last foreground turn"
              : `Overridden: this provider entry sets ${IDLE_TIMEOUT_ENV} to ${formatTimeout(override)}`
          }
          trailing={
            <Select
              palette={palette}
              value={selected}
              options={options}
              disabled={apply.isPending}
              accessibilityLabel={`Suspend idle Claude after ${formatTimeout(status.settings.idleTimeoutMs)}`}
              onValueChange={(value) => apply.mutate(Number(value))}
            />
          }
        />
      </Card>
      <Text
        style={{
          color: apply.error ? palette.statusDanger : palette.foregroundMuted,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
          marginLeft: spacing[1],
        }}
      >
        {apply.error
          ? apply.error instanceof Error
            ? apply.error.message
            : String(apply.error)
          : "Suspension stops the PTY and its background tasks but keeps the logical session. Your next prompt resumes the same Claude conversation automatically. The change applies to open sessions too."}
      </Text>
    </Section>
  );
}

function formatTimeout(milliseconds: number): string {
  if (milliseconds === 0) return "never";
  if (milliseconds % 3_600_000 === 0) {
    const hours = milliseconds / 3_600_000;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(milliseconds / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
