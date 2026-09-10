import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DAEMON_HOST, resolveDaemonPassword, resolveDaemonUrl } from "./daemon-url.ts";

test("falls back to the default daemon host", () => {
  assert.deepEqual(resolveDaemonUrl({ env: {} }), { url: `ws://${DEFAULT_DAEMON_HOST}/ws` });
});

test("prefers the environment over the files", () => {
  const target = resolveDaemonUrl({
    env: { PASEO_HOST: "127.0.0.1:7000" },
    pidListen: "127.0.0.1:8000",
    configListen: "127.0.0.1:9000",
  });
  assert.equal(target.url, "ws://127.0.0.1:7000/ws");
});

test("prefers the pid file over the config file", () => {
  const target = resolveDaemonUrl({ env: {}, pidListen: "127.0.0.1:8000", configListen: "127.0.0.1:9000" });
  assert.equal(target.url, "ws://127.0.0.1:8000/ws");
});

test("strips a tcp scheme", () => {
  assert.equal(resolveDaemonUrl({ env: { PASEO_HOST: "tcp://10.0.0.2:6767" } }).url, "ws://10.0.0.2:6767/ws");
});

test("keeps a websocket url and gives it the daemon's path", () => {
  assert.equal(resolveDaemonUrl({ env: { PASEO_HOST: "wss://paseo.example" } }).url, "wss://paseo.example/ws");
  assert.equal(resolveDaemonUrl({ env: { PASEO_HOST: "ws://host:6767/ws" } }).url, "ws://host:6767/ws");
});

test("reports a socket it cannot dial instead of guessing", () => {
  const target = resolveDaemonUrl({ env: {}, pidListen: "unix:///run/user/1000/paseo.sock" });
  assert.match(target.error ?? "", /cannot dial/);
  assert.equal(target.url, undefined);
});

test("passes the daemon password through when one is set", () => {
  assert.equal(resolveDaemonPassword({ PASEO_PASSWORD: "hunter2" }), "hunter2");
  assert.equal(resolveDaemonPassword({ PASEO_PASSWORD: "" }), undefined);
  assert.equal(resolveDaemonPassword({}), undefined);
});
