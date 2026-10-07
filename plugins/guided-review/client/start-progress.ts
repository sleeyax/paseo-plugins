import type { StartPhase, StartProgress } from "../shared/contracts.ts";
import type { LocalReview } from "../shared/inbox.ts";
import { numberLabel } from "../shared/reference.ts";

export type Tone = "muted" | "danger";

/** Whether the start surface can stop asking: nothing after these phases changes on its own. */
export function isFinished(phase: StartPhase): boolean {
  return phase === "ready" || phase === "failed" || phase === "unknown";
}

/** The line the start surface shows while a review is being prepared. */
export function describeProgress(progress: StartProgress): { text: string; tone: Tone } {
  const header = progress.header;
  const name = header ? `${numberLabel(header.forge, header.number)} in ${header.project}` : "the PR or MR";
  switch (progress.phase) {
    case "reading":
      return { text: "Reading the PR or MR…", tone: "muted" };
    case "updating-branch":
      return { text: `Fast-forwarding the workspace's branch to ${name}…`, tone: "muted" };
    case "cloning":
      return { text: `No Paseo project has ${header?.project ?? "this repository"}, so it is being cloned…`, tone: "muted" };
    case "creating-workspace":
      return { text: `Creating a workspace for ${name}…`, tone: "muted" };
    case "ready":
      return { text: `Opening the Guided Review panel for ${name}…`, tone: "muted" };
    case "failed":
      return { text: progress.message ?? "Starting the review failed.", tone: "danger" };
    case "unknown":
      return { text: "This review was interrupted before it was ready. Start it again.", tone: "danger" };
  }
}

/** Whether a review needs following no more: its start ended and its guide is not being generated. Never read is not settled. */
export function isSettled(local: LocalReview | null | undefined): boolean {
  if (local === undefined) return false;
  if (local === null) return true;
  if (local.preparing !== null) return local.preparing.phase === "failed";
  return local.guide !== "generating";
}

/** The line a review list row shows while its review is being started, or once that failed. */
export function describePreparing(local: LocalReview | null): { text: string; tone: Tone } | null {
  if (local?.preparing == null) return null;
  return describeProgress({ phase: local.preparing.phase, header: local.header, workspaceId: null, message: local.preparing.message });
}
