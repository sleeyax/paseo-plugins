import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_INBOX_PREFERENCES, type InboxPreferences } from "../shared/inbox-preferences.ts";
import { InboxPreferencesFile } from "./inbox-preferences.ts";

async function dataDirectory(t: TestContext): Promise<string> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-inbox-preferences-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  return data;
}

test("with nothing saved the list hides what the reviewer approved and sorts by the latest update", async (t) => {
  const preferences = await new InboxPreferencesFile(await dataDirectory(t)).read();

  assert.deepEqual(preferences, {
    provider: "all",
    hideApproved: true,
    hideDrafts: false,
    needsAttention: false,
    sort: { key: "updated", descending: true },
    columns: ["project", "title", "author", "updated", "state", "local"],
  });
});

test("what is saved is read back after a restart", async (t) => {
  const data = await dataDirectory(t);
  const saved: InboxPreferences = {
    provider: "gitlab",
    hideApproved: false,
    hideDrafts: true,
    needsAttention: true,
    sort: { key: "size", descending: false },
    columns: ["title", "ci", "size"],
  };

  await new InboxPreferencesFile(data).save(saved);

  assert.deepEqual(await new InboxPreferencesFile(data).read(), { ...saved, columns: ["title", "size", "ci"] });
});

test("a field the plugin no longer knows falls back on its own, keeping the rest of the file", async (t) => {
  const data = await dataDirectory(t);
  await writeFile(
    path.join(data, "inbox-preferences.json"),
    JSON.stringify({ provider: "bitbucket", hideDrafts: true, sort: { key: "stars" }, columns: ["title", "reactions"], extra: 1 }),
  );

  assert.deepEqual(await new InboxPreferencesFile(data).read(), {
    ...DEFAULT_INBOX_PREFERENCES,
    hideDrafts: true,
    columns: ["title"],
  });
});

test("saves sent together all land, the last one kept", async (t) => {
  const data = await dataDirectory(t);
  const file = new InboxPreferencesFile(data);

  await Promise.all([true, false, true].map((hideDrafts) => file.save({ ...DEFAULT_INBOX_PREFERENCES, hideDrafts })));

  assert.equal((await file.read()).hideDrafts, true);
});
