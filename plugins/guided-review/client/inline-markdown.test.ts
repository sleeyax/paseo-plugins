import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, plainText } from "./inline-markdown.ts";

test("reads code spans, strong and emphasis between plain text", () => {
  assert.deepEqual(parseInline("`canPublish` is **only** true for a *draft* or _pinned_ one"), [
    { text: "canPublish", code: true },
    { text: " is " },
    { text: "only", strong: true },
    { text: " true for a " },
    { text: "draft", emphasis: true },
    { text: " or " },
    { text: "pinned", emphasis: true },
    { text: " one" },
  ]);
});

test("nests marks, and keeps a code span's asterisks literal", () => {
  assert.deepEqual(parseInline("**calls `a*b*c` and *waits* here**"), [
    { text: "calls ", strong: true },
    { text: "a*b*c", strong: true, code: true },
    { text: " and ", strong: true },
    { text: "waits", strong: true, emphasis: true },
    { text: " here", strong: true },
  ]);
});

test("closes a code span only on a run of the same length, and trims its padding", () => {
  assert.deepEqual(parseInline("`` a `tick` `` then ``"), [{ text: "a `tick`", code: true }, { text: " then ``" }]);
});

test("leaves unclosed delimiters, snake_case, and spaced asterisks as text", () => {
  for (const text of ["`publishedAt == null", "is_social_benefit_draft", "a * b * c", "**not closed", "a lone _ underscore"]) {
    assert.deepEqual(parseInline(text), [{ text }]);
  }
});

test("reads nothing out of an empty string", () => {
  assert.deepEqual(parseInline(""), []);
});

test("drops the Markdown for plain text", () => {
  assert.equal(plainText("**Publish** `canPublish` for a *draft*"), "Publish canPublish for a draft");
});
