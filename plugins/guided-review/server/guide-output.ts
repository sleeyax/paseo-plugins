import { GuideSchema, type Guide, type LayeredGuide, type SupportingEntry } from "../shared/guide.ts";
import { describeInvalid, parseReply } from "./guide-agent/structured.ts";

export type GuideParse = { ok: true; guide: Guide } | { ok: false; message: string };

/**
 * The tree is shown in about three layers at most: a chain deeper than that stays in the last layer,
 * in the agent's order, which still puts every node after the nodes it builds on.
 */
export const MAX_LAYERS = 3;

/**
 * The guide in the agent's reply, validated against the schema and then against itself: node IDs
 * are unique, the overview points only at nodes that exist, and every dependency points at a node
 * listed earlier, which is what keeps the nodes a DAG: an edge to a later node, or to the node
 * itself, is the only way a cycle can be written.
 */
export function parseGuide(reply: string): GuideParse {
  const parsed = parseReply(reply, GuideSchema);
  if (!parsed.ok) return { ok: false, message: describeInvalid(parsed.errors) };

  const guide = parsed.value;
  const errors: string[] = [];
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
  return errors.length === 0 ? { ok: true, guide } : { ok: false, message: describeInvalid(errors) };
}

/**
 * Lays a valid guide out for the panel: each node's layer from the DAG, whether it is a leaf, and
 * coverage against the forge's file list. Every changed file ends up in exactly one place: the
 * lockfiles and generated files set aside before generation in Supporting, then each other file in
 * the first node that names it, else in Supporting when the agent put it there, else in Unsorted.
 * A path the change does not have is dropped, since there is nothing to show for it.
 */
export function layOutGuide(guide: Guide, changed: readonly string[], setAside: readonly SupportingEntry[]): LayeredGuide {
  const layers = new Map<string, number>();
  const builtOn = new Set<string>();
  for (const node of guide.nodes) {
    const below = node.dependencies.map((dependency) => layers.get(dependency.nodeId) ?? 0);
    layers.set(node.id, below.length === 0 ? 0 : Math.min(MAX_LAYERS - 1, Math.max(...below) + 1));
    for (const dependency of node.dependencies) builtOn.add(dependency.nodeId);
  }

  const unplaced = new Set(changed);
  const place = (file: string) => unplaced.delete(normalise(file));
  for (const entry of setAside) unplaced.delete(entry.path);

  const nodes = guide.nodes.map((node) => ({
    ...node,
    files: node.files.map(normalise).filter(place),
    layer: layers.get(node.id)!,
    leaf: node.dependencies.length > 0 && !builtOn.has(node.id),
  }));
  const supporting = [
    ...setAside,
    ...guide.supporting.map((entry) => ({ ...entry, path: normalise(entry.path) })).filter((entry) => place(entry.path)),
  ];
  return { ...guide, nodes, supporting, unsorted: changed.filter((file) => unplaced.has(file)) };
}

/** Agents sometimes write a path relative to the working directory, or from the repository's root. */
function normalise(file: string): string {
  return file.replace(/^(\.\/|\/)+/, "");
}
