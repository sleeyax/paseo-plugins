import { z } from "zod";

/**
 * The guide as the guide agent writes it: the structured output contract. The descriptions are part
 * of the contract, since the JSON Schema the agent is shown is generated from this and carries them.
 */
const DecisionSchema = z.object({
  choice: z.string().min(1).describe("What the author chose, in one sentence."),
  rejected: z.string().min(1).describe("The alternative the author plausibly rejected, and why it lost, in one sentence."),
});

export const GuideOverviewSchema = z.object({
  idea: z
    .string()
    .min(1)
    .describe("Two or three sentences on the idea behind the change and why it exists, before any code."),
  needToKnows: z
    .array(z.string().min(1))
    .describe("The new invariants, contracts and concepts a reviewer must hold in mind while reading, one per entry."),
  decisions: z.array(DecisionSchema).describe("The decisions the author made across the change, each with its rejected alternative."),
  attention: z
    .array(
      z.object({
        nodeId: z.string().min(1).describe("The `id` of a node in `nodes`."),
        reason: z.string().min(1).describe("Why this node deserves the reviewer's limited attention, in one sentence."),
      }),
    )
    .min(1)
    .describe("Where to spend your attention: the one or two foundational nodes that matter most."),
});

/**
 * Code a node covers in one file: the whole file's diff, some of its hunks, or line ranges within
 * them. Hunks are numbered from 1 per file, the way the generation prompt labels them.
 */
export const CoveredCodeSchema = z.object({
  path: z.string().min(1).describe("A changed file's path, exactly as the list of changed files gives it."),
  hunks: z
    .array(z.number().int().min(1))
    .default([])
    .describe("The numbers of the file's hunks this node covers, as the diff labels them. Leave `hunks` and `lines` empty to cover the whole file."),
  lines: z
    .array(
      z.object({
        start: z.number().int().min(1).describe("The first line of the range."),
        end: z.number().int().min(1).describe("The last line of the range, inclusive."),
      }),
    )
    .default([])
    .describe(
      "Line ranges this node covers, for when one hunk holds more than one concept: line numbers in the new version of the file, or in the old version for a removed file. A removed line belongs with the new line after it.",
    ),
});

export const GuideNodeSchema = z.object({
  id: z.string().min(1).describe("A short slug, unique within the guide, such as `retry-policy`."),
  title: z.string().min(1).describe("The concept's name, a few words."),
  summary: z.string().min(1).describe("What the concept does, in one line."),
  explanation: z.string().min(1).describe("How it works: a short paragraph or two a reviewer reads before its code."),
  covers: z
    .array(CoveredCodeSchema)
    .min(1)
    .describe("The code this node explains, one entry per file, in the order to read it."),
  decisions: z.array(DecisionSchema).describe("Decisions local to this concept, each with its rejected alternative."),
});

export const GuideSchema = z.object({
  overview: GuideOverviewSchema,
  nodes: z
    .array(GuideNodeSchema)
    .min(1)
    .describe("The change split into concepts, each a named group of changes that does one thing, foundations first."),
});

/** Where a review's guide has got to, as the panel shows it. */
export const GuideStateSchema = z.discriminatedUnion("status", [
  /** The guide agent is writing it; `agentId` is null until the agent exists. */
  z.object({ status: z.literal("generating"), agentId: z.string().nullable() }),
  z.object({ status: z.literal("ready"), agentId: z.string(), guide: GuideSchema }),
  /** Generation failed; `message` is a sentence, and the panel offers to try again. */
  z.object({ status: z.literal("failed"), agentId: z.string().nullable(), message: z.string() }),
]);

export type Guide = z.output<typeof GuideSchema>;
export type GuideNode = z.output<typeof GuideNodeSchema>;
export type GuideDecision = z.output<typeof DecisionSchema>;
export type CoveredCode = z.output<typeof CoveredCodeSchema>;
export type GuideState = z.output<typeof GuideStateSchema>;
