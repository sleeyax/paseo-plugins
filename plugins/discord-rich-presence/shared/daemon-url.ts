export type Env = Record<string, string | undefined>;

export const DEFAULT_DAEMON_HOST = "127.0.0.1:6767";

export type DaemonTarget = { url: string; error?: undefined } | { url?: undefined; error: string };

function isIpcHost(host: string): boolean {
  return host.startsWith("unix://") || host.startsWith("pipe://") || host.startsWith("\\\\.\\pipe\\");
}

/**
 * Mirrors the CLI's host resolution order, minus its IPC support: the SDK dials through
 * `globalThis.WebSocket`, which cannot open a unix socket, so a daemon listening on one is
 * reported rather than silently missed.
 */
export function resolveDaemonUrl(input: {
  env: Env;
  pidListen?: string | null;
  configListen?: string | null;
}): DaemonTarget {
  const candidates = [
    input.env.PASEO_HOST,
    input.env.PASEO_LISTEN,
    input.pidListen,
    input.configListen,
    DEFAULT_DAEMON_HOST,
  ];
  const host = candidates.map((value) => value?.trim()).find((value) => Boolean(value)) as string;

  if (isIpcHost(host)) {
    return {
      error: `The daemon listens on ${host}, which this plugin cannot dial. Set daemon.listen to a host:port.`,
    };
  }

  const withoutScheme = host.startsWith("tcp://") ? host.slice("tcp://".length) : host;
  if (withoutScheme.startsWith("ws://") || withoutScheme.startsWith("wss://")) {
    return { url: withoutScheme.endsWith("/ws") ? withoutScheme : `${withoutScheme.replace(/\/$/, "")}/ws` };
  }
  return { url: `ws://${withoutScheme.replace(/\/$/, "")}/ws` };
}

/** The daemon hashes `PASEO_PASSWORD` at startup, and the plugin subprocess inherits its environment. */
export function resolveDaemonPassword(env: Env): string | undefined {
  const password = env.PASEO_PASSWORD;
  return password && password.length > 0 ? password : undefined;
}
