export type TerminalRecord = { id: string; name: string };

export type CreateTerminal = {
  workspaceId: string;
  name: string;
  cwd: string;
  command: string;
  args: string[];
};

export type TerminalPort = {
  list(workspaceId: string): Promise<TerminalRecord[]>;
  create(options: CreateTerminal): Promise<TerminalRecord>;
  /** The terminal's whole scrollback, one screen row per line. */
  capture(terminalId: string): Promise<string[]>;
  interrupt(terminalId: string): void;
  kill(terminalId: string): Promise<void>;
};
