import { GuideSchema, type Guide } from "../shared/guide.ts";
import { resolveCode } from "./diff.ts";
import type { ChangedFile } from "./forge/port.ts";
import { describeInvalid, parseReply } from "./guide-agent/structured.ts";

export type GuideParse = { ok: true; guide: Guide } | { ok: false; message: string };

/**
 * The guide in the agent's reply, validated against the schema and then against itself: node IDs
 * are unique, the overview points only at nodes that exist, and the code each node covers is in
 * the diffs of the changed `files`.
 */
export function parseGuide(reply: string, files: readonly ChangedFile[]): GuideParse {
  const parsed = parseReply(reply, GuideSchema);
  if (!parsed.ok) return { ok: false, message: describeInvalid(parsed.errors) };

  const guide = parsed.value;
  const errors: string[] = [];
  const ids = new Set<string>();
  guide.nodes.forEach((node, index) => {
    if (ids.has(node.id)) errors.push(`nodes.${index}.id: "${node.id}" is used by an earlier node`);
    ids.add(node.id);
  });
  guide.overview.attention.forEach((entry, index) => {
    if (!ids.has(entry.nodeId)) errors.push(`overview.attention.${index}.nodeId: no node is "${entry.nodeId}"`);
  });
  guide.nodes.forEach((node, index) => {
    for (const error of resolveCode(files, node.covers).errors) errors.push(`nodes.${index}.${error}`);
  });
  return errors.length === 0 ? { ok: true, guide } : { ok: false, message: describeInvalid(errors) };
}
