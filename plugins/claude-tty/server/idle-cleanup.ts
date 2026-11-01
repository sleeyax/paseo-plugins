import type { AcpTransformer } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";

/** Mirrors the adapter's own `vendor-updates.ts`; the plugin runs in the daemon and cannot import it. */
export const CLAUDE_RUNNING_METHOD = "_claude_tty/claude_running";

export const CAN_STOP_RUNTIME_CAPABILITY = "session.can_stop_runtime";

type CanStopRuntime = Extract<ProviderInput, { type: "session.can_stop_runtime" }>;

/**
 * Paseo closes an idle session's runtime, and `runAcpProvider` does that by ending the adapter, which takes Claude down with it.
 * Paseo's own checks see turns, cards and subsessions, not the background shells and subagents Claude keeps running after a turn.
 * So a session may stop only while its Claude is not running, which leaves claude-tty's own idle suspension deciding when Claude stops.
 *
 * The adapter reports Claude starting and stopping; `runAcpProvider` does not handle the query, so the wrapper answers it and never passes it on.
 * The query names Paseo's session ID, and arrives for a subsession too, which is answered for the session it runs in.
 */
export function idleCleanupVeto(): {
  transformer: AcpTransformer;
  wrap(connection: ProviderConnection, offered: readonly string[]): ProviderConnection;
} {
  /** The sessions whose Claude is running. */
  const running = new Set<string>();

  return {
    transformer: {
      notification({ method, params }, context) {
        if (method !== CLAUDE_RUNNING_METHOD) return null;
        const reported = params !== null && typeof params === "object" && !Array.isArray(params) ? params.running : undefined;
        if (reported === true) running.add(context.sessionId);
        if (reported === false) running.delete(context.sessionId);
        return null;
      },
    },
    wrap(connection, offered) {
      // A daemon before Paseo 0.14 has no idle cleanup to veto.
      if (!offered.includes(CAN_STOP_RUNTIME_CAPABILITY)) return connection;

      const listeners = new Set<(event: ProviderEvent) => void>();
      /** Every open session, by the session whose Claude it runs in. */
      const roots = new Map<string, string>();

      const emit = (event: ProviderEvent): void => {
        for (const listener of listeners) listener(event);
      };

      const forget = (sessionId: string): void => {
        roots.delete(sessionId);
        running.delete(sessionId);
      };

      const answer = (input: CanStopRuntime): void => {
        const root = roots.get(input.sessionId);
        if (root === undefined) {
          emit({ type: "request.failed", requestId: input.requestId, error: { message: `Session ${input.sessionId} is not open` } });
          return;
        }
        emit({ type: "session.can_stop_runtime", requestId: input.requestId, sessionId: input.sessionId, canStop: !running.has(root) });
      };

      const unsubscribe = connection.onEvent((event) => {
        if (event.type === "session.opened") {
          const root = event.parentSessionId === undefined ? event.sessionId : (roots.get(event.parentSessionId) ?? event.parentSessionId);
          roots.set(event.sessionId, root);
          // Paseo collects a session that does not advertise it without asking.
          emit({ ...event, capabilities: [...event.capabilities, CAN_STOP_RUNTIME_CAPABILITY] });
          return;
        }
        if (event.type === "session.closed" || event.type === "session.runtime_failed") forget(event.sessionId);
        emit(event);
      });

      return {
        version: connection.version,
        capabilities: [...connection.capabilities, CAN_STOP_RUNTIME_CAPABILITY],
        async send(input: ProviderInput) {
          if (input.type === "session.can_stop_runtime") return answer(input);
          if (input.type === "session.close") forget(input.sessionId);
          return connection.send(input);
        },
        onEvent(listener: (event: ProviderEvent) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          listeners.clear();
          roots.clear();
          running.clear();
          unsubscribe();
          await connection.close();
        },
      };
    },
  };
}
