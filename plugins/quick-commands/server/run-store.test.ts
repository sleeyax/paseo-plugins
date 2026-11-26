import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRunStore } from "./run-store.ts";

const quiet = () => {};

describe("createRunStore", () => {
  it("round-trips runs, creating the directory", async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "quick-commands-")), "nested", "last-runs.json");
    const store = createRunStore(file, quiet);
    const runs = { a: { status: "failed" as const, exitCode: 1, startedAt: 1, finishedAt: 2, output: ["boom"] } };
    await store.save(runs);
    assert.deepEqual(await store.load(), runs);
  });

  it("loads a missing or unreadable file as no runs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "quick-commands-"));
    assert.deepEqual(await createRunStore(path.join(directory, "missing.json"), quiet).load(), {});
    const broken = path.join(directory, "broken.json");
    await writeFile(broken, "{ not json");
    assert.deepEqual(await createRunStore(broken, quiet).load(), {});
  });
});
