import { z } from "zod";
import { GuideAgentError, type GuideAgentPort } from "./port.ts";

/**
 * Structured output from any provider. Paseo passes an output schema natively only to the first
 * prompt of a new agent, and only Codex and OpenCode enforce it, so the schema also goes in the
 * prompt and the reply is parsed here: the JSON is found in whatever the agent wrote around it, then
 * validated with zod. Paseo's own CLI does the same.
 */

export type JsonSchema = Record<string, unknown>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: "draft-07", io: "input", unrepresentable: "any" }) as JsonSchema;
}

/** `prompt`, ending with the instruction to answer in JSON matching `schema`. */
export function withOutputSchema(prompt: string, schema: JsonSchema): string {
  return [
    prompt.trim(),
    "",
    "Respond with JSON only that matches this JSON Schema, as your final message:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

/** Validates a reply against `schema`, with the problems as `path: message` lines when it does not fit. */
export function parseReply<T>(reply: string, schema: z.ZodType<T>): Parsed<T> {
  const value = extractJson(reply);
  if (value === undefined) return { ok: false, errors: ["The reply holds no JSON."] };
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`),
  };
}

/**
 * Sends `prompt` to an idle agent with `schema` in it, and returns the validated reply. Throws a
 * `GuideAgentError` when the agent is busy or gone, or answers with something that does not fit.
 */
export async function runStructured<T>(
  agents: GuideAgentPort,
  agentId: string,
  prompt: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const reply = await agents.run(agentId, withOutputSchema(prompt, jsonSchemaOf(schema)));
  const parsed = parseReply(reply, schema);
  if (!parsed.ok) throw new GuideAgentError(describeInvalid(parsed.errors));
  return parsed.value;
}

/** One sentence for the reviewer, with the first few problems. */
export function describeInvalid(errors: readonly string[]): string {
  const shown = errors.slice(0, 3).join("; ");
  const more = errors.length > 3 ? `; and ${errors.length - 3} more` : "";
  return `The guide agent's answer did not match what was asked for: ${shown}${more}.`;
}

/**
 * The JSON in a reply: a fenced block when there is one, otherwise the first balanced object or
 * array that parses, otherwise the whole reply. Undefined when none of those is JSON.
 */
export function extractJson(reply: string): unknown {
  const text = reply.trim();
  for (const fenced of text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)) {
    const value = tryParse(fenced[1]!);
    if (value !== undefined) return value;
  }
  for (let start = 0; start < text.length; start++) {
    const char = text[start];
    if (char !== "{" && char !== "[") continue;
    const value = balancedFrom(text, start);
    if (value !== undefined) return value;
  }
  return tryParse(text);
}

function balancedFrom(text: string, start: number): unknown {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return tryParse(text.slice(start, index + 1));
  }
  return undefined;
}

function tryParse(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
