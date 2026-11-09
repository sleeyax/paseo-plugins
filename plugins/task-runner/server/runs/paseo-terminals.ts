import type { PaseoApi } from "@getpaseo/client";
import type { TerminalPort } from "./terminal-port.ts";

export function createPaseoTerminals(paseo: () => PaseoApi): TerminalPort {
  return {
    async list(workspaceId) {
      return (await paseo().terminals.list({ workspaceId })).entries.map(({ id, name }) => ({ id, name }));
    },
    async create(options) {
      const terminal = await paseo().terminals.create(options);
      return { id: terminal.id, name: options.name };
    },
    async capture(terminalId) {
      return (await paseo().terminals.ref(terminalId).capture({ start: 0 })).lines;
    },
    interrupt(terminalId) {
      paseo().terminals.ref(terminalId).sendKeys(["C-c"]);
    },
    async kill(terminalId) {
      await paseo().terminals.ref(terminalId).kill();
    },
  };
}
