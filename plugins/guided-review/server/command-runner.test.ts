import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "./command-runner.ts";

const node = process.execPath;

test("hands stdin to the command and returns its whole stdout", async () => {
  const input = JSON.stringify({ query: "{ viewer { login } }", variables: { body: "héllo ✓" } });
  const result = await runCommand({
    file: node,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    input,
    timeoutMs: 10_000,
  });
  assert.deepEqual(result, { exitCode: 0, stdout: input, stderr: "", spawnError: null });
});

test("does not truncate a large JSON document", async () => {
  // Several megabytes of multi-byte text, which arrives in many chunks split mid-character.
  const script = `process.stdout.write(JSON.stringify(Array.from({ length: 200000 }, (_, i) => "ł" + i)))`;
  const result = await runCommand({ file: node, args: ["-e", script], timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout) as string[];
  assert.equal(parsed.length, 200000);
  assert.equal(parsed[199999], "ł199999");
});

test("reports the exit code and stderr of a failing command", async () => {
  const result = await runCommand({
    file: node,
    args: ["-e", "process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1)"],
    timeoutMs: 10_000,
  });
  assert.deepEqual(result, { exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n", spawnError: null });
});

test("lays the given environment over the daemon's", async () => {
  const result = await runCommand({
    file: node,
    args: ["-e", "process.stdout.write(process.env.GH_PROMPT_DISABLED + ' ' + (process.env.PATH ? 'path' : 'none'))"],
    env: { GH_PROMPT_DISABLED: "1" },
    timeoutMs: 10_000,
  });
  assert.equal(result.stdout, "1 path");
});

test("leaves out the variables it is told to unset", async (t) => {
  process.env.GUIDED_REVIEW_TEST_AGENT = "agent_1";
  t.after(() => delete process.env.GUIDED_REVIEW_TEST_AGENT);
  const result = await runCommand({
    file: node,
    args: ["-e", "process.stdout.write(String(process.env.GUIDED_REVIEW_TEST_AGENT) + ' ' + (process.env.PATH ? 'path' : 'none'))"],
    unsetEnv: ["GUIDED_REVIEW_TEST_AGENT"],
    timeoutMs: 10_000,
  });
  assert.equal(result.stdout, "undefined path");
});

test("a missing binary is a spawn error rather than a rejection", async () => {
  const result = await runCommand({ file: "/nonexistent/gh", args: ["--version"], timeoutMs: 10_000 });
  assert.equal(result.exitCode, null);
  assert.match(result.spawnError ?? "", /ENOENT/);
});

test("kills a command that outlives its timeout", async () => {
  const result = await runCommand({ file: node, args: ["-e", "setTimeout(() => {}, 60000)"], timeoutMs: 200 });
  assert.equal(result.exitCode, null);
  assert.equal(result.spawnError, "Timed out after 200ms");
});

test("hands back a file the command prints byte for byte, base64-encoded", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0xc3]);
  const result = await runCommand({
    file: node,
    args: ["-e", `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`],
    stdoutEncoding: "base64",
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Buffer.from(result.stdout, "base64"), bytes);
});

test("stops a command that prints more than the call's own cap, and says so", async () => {
  const result = await runCommand({
    file: node,
    args: ["-e", "process.stdout.write(Buffer.alloc(4096)); setTimeout(() => {}, 5000)"],
    maxStdoutBytes: 1024,
    timeoutMs: 10_000,
  });
  assert.deepEqual([result.exitCode, result.spawnError, result.outputExceeded], [null, "Output exceeded 1024 bytes", true]);
});
