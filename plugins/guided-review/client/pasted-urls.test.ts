import assert from "node:assert/strict";
import test from "node:test";
import { pastedUrls } from "./pasted-urls.ts";

test("takes a URL per line, trimmed, without blank lines or repeats", () => {
  const text = "  https://github.com/acme/uploader/pull/7 \r\n\n\thttps://gitlab.com/acme/uploader/-/merge_requests/3\nhttps://github.com/acme/uploader/pull/7\n   \n";
  assert.deepEqual(pastedUrls(text), ["https://github.com/acme/uploader/pull/7", "https://gitlab.com/acme/uploader/-/merge_requests/3"]);
});

test("a line is kept whole, spaces inside it included, for the start to turn down", () => {
  assert.deepEqual(pastedUrls("not a url"), ["not a url"]);
  assert.deepEqual(pastedUrls(" \n "), []);
});
