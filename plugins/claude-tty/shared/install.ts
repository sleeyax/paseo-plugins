export const INSTALL_STEP_IDS = ["repo", "adapter", "diagnose", "register", "refresh"] as const;

export type InstallStepId = (typeof INSTALL_STEP_IDS)[number];

const STEP_LABELS: Record<InstallStepId, string> = {
  repo: "Locate the checkout",
  adapter: "Find the built adapter",
  diagnose: "Check this host",
  register: "Register the provider",
  refresh: "Refresh Paseo's provider list",
};

export const INSTALL_STEPS: readonly { id: InstallStepId; label: string }[] = INSTALL_STEP_IDS.map((id) => ({
  id,
  label: STEP_LABELS[id],
}));

export type StepState = "pending" | "running" | "ok" | "failed";

export type InstallStep = {
  id: InstallStepId;
  label: string;
  state: StepState;
  detail: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type InstallJob = {
  state: "running" | "ok" | "failed";
  startedAt: number;
  finishedAt: number | null;
  steps: InstallStep[];
};

export type StepOutcome = {
  ok: boolean;
  detail: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
};

export function startJob(now: number): InstallJob {
  return {
    state: "running",
    startedAt: now,
    finishedAt: null,
    steps: INSTALL_STEPS.map((step) => ({
      id: step.id,
      label: step.label,
      state: "pending",
      detail: "",
      stdout: "",
      stderr: "",
      exitCode: null,
    })),
  };
}

export function withStepRunning(job: InstallJob, id: InstallStepId): InstallJob {
  return replaceStep(job, id, (step) => ({ ...step, state: "running", detail: "", stdout: "", stderr: "", exitCode: null }));
}

/** A failure stops the job where it is, so the steps after it stay pending rather than being marked. */
export function withStepSettled(job: InstallJob, id: InstallStepId, outcome: StepOutcome, now: number): InstallJob {
  const settled = replaceStep(job, id, (step) => ({
    ...step,
    state: outcome.ok ? "ok" : "failed",
    detail: outcome.detail,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    exitCode: outcome.exitCode ?? null,
  }));
  if (!outcome.ok) return { ...settled, state: "failed", finishedAt: now };
  const done = settled.steps.every((step) => step.state === "ok");
  return done ? { ...settled, state: "ok", finishedAt: now } : settled;
}

export function failedStep(job: InstallJob): InstallStep | null {
  return job.steps.find((step) => step.state === "failed") ?? null;
}

export function runningStep(job: InstallJob): InstallStep | null {
  return job.steps.find((step) => step.state === "running") ?? null;
}

/** Everything a step produced, in the order a terminal would have shown it. */
export function stepOutput(step: InstallStep): string {
  return [step.stdout.trimEnd(), step.stderr.trimEnd()].filter((part) => part !== "").join("\n");
}

function replaceStep(job: InstallJob, id: InstallStepId, update: (step: InstallStep) => InstallStep): InstallJob {
  return { ...job, steps: job.steps.map((step) => (step.id === id ? update(step) : step)) };
}
