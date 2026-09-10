import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { InstallJobPayload, StatusPayload } from "../shared/contracts.ts";
import { failedStep, stepOutput, type InstallStep } from "../shared/install.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { Monospace, toneColor } from "./status.tsx";
import { Button, Card, Row, Section, StatusDot } from "./ui.tsx";

export const INSTALL_QUERY_KEY = ["claude-tty", "install"];
const POLL_MS = 700;

export function InstallSection({
  palette,
  status,
  onSettled,
}: {
  palette: Palette;
  status: StatusPayload;
  onSettled: () => void;
}) {
  const queryClient = useQueryClient();
  const getInstall = useRpc(contracts.getInstall);
  const startInstall = useRpc(contracts.startInstall);

  const query = useQuery({
    queryKey: INSTALL_QUERY_KEY,
    queryFn: () => getInstall({}),
    refetchInterval: (current) => (current.state.data?.state === "running" ? POLL_MS : false),
  });
  const job = query.data ?? null;
  const start = useMutation({
    mutationFn: (input: { repair: boolean }) => startInstall(input),
    onSuccess: (next) => queryClient.setQueryData(INSTALL_QUERY_KEY, next),
  });

  const running = job?.state === "running" || start.isPending;
  const blocked = status.problem !== null;
  const settledAt = job?.finishedAt ?? null;
  React.useEffect(() => {
    if (settledAt !== null) onSettled();
  }, [settledAt, onSettled]);

  return (
    <Section
      palette={palette}
      title="Setup"
      trailing={
        <View style={{ flexDirection: "row", gap: spacing[2] }}>
          {status.provider.state === "mismatched" ? (
            <Button
              palette={palette}
              label="Point it at this checkout"
              disabled={running || blocked}
              onPress={() => start.mutate({ repair: true })}
            />
          ) : null}
          <Button
            palette={palette}
            label={primaryLabel(status)}
            variant="default"
            disabled={running || blocked}
            onPress={() => start.mutate({ repair: false })}
          />
        </View>
      }
    >
      {job === null ? (
        <Text
          style={{
            color: palette.foregroundMuted,
            fontSize: fontSize.sm,
            lineHeight: leading(fontSize.sm),
            marginLeft: spacing[1],
          }}
        >
          {intro(status)}
        </Text>
      ) : (
        <>
          <Card palette={palette}>
            {job.steps.map((step, index) => (
              <StepRow key={step.id} palette={palette} step={step} divided={index > 0} />
            ))}
          </Card>
          <FailureOutput palette={palette} job={job} />
        </>
      )}
    </Section>
  );
}

function StepRow({ palette, step, divided }: { palette: Palette; step: InstallStep; divided: boolean }) {
  return (
    <Row
      palette={palette}
      title={step.label}
      hint={step.state === "running" ? "Running…" : step.detail || undefined}
      hintColor={step.state === "failed" ? palette.statusDanger : undefined}
      dimmed={step.state === "pending"}
      divided={divided}
      leading={
        <View style={{ paddingRight: spacing[1] }}>
          <StatusDot color={stepColor(palette, step)} />
        </View>
      }
    />
  );
}

function FailureOutput({ palette, job }: { palette: Palette; job: InstallJobPayload }) {
  const failed = failedStep(job);
  const output = failed === null ? "" : stepOutput(failed);
  if (failed === null || output === "") return null;
  return (
    <View style={{ gap: spacing[2] }}>
      <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.sm, marginLeft: spacing[1] }}>
        {failed.exitCode === null ? failed.label : `${failed.label} — exit ${failed.exitCode}`}
      </Text>
      <Monospace palette={palette} text={output} />
    </View>
  );
}

function stepColor(palette: Palette, step: InstallStep): string {
  if (step.state === "failed") return toneColor(palette, "danger");
  if (step.state === "pending") return palette.foregroundExtraMuted;
  return toneColor(palette, "ok");
}

function primaryLabel(status: StatusPayload): string {
  return status.adapter.built && status.provider.state === "matching" ? "Re-check" : "Install";
}

function intro(status: StatusPayload): string {
  if (status.problem !== null) return "Nothing can run until this plugin knows which checkout it belongs to.";
  return "Checks that the adapter is built, runs its host checks, and registers the provider. Building the adapter is yours to do; nothing here touches Claude's own configuration or credentials.";
}
