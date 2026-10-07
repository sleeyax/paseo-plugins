import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sampleLayeredGuide } from "./fake-guide-agents.ts";
import { ReviewStore, type GuideRecord } from "./review-store.ts";

test("a guide stored with one explanation per node reads it as the node's why, with no behaviour", async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-store-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new ReviewStore(data);
  const guide = sampleLayeredGuide();
  const explained = guide.nodes.map(({ why: _why, behaviour: _behaviour, ...node }) => ({ ...node, explanation: `How ${node.id} works.` }));
  const record = { headSha: "abc", workspaceId: "wks", agentId: "agent", status: "ready", guide: { ...guide, nodes: explained }, message: null, updatedAt: "" };
  await store.saveGuide("github/github.com/acme/uploader/7", record as unknown as GuideRecord);

  const read = await store.getGuide("github/github.com/acme/uploader/7", "abc");

  assert.deepEqual(
    read?.guide?.nodes.map(({ id, why, behaviour }) => ({ id, why, behaviour })),
    [
      { id: "retry-policy", why: "How retry-policy works.", behaviour: [] },
      { id: "uploader", why: "How uploader works.", behaviour: [] },
    ],
  );
  assert.equal(read?.guide?.nodes.some((node) => "explanation" in node), false);
});
