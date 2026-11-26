import type { LastRun } from "../shared/runs.ts";

export type Tone = "muted" | "accent" | "success" | "warning" | "danger";

export function describeRun(run: LastRun | undefined, now: number): { label: string; tone: Tone } {
  if (!run) return { label: "Not run yet", tone: "muted" };
  const when = run.finishedAt === null ? "" : ` · ${timeAgo(run.finishedAt, now)}`;
  switch (run.status) {
    case "running":
      return { label: "Running…", tone: "accent" };
    case "succeeded":
      return { label: `Succeeded${when}`, tone: "success" };
    case "failed":
      return { label: `${run.exitCode === null ? "Failed" : `Failed with exit code ${run.exitCode}`}${when}`, tone: "danger" };
    case "stopped":
      return { label: `Stopped${when}`, tone: "muted" };
    case "interrupted":
      return { label: "Interrupted, outcome unknown", tone: "warning" };
  }
}

export function timeAgo(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
