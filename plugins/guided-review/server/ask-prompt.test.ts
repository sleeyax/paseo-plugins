import assert from "node:assert/strict";
import test from "node:test";
import { askPrompt } from "./ask-prompt.ts";
import { sampleChangeRequest } from "./fake-forge.ts";
import { sampleGuide } from "./fake-guide-agents.ts";

const changeRequest = sampleChangeRequest("https://github.com/acme/uploader/pull/7");

test("a node's prompt lists the code it covers, file by file with its lines", () => {
  const prompt = askPrompt(changeRequest.ref, changeRequest.headSha, {
    kind: "node",
    node: sampleGuide().nodes[0]!,
    code: [
      { path: "src/retry.ts", ranges: [{ start: 1, end: 12 }] },
      { path: "src/upload.ts", ranges: [{ start: 4, end: 4 }] },
      { path: "src/config.ts", ranges: [{ start: 2, end: 3 }, { start: 9, end: 9 }] },
      { path: "README.md", ranges: [] },
    ],
  });

  assert.match(
    prompt,
    /\n\nThe code it covers:\n- src\/retry\.ts, lines 1-12\n- src\/upload\.ts, line 4\n- src\/config\.ts, lines 2-3, 9\n- README\.md\n\n/,
  );
});

test("a Supporting file's prompt names its category", () => {
  const prompt = askPrompt(changeRequest.ref, changeRequest.headSha, {
    kind: "file",
    file: { ...changeRequest.files[0]!, path: "src/upload.test.ts" },
    category: "test",
  });

  assert.match(prompt, /kept outside its concepts: src\/upload\.test\.ts\./);
  assert.match(prompt, /The file was modified, \+30 −7\. The guide lists it under Supporting, as test\./);
  assert.match(prompt, /how it supports the rest of the change\./);
});
