import { subjectKey, type GuideSubject } from "../shared/contracts.ts";
import { pathOf, type LinkedDraft } from "../shared/drafts.ts";
import { foreignGroupTitle } from "../shared/foreign-work.ts";
import { splitSupporting, type LayeredGuide, type LayeredNode, type SupportingCategory } from "../shared/guide.ts";
import { isUnderstood, type GuideProgress } from "../shared/progress.ts";

/** A concept, or a Tests, Documentation, Supporting or Unsorted file, keyed by its subject's `subjectKey`. */
export type Entry =
  | { kind: "node"; key: string; subject: GuideSubject; node: LayeredNode }
  | { kind: "file"; key: string; subject: GuideSubject; path: string; category: SupportingCategory | null };

/** `id` is stable within a guide, so a fold or a progress row can name its group. */
export type EntryGroup = {
  id: string;
  kind: "layer" | "tests" | "docs" | "supporting" | "unsorted" | "foreign";
  title: string;
  entries: Entry[];
};

/** The PR/MR description, a page before the overview that no guide is needed for and nothing marks. */
export const DESCRIPTION_KEY = "description";
export const OVERVIEW_KEY = "overview";
/** Finish review, which the detail pane shows like an entry though the navigator does not list it. */
export const FINISH_KEY = "finish";

/**
 * The guide's groups trunk first: each layer from the foundations up, then Tests, Documentation,
 * Supporting, Unsorted and the files only other change requests change, leaving out empty ones.
 */
export function guideGroups(guide: LayeredGuide, forge: "github" | "gitlab"): EntryGroup[] {
  const layers: Entry[][] = [];
  for (const node of guide.nodes) (layers[node.layer] ??= []).push(nodeEntry(node));
  const { tests, docs, supporting, foreign } = splitSupporting(guide.supporting);
  const files = (entries: readonly { path: string; category: SupportingCategory | null }[]) => entries.map(({ path, category }) => fileEntry(path, category));
  const groups: EntryGroup[] = [
    // A node's layer is one past a node's it builds on, so no layer is empty.
    ...layers.map((entries, layer) => ({ id: `layer:${layer}`, kind: "layer" as const, title: layerTitle(layer), entries })),
    { id: "tests", kind: "tests", title: "Tests", entries: files(tests) },
    { id: "docs", kind: "docs", title: "Documentation", entries: files(docs) },
    { id: "supporting", kind: "supporting", title: "Supporting", entries: files(supporting) },
    { id: "unsorted", kind: "unsorted", title: "Unsorted", entries: files(guide.unsorted.map((path) => ({ path, category: null }))) },
    { id: "foreign", kind: "foreign", title: foreignGroupTitle(forge), entries: files(foreign) },
  ];
  return groups.filter((group) => group.entries.length > 0);
}

export function layerTitle(layer: number): string {
  return `Layer ${layer + 1}`;
}

function nodeEntry(node: LayeredNode): Entry {
  const subject: GuideSubject = { kind: "node", nodeId: node.id };
  return { kind: "node", key: subjectKey(subject), subject, node };
}

function fileEntry(path: string, category: SupportingCategory | null): Entry {
  const subject: GuideSubject = { kind: "file", path };
  return { kind: "file", key: subjectKey(subject), subject, path, category };
}

/** Every entry's key in navigator order, the description and the overview first. */
export function entryOrder(groups: readonly EntryGroup[]): string[] {
  return [DESCRIPTION_KEY, OVERVIEW_KEY, ...groups.flatMap((group) => group.entries.map((entry) => entry.key))];
}

/** The pages no reviewer marks understood, which reading on skips. */
function isUnmarked(key: string): boolean {
  return key === DESCRIPTION_KEY || key === OVERVIEW_KEY;
}

function entryOf(groups: readonly EntryGroup[], key: string): Entry | undefined {
  for (const group of groups) {
    const entry = group.entries.find((candidate) => candidate.key === key);
    if (entry) return entry;
  }
  return undefined;
}

function understoodKey(groups: readonly EntryGroup[], progress: GuideProgress | null, key: string): boolean {
  const entry = entryOf(groups, key);
  return progress !== null && entry !== undefined && isUnderstood(progress, entry.subject);
}

/** The description while nothing is marked, the overview once everything is, else the first entry not yet understood. */
export function startEntry(groups: readonly EntryGroup[], progress: GuideProgress | null): string {
  if (progress === null || progress.overall.understood === 0) return DESCRIPTION_KEY;
  return entryOrder(groups).find((key) => !isUnmarked(key) && !understoodKey(groups, progress, key)) ?? OVERVIEW_KEY;
}

/** `selected` while the guide still has it, or is one of `extra` (keys of pages that are no entry), else where the panel starts. */
export function resolveSelection(
  selected: string | null,
  groups: readonly EntryGroup[],
  progress: GuideProgress | null,
  extra: readonly string[] = [],
): string {
  if (selected !== null && (extra.includes(selected) || entryOrder(groups).includes(selected))) return selected;
  return startEntry(groups, progress);
}

/** The entry before or after `key` in navigator order; null at either end, or for a key that is no entry. */
export function stepEntry(groups: readonly EntryGroup[], key: string, step: -1 | 1): string | null {
  const order = entryOrder(groups);
  const index = order.indexOf(key);
  if (index === -1) return null;
  return order[index + step] ?? null;
}

/** The next entry after `key` not yet understood, wrapping round to the top; null once every other one is. */
export function nextNotUnderstood(groups: readonly EntryGroup[], key: string, progress: GuideProgress | null): string | null {
  const order = entryOrder(groups).filter((candidate) => !isUnmarked(candidate));
  const index = order.indexOf(key);
  const rotated = [...order.slice(index + 1), ...order.slice(0, Math.max(index, 0))];
  return rotated.find((candidate) => !understoodKey(groups, progress, candidate)) ?? null;
}

/** The first entry of `group` not yet understood, else its first. */
export function firstOpenInGroup(group: EntryGroup, progress: GuideProgress | null): string {
  return (group.entries.find((entry) => progress === null || !isUnderstood(progress, entry.subject)) ?? group.entries[0]!).key;
}

/**
 * The entry a draft was written from: the overview, or the node it is linked to, or for a draft no
 * node of this guide holds, the file entry of its path. Null when the guide has no entry for it.
 */
export function draftEntry(groups: readonly EntryGroup[], draft: LinkedDraft): string | null {
  if (draft.from?.kind === "overview") return OVERVIEW_KEY;
  if (draft.from?.kind === "node") {
    const key = subjectKey({ kind: "node", nodeId: draft.from.nodeId });
    if (entryOf(groups, key) !== undefined) return key;
  }
  const path = pathOf(draft.location);
  if (path === null) return null;
  const key = subjectKey({ kind: "file", path });
  return entryOf(groups, key) !== undefined ? key : null;
}

/** How many drafts each entry was written from, by key; an entry with none is absent. */
export function draftCounts(groups: readonly EntryGroup[], drafts: readonly LinkedDraft[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    const key = draftEntry(groups, draft);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export type PanelLayout = "stack" | "two" | "three";

/** A diff needs about 600px beside the navigator and the sidebar, and the phone apps keep the stack whatever their width. */
export function layoutFor(width: number, platform: "ios" | "android" | "web"): PanelLayout {
  if (platform !== "web") return "stack";
  if (width >= 1280) return "three";
  if (width >= 1000) return "two";
  return "stack";
}
