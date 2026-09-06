import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { disableLogFile, enableLogFile, logFilePath, writeLog } from "./log.ts";

test("keeps the log under the state directory, beside the sessions it is about", () => {
  assert.equal(logFilePath({ CLAUDE_TTY_ACP_STATE_DIR: "/state/here" }), path.join("/state/here", "logs", "claude-tty-acp.log"));
  assert.equal(logFilePath({ HOME: "/home/someone" }), path.join("/home/someone", ".local", "state", "claude-tty-acp", "logs", "claude-tty-acp.log"));
});

test("writes every record to the file once it is enabled, and moves a full file aside", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-tty-log-test-"));
  const file = path.join(root, "nested", "adapter.log");
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    enableLogFile(file, 200);
    writeLog({ level: "info", message: "first", sessionId: "s1" });
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!);
    assert.equal(record.message, "first");
    assert.equal(record.sessionId, "s1");
    assert.equal(record.pid, process.pid);
    assert.equal(typeof record.time, "string");

    writeLog({ level: "info", message: "second", padding: "x".repeat(200) });
    // The file is over its size now, so the next record starts a new one and the old one is kept once.
    writeLog({ level: "info", message: "third" });
    const rotated = (await readFile(`${file}.1`, "utf8")).trim().split("\n");
    assert.deepEqual(
      rotated.map((line) => JSON.parse(line).message),
      ["first", "second"],
    );
    const current = (await readFile(file, "utf8")).trim().split("\n");
    assert.deepEqual(
      current.map((line) => JSON.parse(line).message),
      ["third"],
    );

    disableLogFile();
    writeLog({ level: "info", message: "fourth" });
    assert.equal((await stat(file)).size, Buffer.byteLength(`${current[0]}\n`));
  } finally {
    process.stderr.write = stderr;
    disableLogFile();
    await rm(root, { force: true, recursive: true });
  }
});
