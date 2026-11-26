import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loginShell } from "./shell.ts";

describe("loginShell", () => {
  it("prefers the daemon's SHELL", () => {
    assert.equal(loginShell({ SHELL: "/usr/bin/zsh" }, () => "/bin/bash"), "/usr/bin/zsh");
  });

  it("falls back to the account's shell when SHELL is unset or not a path", () => {
    assert.equal(loginShell({}, () => "/bin/bash"), "/bin/bash");
    assert.equal(loginShell({ SHELL: "zsh" }, () => "/bin/bash"), "/bin/bash");
  });

  it("falls back to /bin/sh when neither is known", () => {
    assert.equal(loginShell({ SHELL: "" }, () => null), "/bin/sh");
  });
});
