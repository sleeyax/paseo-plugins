import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { SessionsPayload } from "../shared/contracts.ts";
import { lastActiveLabel } from "../shared/sessions.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { ConfirmButton } from "./confirm.tsx";
import { Monospace, ReadingRow, type Reading } from "./status.tsx";
import { Card, Row, Section } from "./ui.tsx";

export const SESSIONS_QUERY_KEY = ["claude-tty", "sessions"];
const REFETCH_MS = 10_000;

type Session = SessionsPayload["sessions"][number];

export function SessionsSection({ palette }: { palette: Palette }) {
  const queryClient = useQueryClient();
  const getSessions = useRpc(contracts.getSessions);
  const releaseLock = useRpc(contracts.releaseLock);
  const quarantineSession = useRpc(contracts.quarantineSession);
  const stopSession = useRpc(contracts.stopSession);

  const query = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => getSessions({}),
    refetchInterval: REFETCH_MS,
  });
  const onSuccess = (next: SessionsPayload) => queryClient.setQueryData(SESSIONS_QUERY_KEY, next);
  const release = useMutation({ mutationFn: (id: string) => releaseLock({ id }), onSuccess });
  const quarantine = useMutation({ mutationFn: (id: string) => quarantineSession({ id }), onSuccess });
  const stop = useMutation({ mutationFn: (id: string) => stopSession({ id }), onSuccess });

  const payload = query.data ?? null;
  const busy = release.isPending || quarantine.isPending || stop.isPending;
  const failure = release.error ?? quarantine.error ?? stop.error ?? null;
  // A stop waits on a process, so the row it is waiting on says so rather than just going flat.
  const stopping = stop.isPending ? stop.variables : null;

  return (
    <Section palette={palette} title="Sessions">
      {payload === null ? null : payload.sessions.length === 0 ? (
        <Card palette={palette}>
          <Row palette={palette} title="No saved sessions" hint={payload.stateDirectory} dimmed />
        </Card>
      ) : (
        <Card palette={palette}>
          {payload.sessions.map((session, index) => (
            <ReadingRow
              key={session.id}
              palette={palette}
              title={title(session)}
              reading={reading(session, payload.now)}
              divided={index > 0}
              trailing={
                <SessionAction
                  palette={palette}
                  session={session}
                  busy={busy}
                  stopping={session.id === stopping}
                  onRelease={() => release.mutate(session.id)}
                  onQuarantine={() => quarantine.mutate(session.id)}
                  onStop={() => stop.mutate(session.id)}
                />
              }
            />
          ))}
        </Card>
      )}

      {payload?.problem ? <Monospace palette={palette} text={payload.problem} /> : null}
      {failure ? <Monospace palette={palette} text={String(failure)} /> : null}

      <Text
        style={{
          color: palette.foregroundMuted,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
          marginLeft: spacing[1],
        }}
      >
        Stopping ends the adapter process holding a session, which closes its Claude terminal without
        closing or archiving the Paseo agent: the next prompt resumes it. A lock names that process.
        The adapter clears its own on exit and recovers one left by a process that has died, so
        releasing by hand is only for a lock that outlived its process and is still in the way.
      </Text>
    </Section>
  );
}

function SessionAction({
  palette,
  session,
  busy,
  stopping,
  onRelease,
  onQuarantine,
  onStop,
}: {
  palette: Palette;
  session: Session;
  busy: boolean;
  stopping: boolean;
  onRelease: () => void;
  onQuarantine: () => void;
  onStop: () => void;
}) {
  if (stopping) {
    return <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.base }}>Stopping…</Text>;
  }
  if (session.corrupt) {
    return (
      <ConfirmButton
        palette={palette}
        label="Move aside"
        confirmLabel="Move it aside"
        disabled={busy}
        onConfirm={onQuarantine}
      />
    );
  }
  if (session.lock === null) return null;
  if (session.lock.live) {
    return (
      <ConfirmButton palette={palette} label="Stop" confirmLabel="Stop it" disabled={busy} onConfirm={onStop} />
    );
  }
  return (
    <ConfirmButton
      palette={palette}
      label="Release lock"
      confirmLabel="Release it"
      disabled={busy}
      onConfirm={onRelease}
    />
  );
}

/** The agent's own title where Paseo still has one, because a cwd names a checkout and not a session. */
function title(session: Session): string {
  return session.agent?.title ?? session.cwd ?? session.id;
}

function reading(session: Session, now: number): Reading {
  if (session.corrupt) return { hint: `${session.id} — unreadable`, tone: "danger" };
  if (session.orphanLock) return { hint: `${session.id} — a lock with no session beside it`, tone: "danger" };
  const held =
    session.lock === null
      ? "not open"
      : session.lock.live
        ? `open in process ${session.lock.pid}`
        : `stale lock from process ${session.lock.pid}`;
  // Ordered by what decides whether to stop a session, because a narrow row loses the tail.
  const parts = [
    held,
    lastActiveLabel(session.lastActivity, now),
    session.model,
    session.mode,
    // Already the title unless the agent named the row.
    typeof session.agent?.title === "string" ? session.cwd : null,
  ];
  return {
    hint: parts.filter((part) => part !== null && part !== "").join(" · "),
    tone: session.lock?.live ? "ok" : session.lock === null ? "muted" : "danger",
  };
}
