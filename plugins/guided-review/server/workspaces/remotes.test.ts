import assert from "node:assert/strict";
import test from "node:test";
import { isSameRepository, parseRemoteUrl } from "./remotes.ts";

const REPO = { host: "github.com", project: "sleeyax/paseo-plugins" };

test("every way git spells a remote names the same repository", () => {
  for (const remote of [
    "https://github.com/sleeyax/paseo-plugins.git",
    "https://github.com/sleeyax/paseo-plugins",
    "https://github.com/Sleeyax/Paseo-Plugins/",
    "https://token@github.com/sleeyax/paseo-plugins.git",
    "git@github.com:sleeyax/paseo-plugins.git",
    "github.com:sleeyax/paseo-plugins",
    "ssh://git@github.com/sleeyax/paseo-plugins.git",
    "ssh://git@github.com:22/sleeyax/paseo-plugins",
  ]) {
    assert.equal(isSameRepository(remote, REPO), true, remote);
  }
});

test("another repository, host or a local path is not the same one", () => {
  for (const remote of [
    "https://github.com/sleeyax/other.git",
    "https://github.com/fork/paseo-plugins.git",
    "https://gitlab.com/sleeyax/paseo-plugins.git",
    "/home/paseo/projects/paseo-plugins",
    "file:///home/paseo/projects/paseo-plugins",
    "",
  ]) {
    assert.equal(isSameRepository(remote, REPO), false, remote);
  }
});

test("keeps a GitLab subgroup path whole", () => {
  assert.deepEqual(parseRemoteUrl("git@gitlab.example.com:group/sub/project.git"), {
    host: "gitlab.example.com",
    project: "group/sub/project",
  });
});
