import assert from "node:assert/strict";
import test from "node:test";
import type { HeadCheck } from "../shared/contracts.ts";
import { shownDescription } from "./shown-description.ts";

const HEAD = "b".repeat(40);
const description = { headSha: HEAD, description: "Test with RETRY=1.", projectUrl: "https://github.com/acme/uploader" };

function head(overrides: Partial<HeadCheck>): HeadCheck {
  return { guideHeadSha: HEAD, forgeHeadSha: HEAD, moved: false, newCommits: null, rewritten: false, state: "open", description: description.description, message: null, ...overrides };
}

test("shows the description read with the guide until the forge has it edited", () => {
  assert.deepEqual(shownDescription(description, null), { text: "Test with RETRY=1.", edited: false });
  assert.deepEqual(shownDescription(description, head({})), { text: "Test with RETRY=1.", edited: false });
  assert.deepEqual(shownDescription(description, head({ description: "Test with RETRY=0." })), { text: "Test with RETRY=0.", edited: true });
});

test("a forge that could not be asked, or a check of another guide's head, changes nothing", () => {
  assert.deepEqual(shownDescription(description, head({ description: null })), { text: "Test with RETRY=1.", edited: false });
  assert.deepEqual(shownDescription(description, head({ guideHeadSha: "d".repeat(40), description: "Other." })), { text: "Test with RETRY=1.", edited: false });
});
