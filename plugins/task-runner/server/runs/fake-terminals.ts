import type { CreateTerminal, TerminalPort, TerminalRecord } from "./terminal-port.ts";

type FakeTerminal = TerminalRecord & { workspaceId: string; cwd: string; command: string; args: string[]; lines: string[] };

export function createFakeTerminals() {
  const terminals: FakeTerminal[] = [];
  const interrupted: string[] = [];
  let nextId = 1;

  const port: TerminalPort = {
    async list(workspaceId) {
      return terminals.filter((terminal) => terminal.workspaceId === workspaceId).map(({ id, name }) => ({ id, name }));
    },
    async create(options: CreateTerminal) {
      const terminal = { ...options, id: `terminal-${nextId++}`, lines: [] };
      terminals.push(terminal);
      return { id: terminal.id, name: terminal.name };
    },
    async capture(terminalId) {
      const terminal = terminals.find((candidate) => candidate.id === terminalId);
      if (terminal === undefined) throw new Error("Terminal is gone.");
      return terminal.lines;
    },
    interrupt(terminalId) {
      interrupted.push(terminalId);
    },
    async kill(terminalId) {
      const index = terminals.findIndex((terminal) => terminal.id === terminalId);
      if (index !== -1) terminals.splice(index, 1);
    },
  };

  return { port, terminals, interrupted };
}
