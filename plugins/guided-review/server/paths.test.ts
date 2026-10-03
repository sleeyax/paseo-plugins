import assert from "node:assert/strict";
import test from "node:test";
import { dataDirectory } from "./paths.ts";

test("keeps its data in the daemon's Paseo home", () => {
  assert.equal(dataDirectory({ PASEO_HOME: "/srv/paseo" }), "/srv/paseo/plugin-data/guided-review");
  assert.equal(dataDirectory({ PASEO_HOME: "~/work/.paseo", HOME: "/home/r" }), "/home/r/work/.paseo/plugin-data/guided-review");
  assert.equal(dataDirectory({ HOME: "/home/r" }), "/home/r/.paseo/plugin-data/guided-review");
});
