import { z } from "zod";

/**
 * The guide as the guide agent writes it: the structured output contract. The descriptions are part
 * of the contract, since the JSON Schema the agent is shown is generated from this and carries them.
 */
const DecisionSchema = z.object({
  choice: z.string().min(1).describe("What the author chose, in one sentence."),
  alternative: z
    .object({
      text: z.string().min(1).describe("The alternative the author rejected, and why it lost, in one sentence."),
      quote: z
        .string()
        .min(1)
        .describe("The author's own words that name or rule out the alternative, copied exactly from the description, a commit message, a linked issue or an added line of the diff."),
    })
    .nullable()
    .describe("Null unless the author's own words name the alternative they rejected; never guess one."),
});

/** An edge of the node DAG: the node it sits on builds on `nodeId`, which comes earlier in `nodes`. */
const DependencySchema = z.object({
  nodeId: z.string().min(1).describe("The `id` of a node listed earlier in `nodes`."),
  reason: z
    .string()
    .min(1)
    .nullable()
    .describe("Why that node has to be understood before this one, in one sentence, only when the two titles do not make it obvious; otherwise null."),
});

export const SUPPORTING_CATEGORIES = ["test", "docs", "lockfile", "generated", "wiring"] as const;

export const SupportingEntrySchema = z.object({
  path: z.string().min(1).describe("The path of a changed file, exactly as the changed files list gives it."),
  category: z.enum(SUPPORTING_CATEGORIES).describe("What kind of supporting change it is."),
});

export const GuideOverviewSchema = z.object({
  idea: z
    .string()
    .min(1)
    .describe("Two or three sentences on the idea behind the change and why it exists, before any code."),
  needToKnows: z
    .array(z.string().min(1))
    .describe("The new invariants, contracts and concepts a reviewer must hold in mind while reading, one per entry, never restating a node's summary."),
  decisions: z.array(DecisionSchema).describe("The decisions the author made across the change, each with the alternative the author rejected where they say so."),
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
  why: z.string().min(1).describe("Why the concept exists, what it fixes or makes possible, in one or two sentences."),
  behaviour: z
    .array(z.string().min(1))
    .describe(
      "What the concept does, one observable fact per entry, for a reviewer who never opens its code: when it runs, what it reads and writes, its side effects, what else in the repository uses what changed, and the names and limits that matter after merge. Say what happens, never how the lines make it happen, and repeat nothing the summary says.",
    ),
  covers: z
    .array(CoveredCodeSchema)
    .min(1)
    .describe("The code this node explains, one entry per file, in the order to read it."),
  decisions: z
    .array(DecisionSchema)
    .describe(
      "Decisions local to this concept whose rejected alternative the author names, each with that alternative. A choice with no such alternative belongs in `why` or `behaviour`, if anywhere, and a decision in the overview is not repeated here.",
    ),
  dependencies: z
    .array(DependencySchema)
    .describe("The earlier nodes this concept builds on, each with why; empty for a foundation."),
});

export const GuideSchema = z.object({
  overview: GuideOverviewSchema,
  nodes: z
    .array(GuideNodeSchema)
    .min(1)
    .describe("The change split into concepts, each a named group of changes that does one thing, foundations first."),
  supporting: z
    .array(SupportingEntrySchema)
    .describe("Changed files that support the change rather than make it: tests, docs and pure wiring."),
});

/** A node as the panel shows it: the agent's node with the layer the service computed from its dependencies. */
export const LayeredNodeSchema = GuideNodeSchema.extend({
  /** 0 for the foundations (the trunk); a node in a later layer builds on nodes in earlier ones. */
  layer: z.number().int().min(0),
  /** It builds on other nodes and nothing builds on it, which the navigator marks. */
  leaf: z.boolean(),
});

/**
 * The guide as the service keeps it and the panel shows it: the agent's guide, laid out in layers,
 * with every change covered by some node, in Supporting, or in Unsorted. An entry of Supporting or
 * Unsorted stands for what no node covers of its file: the whole of it, or the rest of a file some
 * nodes cover part of.
 */
export const LayeredGuideSchema = GuideSchema.extend({
  /** In the agent's order, which puts every node after the nodes it builds on. */
  nodes: z.array(LayeredNodeSchema),
  /** The lockfiles and generated files the agent never saw, which no node covers, then the agent's own entries. */
  supporting: z.array(SupportingEntrySchema),
  /** Changed files with changes no node covers that Supporting does not list, in the forge's order. */
  unsorted: z.array(z.string()),
});

/** Where a review's guide has got to, as the panel shows it. */
export const GuideStateSchema = z.discriminatedUnion("status", [
  /** The guide agent is writing it; `agentId` is null until the agent exists. */
  z.object({ status: z.literal("generating"), agentId: z.string().nullable() }),
  z.object({ status: z.literal("ready"), agentId: z.string(), guide: LayeredGuideSchema }),
  /** Generation failed; `message` is a sentence, and the panel offers to try again. */
  z.object({ status: z.literal("failed"), agentId: z.string().nullable(), message: z.string() }),
]);

export type Guide = z.output<typeof GuideSchema>;
export type GuideNode = z.output<typeof GuideNodeSchema>;
export type GuideDecision = z.output<typeof DecisionSchema>;
export type GuideDependency = z.output<typeof DependencySchema>;
export type CoveredCode = z.output<typeof CoveredCodeSchema>;
export type GuideState = z.output<typeof GuideStateSchema>;
export type SupportingCategory = (typeof SUPPORTING_CATEGORIES)[number];
export type SupportingEntry = z.output<typeof SupportingEntrySchema>;
export type LayeredGuide = z.output<typeof LayeredGuideSchema>;
export type LayeredNode = z.output<typeof LayeredNodeSchema>;

/**
 * Supporting's tests and docs apart from the rest of it, since the panel shows and tallies each as a group of its own.
 * The stored guide keeps them in Supporting, so guides and marks written before the split read the same.
 */
export function splitSupporting(entries: readonly SupportingEntry[]): { tests: SupportingEntry[]; docs: SupportingEntry[]; supporting: SupportingEntry[] } {
  return {
    tests: entries.filter((entry) => entry.category === "test"),
    docs: entries.filter((entry) => entry.category === "docs"),
    supporting: entries.filter((entry) => entry.category !== "test" && entry.category !== "docs"),
  };
}

/**
 * The files a node covers, once each, in the order its `covers` first names them: a node's code is
 * its `covers`, so this is its file list wherever one is wanted.
 */
export function coveredPaths(node: Pick<GuideNode, "covers">): string[] {
  return [...new Set(node.covers.map((cover) => cover.path))];
}
