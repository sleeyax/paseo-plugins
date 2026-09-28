import { GuideSchema, type Guide } from "../shared/guide.ts";
import { describeInvalid, parseReply } from "./guide-agent/structured.ts";

export type GuideParse = { ok: true; guide: Guide } | { ok: false; message: string };

/**
 * The guide in the agent's reply, validated against the schema and then against itself: node IDs
 * are unique, and the overview points only at nodes that exist.
 */
export function parseGuide(reply: string): GuideParse {
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
  return errors.length === 0 ? { ok: true, guide } : { ok: false, message: describeInvalid(errors) };
}
