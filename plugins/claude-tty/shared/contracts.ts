import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { INSTALL_STEP_IDS } from "./install.ts";
import { MAX_IDLE_TIMEOUT_MS } from "./settings.ts";

export const ProviderStateSchema = z.enum(["absent", "matching", "mismatched", "foreign"]);

export const StatusSchema = z.object({
  /** The checkout this plugin was installed from, or null when it could not be identified. */
  repoRoot: z.string().nullable(),
  /** Why there is no checkout to manage; everything below is meaningless while this is set. */
  problem: z.string().nullable(),
  adapter: z.object({
    binary: z.string().nullable(),
    built: z.boolean(),
  }),
  provider: z.object({
    id: z.string(),
    state: ProviderStateSchema,
    label: z.string().nullable(),
    command: z.array(z.string()).nullable(),
    expectedCommand: z.array(z.string()).nullable(),
  }),
  host: z.object({
    node: z.string(),
    claude: z.string().nullable(),
  }),
  stateDirectory: z.string(),
  settings: z.object({
    idleTimeoutMs: z.number().int().nonnegative(),
    /** Where the value is stored, which is the plugin's own settings file rather than the daemon config. */
    file: z.string(),
    /** Set when the provider entry pins the timeout in `env`, which the adapter honours over this setting. */
    envOverrideMs: z.number().int().nonnegative().nullable(),
  }),
});

export type StatusPayload = z.output<typeof StatusSchema>;

export const getStatus = defineRpc({
  name: "claude-tty.status",
  input: z.object({}),
  output: StatusSchema,
});

export const setSettings = defineRpc({
  name: "claude-tty.settings.set",
  input: z.object({ idleTimeoutMs: z.number().int().nonnegative().max(MAX_IDLE_TIMEOUT_MS) }),
  output: StatusSchema,
});

export const InstallStepSchema = z.object({
  id: z.enum(INSTALL_STEP_IDS),
  label: z.string(),
  state: z.enum(["pending", "running", "ok", "failed"]),
  detail: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
});

export const InstallJobSchema = z.object({
  state: z.enum(["running", "ok", "failed"]),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  steps: z.array(InstallStepSchema),
});

export type InstallJobPayload = z.output<typeof InstallJobSchema>;

export const startInstall = defineRpc({
  name: "claude-tty.install.start",
  /** Repointing an entry that already exists is never part of an ordinary install. */
  input: z.object({ repair: z.boolean() }),
  output: InstallJobSchema,
});

export const getInstall = defineRpc({
  name: "claude-tty.install.status",
  input: z.object({}),
  output: InstallJobSchema.nullable(),
});

export const DiagnosticCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

export const DoctorSchema = z.object({
  ranAt: z.number(),
  adapter: z.object({
    /** The executable the daemon would launch, which is not always the one this checkout builds. */
    binary: z.string().nullable(),
    ok: z.boolean(),
    problem: z.string().nullable(),
    checks: z.array(DiagnosticCheckSchema),
  }),
  daemon: z.object({
    diagnostic: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export type DoctorPayload = z.output<typeof DoctorSchema>;

export const runDoctor = defineRpc({
  name: "claude-tty.doctor.run",
  input: z.object({}),
  output: DoctorSchema,
});

export const getDoctor = defineRpc({
  name: "claude-tty.doctor.last",
  input: z.object({}),
  output: DoctorSchema.nullable(),
});

export const SessionSchema = z.object({
  id: z.string(),
  claudeSessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  mode: z.string().nullable(),
  lastActivity: z.number().nullable(),
  corrupt: z.boolean(),
  orphanLock: z.boolean(),
  lock: z.object({ pid: z.number(), createdAt: z.number(), live: z.boolean() }).nullable(),
  /** The Paseo agent holding this session, when the daemon still lists one. */
  agent: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
});

export const SessionsSchema = z.object({
  stateDirectory: z.string(),
  problem: z.string().nullable(),
  /** The daemon's clock when it read the sessions; the panel may be on a machine with another. */
  now: z.number(),
  sessions: z.array(SessionSchema),
});

export type SessionsPayload = z.output<typeof SessionsSchema>;

export const getSessions = defineRpc({
  name: "claude-tty.sessions.list",
  input: z.object({}),
  output: SessionsSchema,
});

export const releaseLock = defineRpc({
  name: "claude-tty.locks.release",
  input: z.object({ id: z.string() }),
  output: SessionsSchema,
});

export const quarantineSession = defineRpc({
  name: "claude-tty.sessions.quarantine",
  input: z.object({ id: z.string() }),
  output: SessionsSchema,
});

export const stopSession = defineRpc({
  name: "claude-tty.sessions.stop",
  input: z.object({ id: z.string() }),
  output: SessionsSchema,
});

export const releaseStaleLocks = defineRpc({
  name: "claude-tty.locks.release-stale",
  input: z.object({}),
  output: SessionsSchema,
});

export const SubagentSchema = z.object({
  agentId: z.string(),
  /** What the session asked for, or the opening line of the prompt when the launch is long gone. */
  description: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "unknown"]),
  summary: z.string().nullable(),
  /** Launched by another subagent, so the session's own transcript never mentions it. */
  nested: z.boolean(),
  lastActivity: z.number().nullable(),
});

export const SubagentSessionSchema = z.object({
  sessionId: z.string(),
  cwd: z.string().nullable(),
  subagents: z.array(SubagentSchema),
});

export const SubagentsSchema = z.object({
  now: z.number(),
  problem: z.string().nullable(),
  sessions: z.array(SubagentSessionSchema),
});

export type SubagentsPayload = z.output<typeof SubagentsSchema>;

export const getSubagents = defineRpc({
  name: "claude-tty.subagents.list",
  input: z.object({}),
  output: SubagentsSchema,
});

export const SubagentStepSchema = z.object({
  kind: z.enum(["text", "tool"]),
  /** When it happened, against the daemon's clock, like every other time in this payload. */
  at: z.number().nullable(),
  /** What the subagent said, or the name of the tool it called. */
  title: z.string(),
  /** What the tool was asked to do, in the subagent's own words. */
  detail: z.string().nullable(),
  /** The argument worth reading as it was written: a command, a path, a pattern. */
  body: z.string().nullable(),
  failed: z.boolean(),
  error: z.string().nullable(),
});

export const SubagentTranscriptSchema = z.object({
  /** The first thing in the transcript, so a step can say how far into the run it happened. */
  startedAt: z.number().nullable(),
  steps: z.array(SubagentStepSchema),
  /** Steps older than the ones returned, which are on disk but not worth sending. */
  earlier: z.number(),
});

export type SubagentTranscriptPayload = z.output<typeof SubagentTranscriptSchema>;

export const readSubagent = defineRpc({
  name: "claude-tty.subagents.read",
  input: z.object({ sessionId: z.string(), agentId: z.string() }),
  output: SubagentTranscriptSchema,
});

export const UninstallSchema = z.object({
  removedProvider: z.boolean(),
  removedState: z.boolean(),
  detail: z.string(),
});

export type UninstallPayload = z.output<typeof UninstallSchema>;

export const runUninstall = defineRpc({
  name: "claude-tty.uninstall.run",
  input: z.object({ removeState: z.boolean() }),
  output: UninstallSchema,
});
