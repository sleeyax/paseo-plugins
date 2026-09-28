import assert from "node:assert/strict";
import test from "node:test";
import { composeBody, isParagraphId, paragraphId, splitBody } from "./review-body.ts";

/** How node comments share GitHub's one pending review body with the reviewer's own text. */

const RETRY = { id: "paragraph-1", body: "About the retry handling: why full jitter?" };
const LOG = { id: "paragraph-2", body: "About the logging:\n\nis every upload logged?" };

test("the reviewer's own text comes first, then each node comment, a blank line apart", () => {
  assert.equal(composeBody("Looks good overall.", [RETRY, LOG]), `Looks good overall.\n\n${RETRY.body}\n\n${LOG.body}`);
  assert.equal(composeBody("  ", [RETRY]), RETRY.body);
  assert.equal(composeBody("", []), "");
});

test("the paragraphs come back out whole, leaving the reviewer's own text", () => {
  const body = composeBody("Looks good overall.\n\nOne question below.", [RETRY, LOG]);

  assert.deepEqual(splitBody(body, [RETRY, LOG]), { own: "Looks good overall.\n\nOne question below.", found: [RETRY, LOG] });
  assert.deepEqual(splitBody(composeBody("", [RETRY]), [RETRY]), { own: "", found: [RETRY] });
});

test("a body typed on GitHub's web page, with CRLF line ends, still gives its paragraphs back", () => {
  const body = composeBody("Own text.", [RETRY, LOG]).replace(/\n/g, "\r\n");

  assert.deepEqual(splitBody(body, [RETRY, LOG]), { own: "Own text.", found: [RETRY, LOG] });
});

test("a paragraph edited on the web is not found, and its text stays in the reviewer's own", () => {
  const body = composeBody("Own text.", [{ ...RETRY, body: `${RETRY.body} Edited.` }, LOG]);

  assert.deepEqual(splitBody(body, [RETRY, LOG]), { own: `Own text.\n\n${RETRY.body} Edited.`, found: [LOG] });
});

test("text that only contains a paragraph's is not that paragraph", () => {
  const body = `Own text, ${RETRY.body}\n\nMore.`;

  assert.deepEqual(splitBody(body, [RETRY]), { own: body, found: [] });
});

test("own text the same as a node comment keeps its place; the last copy is the comment", () => {
  const same = { id: "paragraph-3", body: "Why?" };

  assert.deepEqual(splitBody(composeBody("Why?", [same]), [same]), { own: "Why?", found: [same] });
  assert.deepEqual(splitBody(composeBody("", [same, { ...same, id: "paragraph-4" }]), [same, { ...same, id: "paragraph-4" }]), {
    own: "",
    found: [same, { ...same, id: "paragraph-4" }],
  });
});

test("a paragraph's ID cannot be taken for a GitHub comment's", () => {
  assert.ok(isParagraphId(paragraphId()));
  assert.notEqual(paragraphId(), paragraphId());
  assert.equal(isParagraphId("PRRC_kwDOUFGNmM6kZ1a1"), false);
});
