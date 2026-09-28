import assert from "node:assert/strict";
import test from "node:test";
import { askPrompt, codeReferencesOf } from "./ask-prompt.ts";
import { resolveCode } from "./diff.ts";
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
    rest: null,
  });

  assert.match(prompt, /kept outside its concepts: src\/upload\.test\.ts\./);
  assert.match(prompt, /The file was modified, \+30 −7\. The guide lists it under Supporting, as test\./);
  assert.match(prompt, /how it supports the rest of the change\./);
});

test("a node's code references are the head-side lines of what it covers, whole files with none", () => {
  const files = [
    { path: "src/a.ts", previousPath: null, status: "modified" as const, additions: 3, deletions: 3, patch: "@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -3,1 +3,1 @@\n-d\n+e\n@@ -9,2 +8,0 @@\n-f\n-g" },
    { path: "src/b.ts", previousPath: null, status: "removed" as const, additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-x\n-y" },
  ];
  const covered = resolveCode(files, [
    { path: "src/a.ts", hunks: [1, 2, 3], lines: [] },
    { path: "src/b.ts", hunks: [], lines: [{ start: 2, end: 2 }] },
  ]).files;
  assert.deepEqual(codeReferencesOf(covered), [
    { path: "src/a.ts", ranges: [] },
    { path: "src/b.ts", ranges: [{ start: 2, end: 2 }] },
  ]);

  const some = resolveCode(files, [{ path: "src/a.ts", hunks: [2, 1], lines: [] }]).files;
  assert.deepEqual(codeReferencesOf(some), [{ path: "src/a.ts", ranges: [{ start: 1, end: 3 }] }]);

  // A hunk that only removes lines is named by the head line after them.
  const removal = resolveCode(files, [{ path: "src/a.ts", hunks: [3], lines: [] }]).files;
  assert.deepEqual(codeReferencesOf(removal), [{ path: "src/a.ts", ranges: [{ start: 9, end: 9 }] }]);
});
