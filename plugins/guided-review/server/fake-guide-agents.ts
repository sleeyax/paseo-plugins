import type { Guide, LayeredGuide } from "../shared/guide.ts";
import { GuideAgentError, type GuideAgentCreateInput, type GuideAgentPort, type GuideAgentStatus } from "./guide-agent/port.ts";

type FakeAgent = GuideAgentCreateInput & {
  id: string;
  /** Every prompt after the first, in order. */
  sent: string[];
  status: GuideAgentStatus;
};

/**
 * Guide agents as a test arranges them: each answers with whatever `answer` returns for it, which is
 * fixture output, a promise the test resolves when it wants the agent to finish, or an error.
 */
export type FakeGuideAgents = GuideAgentPort & {
  created: FakeAgent[];
  archived: string[];
  /** The reply to an agent's latest prompt. Defaults to an empty reply. */
  answer: (agent: FakeAgent) => string | Error | Promise<string | Error>;
  /** When set, the next creation fails with it. */
  failCreate: Error | null;
};

/** A guide for `sampleChangeRequest`, as a guide agent would write it. */
export function sampleGuide(): Guide {
  return {
    overview: {
      idea: "Uploads that fail on a flaky network are retried with exponential backoff instead of failing at once.",
      needToKnows: ["An upload is retried only when the failure is transient: a timeout or a 5xx."],
      decisions: [{ choice: "Retry inside the uploader.", rejected: "Retrying in every caller, which would repeat the policy." }],
      attention: [{ nodeId: "retry-policy", reason: "Every retry decision is made here." }],
    },
    nodes: [
      {
        id: "retry-policy",
        title: "Retry policy",
        summary: "Decides whether and when a failed upload is tried again.",
        explanation: "A pure function from the attempt number and the failure to a delay, or to giving up.",
        covers: [{ path: "src/retry.ts", hunks: [], lines: [] }],
        decisions: [{ choice: "Full jitter on the backoff.", rejected: "A fixed delay, which makes clients retry in lockstep." }],
        dependencies: [],
      },
      {
        id: "uploader",
        title: "Uploader uses the policy",
        summary: "The upload loop asks the policy after each failure.",
        explanation: "The loop sleeps for the delay the policy returns and stops when it says to give up.",
        covers: [{ path: "src/upload.ts", hunks: [1], lines: [] }],
        decisions: [],
        dependencies: [{ nodeId: "retry-policy", reason: "The loop only does what the policy decides." }],
      },
    ],
    supporting: [],
  };
}

/** `sampleGuide` as the panel shows it: laid out in layers, with every file of `sampleChangeRequest` placed. */
export function sampleLayeredGuide(): LayeredGuide {
  const guide = sampleGuide();
  return {
    ...guide,
    nodes: [
      { ...guide.nodes[0]!, layer: 0 },
      { ...guide.nodes[1]!, layer: 1 },
    ],
    unsorted: [],
  };
}

/** How an agent tends to answer: a sentence, then the JSON in a fence. */
export function sampleGuideReply(guide: unknown = sampleGuide()): string {
  return `Here is the guide.\n\n\`\`\`json\n${JSON.stringify(guide, null, 2)}\n\`\`\``;
}

export function fakeGuideAgents(): FakeGuideAgents {
  const find = (agentId: string) => {
    const agent = agents.created.find((candidate) => candidate.id === agentId);
    if (agent === undefined) throw new GuideAgentError(`No guide agent ${agentId}.`);
    return agent;
  };
  const settle = async (agent: FakeAgent) => {
    agent.status = "busy";
    const answer = await agents.answer(agent);
    agent.status = agents.archived.includes(agent.id) ? "gone" : "idle";
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const requireIdle = (agent: FakeAgent) => {
    if (agent.status !== "idle") throw new GuideAgentError(`The guide agent is ${agent.status}.`);
  };

  const agents: FakeGuideAgents = {
    created: [],
    archived: [],
    answer: () => "",
    failCreate: null,
    async create(input) {
      if (agents.failCreate) {
        const error = agents.failCreate;
        agents.failCreate = null;
        throw error;
      }
      const id = `agent-${agents.created.length + 1}`;
      agents.created.push({ ...structuredClone(input), id, sent: [], status: "busy" });
      return { id };
    },
    async reply(agentId) {
      return settle(find(agentId));
    },
    async run(agentId, text) {
      const agent = find(agentId);
      requireIdle(agent);
      agent.sent.push(text);
      return settle(agent);
    },
    async send(agentId, text) {
      const agent = find(agentId);
      requireIdle(agent);
      agent.sent.push(text);
    },
    async status(agentId) {
      return agents.created.find((agent) => agent.id === agentId)?.status ?? "gone";
    },
    async archive(agentId) {
      agents.archived.push(agentId);
      const agent = agents.created.find((candidate) => candidate.id === agentId);
      if (agent) agent.status = "gone";
    },
  };
  return agents;
}
