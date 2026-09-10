import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newScan, readNewLines, type FileScan, type NewLines } from "./transcript-scan.ts";

const readLines = (file: string, scan: FileScan): Promise<NewLines> => readNewLines(file, scan, (lines) => lines);

test("reads only what has been appended since the last read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-scan-"));
  const file = path.join(root, "session.jsonl");
  const scan = newScan();

  await writeFile(file, '{"one":1}\n{"two":2}\n');
  assert.deepEqual(await readLines(file, scan), { text: '{"one":1}\n{"two":2}', rewritten: false });

  assert.deepEqual(await readLines(file, scan), { text: "", rewritten: false });

  await writeFile(file, '{"one":1}\n{"two":2}\n{"three":3}\n');
  assert.deepEqual(await readLines(file, scan), { text: '{"three":3}', rewritten: false });
});

test("holds a half-written line back until the read that finds the rest of it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-scan-"));
  const file = path.join(root, "session.jsonl");
  const scan = newScan();

  await writeFile(file, '{"one":1}\n{"tw');
  assert.deepEqual(await readLines(file, scan), { text: '{"one":1}', rewritten: false });

  await writeFile(file, '{"one":1}\n{"two":2}\n');
  assert.deepEqual(await readLines(file, scan), { text: '{"two":2}', rewritten: false });
});

test("counts bytes rather than characters, so a multi-byte record is not read twice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-scan-"));
  const file = path.join(root, "session.jsonl");
  const scan = newScan();

  await writeFile(file, '{"said":"↳ nested"}\n');
  assert.deepEqual(await readLines(file, scan), { text: '{"said":"↳ nested"}', rewritten: false });
  assert.deepEqual(await readLines(file, scan), { text: "", rewritten: false });
});

test("notices a rewrite that did not shrink the file, which is what a compaction looks like", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-scan-"));
  const file = path.join(root, "session.jsonl");
  const scan = newScan();

  await writeFile(file, '{"session":"first","record":1}\n{"session":"first","record":2}\n');
  assert.equal((await readLines(file, scan)).rewritten, false);

  // A compaction replaces the file with a summary and the turns after it, at whatever size that is.
  await writeFile(file, '{"session":"after","record":1}\n{"session":"after","record":2}\n{"session":"after","record":3}\n');
  const read = await readLines(file, scan);
  assert.equal(read.rewritten, true);
  assert.equal(read.text.split("\n").length, 3);

  // And one that shrank it, which is the case a length comparison would have caught on its own.
  await writeFile(file, '{"session":"third"}\n');
  assert.deepEqual(await readLines(file, scan), { text: '{"session":"third"}', rewritten: true });
});

test("serialises two reads that overlap, so one record is never read onto one tail twice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-scan-"));
  const file = path.join(root, "session.jsonl");
  const scan = newScan();

  await writeFile(file, '{"a":1}\n{"b":2}\n');
  // Two Paseo clients polling one session, or a poll slower than the panel refetches.
  const [first, second] = await Promise.all([readLines(file, scan), readLines(file, scan)]);
  assert.deepEqual(first, { text: '{"a":1}\n{"b":2}', rewritten: false });
  assert.deepEqual(second, { text: "", rewritten: false });

  // An offset left past the end of the file would read the whole of it again as a rewrite.
  assert.deepEqual(await readLines(file, scan), { text: "", rewritten: false });
});

test("signs a file that has grown past the signature, not just the head the first read caught", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-scan-"));
  const file = path.join(root, "session.jsonl");
  const scan = newScan();
  const head = '{"session":"opened"}\n';
  const turns = (tag: string) => Array.from({ length: 20 }, (_, index) => `{"tag":"${tag}","record":${index}}`).join("\n") + "\n";

  // The first read catches a file far shorter than the signature, and the offset moves past it.
  await writeFile(file, head);
  await readLines(file, scan);
  await writeFile(file, head + turns("first"));
  await readLines(file, scan);

  // A compaction lands on the same size and the same opening record, and differs after it.
  await writeFile(file, head + turns("after"));
  const read = await readLines(file, scan);
  assert.equal(read.rewritten, true);
  assert.ok(read.text.includes('"tag":"after"'));
});
