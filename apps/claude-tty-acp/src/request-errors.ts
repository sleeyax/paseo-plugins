import { type Agent, RequestError } from "@agentclientprotocol/sdk";

/**
 * Hands the SDK an agent whose failures carry their own text as the JSON-RPC message.
 * The SDK answers any error that is not a `RequestError` with the message "Internal error" and
 * the real text in `data.details`, which a client is free to drop, and Paseo has. The code stays
 * -32603: Paseo branches on -32602 alone, so another code would change nothing but the meaning.
 */
export function withRequestErrors<T extends Agent>(agent: T): T {
  return new Proxy(agent, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          throw toRequestError(error);
        }
      };
    },
  });
}

export function toRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  return new RequestError(-32603, error instanceof Error ? error.message : String(error));
}
