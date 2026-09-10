import assert from "node:assert/strict";
import test from "node:test";
import { classifyProviderEntry, envOf, providerEntryFor } from "./provider.ts";

const expected = providerEntryFor("/opt/paseo-plugins");

test("builds the entry the adapter README documents", () => {
  assert.deepEqual(expected, {
    extends: "acp",
    label: "Claude TTY",
    command: ["/opt/paseo-plugins/apps/claude-tty-acp/bin/claude-tty-acp"],
    params: { supportsMcpServers: false },
  });
});

test("treats a missing entry as absent", () => {
  assert.equal(classifyProviderEntry(undefined, expected), "absent");
  assert.equal(classifyProviderEntry(null, expected), "absent");
});

test("matches this checkout regardless of the label", () => {
  assert.equal(classifyProviderEntry(expected, expected), "matching");
  assert.equal(classifyProviderEntry({ ...expected, label: "Claude" }, expected), "matching");
  assert.equal(
    classifyProviderEntry(
      { ...expected, command: ["/opt/paseo-plugins/apps/../apps/claude-tty-acp/bin/claude-tty-acp"] },
      expected,
    ),
    "matching",
  );
});

test("leaves environment variables a host set on the entry alone", () => {
  const withEnv = { ...expected, env: { CLAUDE_BIN: "/usr/local/bin/claude", CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS: "900000" } };
  assert.equal(classifyProviderEntry(withEnv, expected), "matching");
  assert.deepEqual(envOf(withEnv), { CLAUDE_BIN: "/usr/local/bin/claude", CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS: "900000" });
  assert.equal(envOf(expected), null);
  assert.equal(envOf({ ...expected, env: "CLAUDE_BIN=claude" }), null);
});

test("reports this adapter pointed elsewhere or configured differently as mismatched", () => {
  assert.equal(
    classifyProviderEntry({ ...expected, command: ["/srv/other/apps/claude-tty-acp/bin/claude-tty-acp"] }, expected),
    "mismatched",
  );
  assert.equal(classifyProviderEntry({ ...expected, params: { supportsMcpServers: true } }, expected), "mismatched");
  assert.equal(classifyProviderEntry({ ...expected, params: undefined }, expected), "mismatched");
  assert.equal(classifyProviderEntry({ ...expected, extends: "claude" }, expected), "mismatched");
});

test("leaves an entry it does not recognise alone", () => {
  assert.equal(classifyProviderEntry({ enabled: false }, expected), "foreign");
  assert.equal(classifyProviderEntry({ extends: "acp", command: ["/usr/bin/trae"] }, expected), "foreign");
  assert.equal(classifyProviderEntry({ extends: "acp", command: [] }, expected), "foreign");
  assert.equal(classifyProviderEntry("traecli", expected), "foreign");
});
