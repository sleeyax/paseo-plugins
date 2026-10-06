import assert from "node:assert/strict";
import test from "node:test";
import { linkTarget, parseMarkdown } from "./markdown.ts";

const PROJECT = "https://gitlab.com/group/project";

test("draws the blocks a description is made of", () => {
  const source = ["## How to test", "", "> Note", "", "```sh", "make e2e", "```", "", "---"].join("\n");
  assert.deepEqual(parseMarkdown(source), [
    { kind: "heading", level: 2, spans: [{ text: "How to test" }] },
    { kind: "quote", blocks: [{ kind: "paragraph", spans: [{ text: "Note" }] }] },
    { kind: "code", text: "make e2e" },
    { kind: "rule" },
  ]);
});

test("keeps each inline mark on its own run, in the order written", () => {
  const [paragraph] = parseMarkdown("Run `make e2e` **first**, then *check* ~~nothing~~.");
  assert.deepEqual(paragraph, {
    kind: "paragraph",
    spans: [
      { text: "Run " },
      { text: "make e2e", code: true },
      { text: " " },
      { text: "first", strong: true },
      { text: ", then " },
      { text: "check", emphasis: true },
      { text: " " },
      { text: "nothing", strike: true },
      { text: "." },
    ],
  });
});

test("breaks lines where the author did and links bare URLs, as the forges do", () => {
  assert.deepEqual(parseMarkdown("first line\nsee https://example.com/x"), [
    {
      kind: "paragraph",
      spans: [{ text: "first line" }, { text: "\n" }, { text: "see " }, { text: "https://example.com/x", href: "https://example.com/x" }],
    },
  ]);
});

test("reads task lists, and an ordered list's start", () => {
  assert.deepEqual(parseMarkdown("- [ ] migrate\n- [x] **deploy**\n- plain"), [
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [
        { task: "open", blocks: [{ kind: "paragraph", spans: [{ text: "migrate" }] }] },
        { task: "done", blocks: [{ kind: "paragraph", spans: [{ text: "deploy", strong: true }] }] },
        { task: null, blocks: [{ kind: "paragraph", spans: [{ text: "plain" }] }] },
      ],
    },
  ]);
  const [ordered] = parseMarkdown("3. three\n4. four");
  assert.equal(ordered?.kind === "list" && ordered.start, 3);
});

test("reads a table's header, rows and alignment", () => {
  assert.deepEqual(parseMarkdown("| Flag | On |\n| :-- | --: |\n| `X` | yes |"), [
    { kind: "table", align: ["left", "right"], header: [[{ text: "Flag" }], [{ text: "On" }]], rows: [[[{ text: "X", code: true }], [{ text: "yes" }]]] },
  ]);
});

test("takes an image out of its paragraph, from Markdown or from the img tag GitHub pastes, with the size the author gave it", () => {
  assert.deepEqual(parseMarkdown("Before ![shot](/uploads/abc/shot.png) after"), [
    { kind: "paragraph", spans: [{ text: "Before " }] },
    { kind: "image", src: "/uploads/abc/shot.png", alt: "shot", width: null, height: null },
    { kind: "paragraph", spans: [{ text: " after" }] },
  ]);
  assert.deepEqual(parseMarkdown('<img width="594" height="890" alt="image" src="https://github.com/user-attachments/assets/1" />'), [
    { kind: "image", src: "https://github.com/user-attachments/assets/1", alt: "image", width: 594, height: 890 },
  ]);
  assert.deepEqual(parseMarkdown('Look: <img src="a.png" width="50%"><br>done'), [
    { kind: "paragraph", spans: [{ text: "Look: " }] },
    { kind: "image", src: "a.png", alt: "", width: null, height: null },
    { kind: "paragraph", spans: [{ text: "done" }] },
  ]);
});

test("folds a details block, whether its Markdown sits between two HTML blocks or inside one", () => {
  const spread = "<details>\n<summary>Logs</summary>\n\n- one\n\n</details>\n\nAfter";
  assert.deepEqual(parseMarkdown(spread), [
    {
      kind: "details",
      summary: [{ text: "Logs" }],
      blocks: [{ kind: "list", ordered: false, start: 1, items: [{ task: null, blocks: [{ kind: "paragraph", spans: [{ text: "one" }] }] }] }],
    },
    { kind: "paragraph", spans: [{ text: "After" }] },
  ]);
  assert.deepEqual(parseMarkdown("<details><summary>**Why**</summary>Because.</details>"), [
    { kind: "details", summary: [{ text: "Why", strong: true }], blocks: [{ kind: "paragraph", spans: [{ text: "Because." }] }] },
  ]);
  assert.deepEqual(parseMarkdown("<details>\n\nNever closed"), [{ kind: "details", summary: [{ text: "Details" }], blocks: [{ kind: "paragraph", spans: [{ text: "Never closed" }] }] }]);
});

test("shows any other HTML as written", () => {
  assert.deepEqual(parseMarkdown('<p align="center">Logo</p>\n\nPress <kbd>Ctrl</kbd>'), [
    { kind: "html", text: '<p align="center">Logo</p>' },
    { kind: "paragraph", spans: [{ text: "Press " }, { text: "<kbd>" }, { text: "Ctrl" }, { text: "</kbd>" }] },
  ]);
  assert.deepEqual(parseMarkdown("<!-- Describe your change -->"), [{ kind: "html", text: "<!-- Describe your change -->" }]);
});

test("a link goes where it says, relative to the project, and never to a scheme a browser should not be handed", () => {
  assert.equal(linkTarget("https://example.com/a", PROJECT), "https://example.com/a");
  assert.equal(linkTarget("mailto:a@example.com", PROJECT), "mailto:a@example.com");
  assert.equal(linkTarget("/uploads/abc/shot.png", PROJECT), `${PROJECT}/uploads/abc/shot.png`);
  assert.equal(linkTarget("docs/setup.md", PROJECT), `${PROJECT}/docs/setup.md`);
  assert.equal(linkTarget("//cdn.example.com/x.png", PROJECT), "https://cdn.example.com/x.png");
  assert.equal(linkTarget("#section", PROJECT), null);
  assert.equal(linkTarget("javascript:alert(1)", PROJECT), null);
  assert.equal(linkTarget("data:image/png;base64,AAAA", PROJECT), null);
});
