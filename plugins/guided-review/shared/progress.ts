import { z } from "zod";
import type { GuideSubject } from "./contracts.ts";
import { splitTests, type LayeredGuide } from "./guide.ts";

/** How many of a group's entries the reviewer has marked understood. */
export const TallySchema = z.object({
  understood: z.number().int().min(0),
  total: z.number().int().min(0),
});

/**
 * What the reviewer has marked understood in one guide: nodes by ID, and Supporting and Unsorted
 * entries by path. A node's own files are covered by its node and are never marked on their own.
 */
export const UnderstoodSchema = z.object({
  nodes: z.array(z.string()),
  files: z.array(z.string()),
});

/** The reviewer's progress through the guide at one head SHA, trunk first, as the panel shows it. */
export const GuideProgressSchema = z.object({
  /** The head SHA of the guide the marks belong to, which a mark is sent back with. */
  headSha: z.string(),
  /** In the guide's order, and only what the guide still has. */
  understood: UnderstoodSchema,
  /** One per layer, foundations first. */
  layers: z.array(TallySchema),
  tests: TallySchema,
  /** Supporting without its tests. */
  supporting: TallySchema,
  unsorted: TallySchema,
  /** Every node and every Supporting and Unsorted entry. */
  overall: TallySchema,
  /** The first layer, foundations first, with a node not yet understood; null once every node is. */
  nextLayer: z.number().int().min(0).nullable(),
});

export type Tally = z.output<typeof TallySchema>;
export type Understood = z.output<typeof UnderstoodSchema>;
export type GuideProgress = z.output<typeof GuideProgressSchema>;

/**
 * Tallies `marks` against `guide`. A mark the guide has no node or entry for is dropped, so marks
 * kept for an ID or path the guide no longer has never count.
 */
export function summariseProgress(guide: LayeredGuide, headSha: string, marks: Understood): GuideProgress {
  const markedNodes = new Set(marks.nodes);
  const markedFiles = new Set(marks.files);
  const nodes = guide.nodes.filter((node) => markedNodes.has(node.id)).map((node) => node.id);
  const outside = [...guide.supporting.map((entry) => entry.path), ...guide.unsorted];
  const files = outside.filter((file) => markedFiles.has(file));

  const layers: Tally[] = [];
  for (const node of guide.nodes) {
    const tally = (layers[node.layer] ??= { understood: 0, total: 0 });
    tally.total += 1;
    if (markedNodes.has(node.id)) tally.understood += 1;
  }
  const tallyOf = (paths: readonly string[]): Tally => ({
    understood: paths.filter((file) => markedFiles.has(file)).length,
    total: paths.length,
  });
  const split = splitTests(guide.supporting);
  const tests = tallyOf(split.tests.map((entry) => entry.path));
  const supporting = tallyOf(split.supporting.map((entry) => entry.path));
  const unsorted = tallyOf(guide.unsorted);
  const nextLayer = layers.findIndex((tally) => tally.understood < tally.total);

  return {
    headSha,
    understood: { nodes, files },
    layers,
    tests,
    supporting,
    unsorted,
    overall: {
      understood: nodes.length + files.length,
      total: guide.nodes.length + outside.length,
    },
    nextLayer: nextLayer === -1 ? null : nextLayer,
  };
}

/** Whether `subject` is marked understood in `progress`. */
export function isUnderstood(progress: GuideProgress, subject: GuideSubject): boolean {
  return subject.kind === "node" ? progress.understood.nodes.includes(subject.nodeId) : progress.understood.files.includes(subject.path);
}
