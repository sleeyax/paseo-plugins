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
