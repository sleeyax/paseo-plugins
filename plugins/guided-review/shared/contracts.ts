import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { GuideStateSchema } from "./guide.ts";

/** What the panel shows about a change request before any guide exists. */
export const ReviewHeaderSchema = z.object({
  forge: z.enum(["github", "gitlab"]),
  url: z.string(),
  /** `owner/repo`, or a GitLab project path. */
  project: z.string(),
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean(),
  fileCount: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  headSha: z.string(),
});

export const StartResultSchema = z.discriminatedUnion("status", [
  /** The URL is not one any forge takes; nothing was started. */
  z.object({ status: z.literal("rejected"), message: z.string() }),
  /** A background job is reading the change request and preparing its workspace; follow it by ID. */
  z.object({ status: z.literal("started"), reviewId: z.string() }),
]);

export const START_PHASES = ["reading", "cloning", "creating-workspace", "ready", "failed", "unknown"] as const;

/**
 * Where starting a review has got to. `unknown` is a review this daemon has no record of, which is
 * what one started before a plugin restart and not finished reads as.
 */
export const StartProgressSchema = z.object({
  phase: z.enum(START_PHASES),
  /** Known once the change request has been read. */
  header: ReviewHeaderSchema.nullable(),
  /** Set when `ready`. */
  workspaceId: z.string().nullable(),
  /** Set when `failed`, as a sentence. */
  message: z.string().nullable(),
});

export const PanelViewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("ready"), reviewId: z.string(), header: ReviewHeaderSchema, guide: GuideStateSchema }),
]);

export const startReview = defineRpc({
  name: "guided-review.review.start",
  input: z.object({ url: z.string() }),
  output: StartResultSchema,
});

export const getStartProgress = defineRpc({
  name: "guided-review.review.progress",
  input: z.object({ reviewId: z.string() }),
  output: StartProgressSchema,
});

/** The panel has only its workspace's ID, so this is how it finds the review it belongs to. */
export const getPanel = defineRpc({
  name: "guided-review.panel.get",
  input: z.object({ workspaceId: z.string() }),
  output: PanelViewSchema,
});

/**
 * Generates the review's guide again, with a new guide agent: the panel's retry after a failure.
 * Returns at once; the panel follows the generation through `getPanel`.
 */
export const generateGuide = defineRpc({
  name: "guided-review.guide.generate",
  input: z.object({ reviewId: z.string() }),
  output: GuideStateSchema,
});

/**
 * What an "Ask about this" action points at: a node of the guide, or a changed file the guide keeps
 * outside its nodes, in its Supporting or Unsorted group. The server looks the rest up in the stored
 * guide, so the prompt says what the guide says rather than what the panel sent.
 */
export const AskSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), nodeId: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
]);

export const AskResultSchema = z.discriminatedUnion("status", [
  /** The prompt is in the guide agent's chat, which the panel then opens. */
  z.object({ status: z.literal("sent"), agentId: z.string() }),
  /** Nothing was sent; `message` says why, as a sentence. `agentId` is set while there is an agent to open. */
  z.object({ status: z.literal("not-sent"), agentId: z.string().nullable(), message: z.string() }),
]);

/**
 * Sends the guide agent a prompt about the subject, for the reviewer to follow up in its chat. Only
 * an idle agent is sent to, because a prompt to a busy one would interrupt its turn.
 */
export const askAbout = defineRpc({
  name: "guided-review.guide.ask",
  input: z.object({ reviewId: z.string(), subject: AskSubjectSchema }),
  output: AskResultSchema,
});

export type ReviewHeader = z.output<typeof ReviewHeaderSchema>;
export type StartResult = z.output<typeof StartResultSchema>;
export type StartPhase = (typeof START_PHASES)[number];
export type StartProgress = z.output<typeof StartProgressSchema>;
export type PanelView = z.output<typeof PanelViewSchema>;
export type AskSubject = z.output<typeof AskSubjectSchema>;
export type AskResult = z.output<typeof AskResultSchema>;

/** Tells one subject's "Ask about this" apart from another's in the panel. */
export function askSubjectKey(subject: AskSubject): string {
  return subject.kind === "node" ? `node:${subject.nodeId}` : `file:${subject.path}`;
}
