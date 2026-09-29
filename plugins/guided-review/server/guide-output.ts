import { GuideSchema, type Guide, type GuideDecision, type LayeredGuide, type SupportingEntry } from "../shared/guide.ts";
import { fileDiffOf, resolveCode, uncoveredCode } from "./diff.ts";
import type { ChangeRequest, ChangedFile } from "./forge/port.ts";
import { describeInvalid, parseReply } from "./guide-agent/structured.ts";

export type GuideParse = { ok: true; guide: Guide } | { ok: false; message: string };

/**
 * The tree is shown in about three layers at most: a chain deeper than that stays in the last layer,
 * in the agent's order, which still puts every node after the nodes it builds on.
 */
export const MAX_LAYERS = 3;

/**
 * The guide in the agent's reply, validated against the schema and then against itself: node IDs
 * are unique, the overview points only at nodes that exist, every dependency points at a node
 * listed earlier, which is what keeps the nodes a DAG: an edge to a later node, or to the node
 * itself, is the only way a cycle can be written, and the code each node covers is in the diffs of
 * `sent`, the changed files the agent was shown. Paths are normalised first, so a `./` the agent
 * adds is not an error. A cover naming one of the `setAside` paths, which the agent never saw, is
 * dropped rather than checked: those files are Supporting's whatever a node says, and a node left
 * covering nothing else is an error.
 */
export function parseGuide(reply: string, sent: readonly ChangedFile[], setAside: readonly string[]): GuideParse {
  const parsed = parseReply(reply, GuideSchema);
  if (!parsed.ok) return { ok: false, message: describeInvalid(parsed.errors) };

  const aside = new Set(setAside);
  const errors: string[] = [];
  const guide = {
    ...parsed.value,
    nodes: parsed.value.nodes.map((node, index) => {
      const covers = node.covers.map((cover) => ({ ...cover, path: normalise(cover.path) })).filter((cover) => !aside.has(cover.path));
      if (covers.length === 0) errors.push(`nodes.${index}.covers: it names only lockfiles or generated files, which are placed already`);
      return { ...node, covers };
    }),
    supporting: parsed.value.supporting.map((entry) => ({ ...entry, path: normalise(entry.path) })),
  };
  const all = new Set(guide.nodes.map((node) => node.id));
  const earlier = new Set<string>();
  guide.nodes.forEach((node, index) => {
    if (earlier.has(node.id)) errors.push(`nodes.${index}.id: "${node.id}" is used by an earlier node`);
    node.dependencies.forEach((dependency, edge) => {
      const at = `nodes.${index}.dependencies.${edge}.nodeId`;
      if (!all.has(dependency.nodeId)) errors.push(`${at}: no node is "${dependency.nodeId}"`);
      else if (dependency.nodeId === node.id) errors.push(`${at}: "${node.id}" cannot build on itself`);
      else if (!earlier.has(dependency.nodeId)) {
        errors.push(`${at}: "${dependency.nodeId}" comes after "${node.id}", and a node builds only on nodes listed before it`);
      }
    });
    earlier.add(node.id);
  });
  guide.overview.attention.forEach((entry, index) => {
    if (!all.has(entry.nodeId)) errors.push(`overview.attention.${index}.nodeId: no node is "${entry.nodeId}"`);
  });
  guide.nodes.forEach((node, index) => {
    for (const error of resolveCode(sent, node.covers).errors) errors.push(`nodes.${index}.${error}`);
  });
  return errors.length === 0 ? { ok: true, guide } : { ok: false, message: describeInvalid(errors) };
}

/**
 * `guide` with the alternative of each decision kept only when its quote is found in the author's own
 * words in `changeRequest`: its title, description, commit messages, linked issues, and the added lines
 * of the `sent` files' diffs. Case, curly quotes, Markdown emphasis and whitespace are not compared.
 */
export function keepQuotedAlternatives(guide: Guide, changeRequest: ChangeRequest, sent: readonly ChangedFile[]): Guide {
  const words = comparable(
    [
      changeRequest.title,
      changeRequest.description,
      ...changeRequest.commits.flatMap((commit) => [commit.headline, commit.body]),
      ...changeRequest.linkedIssues.flatMap((issue) => [issue.title, issue.body]),
      ...sent.flatMap((file) => fileDiffOf(file).hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "added").map((line) => line.text))),
    ].join("\n"),
  );
  const keep = (decisions: readonly GuideDecision[]) =>
    decisions.map((decision) => {
      const quote = decision.alternative === null ? "" : comparable(decision.alternative.quote).replace(/^["']|["'.]$/g, "");
      return quote.split(" ").length >= MIN_QUOTE_WORDS && words.includes(quote) ? decision : { ...decision, alternative: null };
    });
  return {
    ...guide,
    overview: { ...guide.overview, decisions: keep(guide.overview.decisions) },
    nodes: guide.nodes.map((node) => ({ ...node, decisions: keep(node.decisions) })),
  };
}

/** A shorter quote, a name or a word, backs nothing: it is in the author's text whatever the alternative. */
const MIN_QUOTE_WORDS = 3;

function comparable(text: string): string {
  return text.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Lays a valid guide out for the panel: each node's layer from the DAG, whether it is a leaf, and
 * coverage against the forge's `changed` files. A node's code is its `covers`, and several nodes may
 * cover different hunks of one file, so coverage sorts what no node covers, and nothing in the
 * change goes unshown: the lockfiles and generated files set aside before generation go to
 * Supporting, then every file with a change no node covers, the whole file or only the rest of a
 * partly covered one, goes to the agent's Supporting entry for it, or else to Unsorted. An entry
 * shows only what no node covers (`entryCode` in `server/diff.ts`). Each file is listed once, and a
 * Supporting entry for a path the change lacks, or for a file the nodes cover whole, is dropped,
 * since there is nothing left to show for it.
 */
export function layOutGuide(guide: Guide, changed: readonly ChangedFile[], setAside: readonly SupportingEntry[]): LayeredGuide {
  const layers = new Map<string, number>();
  const builtOn = new Set<string>();
  for (const node of guide.nodes) {
    const below = node.dependencies.map((dependency) => layers.get(dependency.nodeId) ?? 0);
    layers.set(node.id, below.length === 0 ? 0 : Math.min(MAX_LAYERS - 1, Math.max(...below) + 1));
    for (const dependency of node.dependencies) builtOn.add(dependency.nodeId);
  }

  const covers = guide.nodes.flatMap((node) => node.covers);
  const aside = new Set(setAside.map((entry) => entry.path));
  const unplaced = new Set(changed.filter((file) => !aside.has(file.path) && uncoveredCode(file, covers) !== null).map((file) => file.path));
  const place = (file: string) => unplaced.delete(normalise(file));

  const nodes = guide.nodes.map((node) => ({
    ...node,
    layer: layers.get(node.id)!,
    leaf: node.dependencies.length > 0 && !builtOn.has(node.id),
  }));
  const supporting = [
    ...setAside,
    ...guide.supporting.map((entry) => ({ ...entry, path: normalise(entry.path) })).filter((entry) => place(entry.path)),
  ];
  return { ...guide, nodes, supporting, unsorted: changed.map((file) => file.path).filter((file) => unplaced.has(file)) };
}

/** Agents sometimes write a path relative to the working directory, or from the repository's root. */
function normalise(file: string): string {
  return file.replace(/^(\.\/|\/)+/, "");
}
