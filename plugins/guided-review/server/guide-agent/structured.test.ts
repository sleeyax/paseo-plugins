import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { fakeGuideAgents } from "../fake-guide-agents.ts";
import { GuideAgentError } from "./port.ts";
import { extractJson, jsonSchemaOf, parseReply, runStructured, withOutputSchema } from "./structured.ts";

const Body = z.object({ body: z.string().min(1) });

test("finds the JSON in a reply whether it is bare, fenced, or wrapped in prose", () => {
  assert.deepEqual(extractJson('{"body":"a"}'), { body: "a" });
  assert.deepEqual(extractJson('Here it is:\n```json\n{"body":"a"}\n```\nDone.'), { body: "a" });
  assert.deepEqual(extractJson('```\n[1, 2]\n```'), [1, 2]);
  assert.deepEqual(extractJson('Sure. {"body":"has } and { in it"} Hope that helps.'), { body: "has } and { in it" });
  assert.deepEqual(extractJson('I thought about {braces} first. {"body":"a"}'), { body: "a" });
  assert.equal(extractJson("No JSON here."), undefined);
});

test("a reply that fits the schema is its value, and one that does not says where", () => {
  assert.deepEqual(parseReply('{"body":"Why a retry here?"}', Body), { ok: true, value: { body: "Why a retry here?" } });
  assert.deepEqual(parseReply('{"body":""}', Body), { ok: false, errors: ["body: Too small: expected string to have >=1 characters"] });
  assert.deepEqual(parseReply("I cannot help with that.", Body), { ok: false, errors: ["The reply holds no JSON."] });
});

test("the prompt carries the schema, with its descriptions, after what was asked", () => {
  const prompt = withOutputSchema("  Word this comment.  ", jsonSchemaOf(z.object({ body: z.string().describe("The comment") })));

  assert.ok(prompt.startsWith("Word this comment.\n\nRespond with JSON only that matches this JSON Schema"));
  assert.match(prompt, /"description": "The comment"/);
});

test("a structured run sends the schema to the agent and returns the validated reply", async () => {
  const agents = fakeGuideAgents();
  const { id } = await agents.create({ workspace: { id: "w", directory: "/w" }, title: "Guide", labels: {}, prompt: "Explain." });
  await agents.reply(id);
  agents.answer = () => '```json\n{"body":"Why a retry here?"}\n```';

  assert.deepEqual(await runStructured(agents, id, "Word this comment.", Body), { body: "Why a retry here?" });
  assert.match(agents.created[0]!.sent[0]!, /^Word this comment\.\n\nRespond with JSON only/);

  agents.answer = () => '{"text":"wrong key"}';
  await assert.rejects(runStructured(agents, id, "Word this comment.", Body), (error: unknown) => {
    assert.ok(error instanceof GuideAgentError);
    assert.equal(error.message, "The guide agent's answer did not match what was asked for: body: Invalid input: expected string, received undefined.");
    return true;
  });
});
