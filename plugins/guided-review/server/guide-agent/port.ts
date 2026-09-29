import type { ReviewWorkspace } from "../workspaces/port.ts";

/**
 * What the review service asks of the guide agent: a visible, read-only Paseo agent in the review's
 * workspace. `server/guide-agent/paseo.ts` implements it over the SDK; tests use
 * `server/fake-guide-agents.ts`.
 *
 * The port moves text only. Structured output is the caller's, through `server/guide-agent/structured.ts`,
 * because only some providers enforce a schema natively and every provider can be shown one in the
 * prompt, so the reply is parsed and validated the same way whichever provider wrote it.
 *
 * Every method but `create`, `status` and `archive` can take minutes, so none is awaited in an RPC.
 */
export interface GuideAgentPort {
  /**
   * Creates the agent in `workspace`, with the configured provider and model, in the provider's plan
   * or read-only mode, and starts it on `prompt`. Resolves once the agent exists, with the prompt
   * still running; `reply` waits for it.
   */
  create(input: GuideAgentCreateInput): Promise<{ id: string }>;
  /**
   * Waits for the agent's current turn to end and returns its final message. A permission request on
   * the way is answered rather than left waiting for a reviewer who is not there. Throws a
   * `GuideAgentError` when the turn fails, times out or ends with nothing said.
   */
  reply(agentId: string): Promise<string>;
  /** Sends `text` and returns its reply, as `reply` does. Throws a `GuideAgentError` while busy. */
  run(agentId: string, text: string): Promise<string>;
  /** Sends `text` and returns once it is sent; the reviewer reads the answer in the agent's chat. */
  send(agentId: string, text: string): Promise<void>;
  /**
   * Whether the agent can take a prompt. Sending to a busy agent interrupts its turn, so `send` and
   * `run` are only for an idle one.
   */
  status(agentId: string): Promise<GuideAgentStatus>;
  /** Archives the agent; one already archived or gone is not an error. */
  archive(agentId: string): Promise<void>;
}

export type GuideAgentCreateInput = {
  workspace: ReviewWorkspace;
  /** "Guide: <title>", as the sidebar and the agent's tab show it. */
  title: string;
  /** Tells the plugin's own agents apart from the reviewer's, across plugin restarts. */
  labels: Record<string, string>;
  prompt: string;
  /** Passed on only to providers that enforce a schema natively; the prompt carries it for every provider. */
  outputSchema?: Record<string, unknown>;
};

export type GuideAgentStatus = "idle" | "busy" | "gone";

/** A guide agent that did not answer, with a message fit to show the reviewer as it is. */
export class GuideAgentError extends Error {
  override name = "GuideAgentError";
}

/** The label every guide agent carries, with its review's ID as the value. */
export const GUIDE_AGENT_LABEL = "guided-review.review";
/** The head SHA the agent was asked to explain. */
export const GUIDE_HEAD_LABEL = "guided-review.head";
