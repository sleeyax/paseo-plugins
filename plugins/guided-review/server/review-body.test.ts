import assert from "node:assert/strict";
import test from "node:test";
import { isParagraphId, paragraphId } from "./review-body.ts";

test("a paragraph's ID cannot be taken for a GitHub comment's", () => {
  assert.ok(isParagraphId(paragraphId()));
  assert.notEqual(paragraphId(), paragraphId());
  assert.equal(isParagraphId("PRRC_kwDOUFGNmM6kZ1a1"), false);
});
