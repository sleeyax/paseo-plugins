import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OutputTail } from "./output-tail.ts";

describe("OutputTail", () => {
  it("joins lines split across chunks and keeps an unfinished last line", () => {
    const tail = new OutputTail(10);
    tail.push("hel");
    tail.push("lo\nwor");
    assert.deepEqual(tail.lines(), ["hello", "wor"]);
  });

  it("keeps only the last lines", () => {
    const tail = new OutputTail(2);
    tail.push("1\n2\n3\n4\n");
    assert.deepEqual(tail.lines(), ["3", "4"]);
  });

  it("strips colours and treats CRLF as a line end", () => {
    const tail = new OutputTail(10);
    tail.push("\x1b[32mok\x1b[0m\r\nnext\r\n");
    assert.deepEqual(tail.lines(), ["ok", "next"]);
  });

  it("keeps only the last redraw of a progress line", () => {
    const tail = new OutputTail(10);
    tail.push("10%\r50%");
    tail.push("\r100%\ndone\n");
    assert.deepEqual(tail.lines(), ["100%", "done"]);
  });
});
