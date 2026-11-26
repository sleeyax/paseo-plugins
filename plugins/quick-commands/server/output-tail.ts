// CSI sequences (colours, cursor moves), OSC sequences (titles, links) and the remaining two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Keeps the last `limit` lines of a process's output as a terminal would show them. */
export class OutputTail {
  readonly #limit: number;
  #lines: string[] = [];
  #current = "";

  constructor(limit: number, initial: readonly string[] = []) {
    this.#limit = limit;
    this.#lines = initial.slice(-limit);
  }

  push(chunk: string): void {
    const text = chunk.replace(ANSI, "").replace(/\r\n/g, "\n");
    for (const [index, part] of text.split("\n").entries()) {
      if (index > 0) this.#endLine();
      // A lone carriage return redraws the line, as progress bars do: only what follows the last one is left.
      const redrawn = part.lastIndexOf("\r");
      this.#current = redrawn === -1 ? this.#current + part : part.slice(redrawn + 1);
    }
  }

  lines(): string[] {
    const lines = this.#current === "" ? this.#lines : [...this.#lines, this.#current];
    return lines.slice(-this.#limit);
  }

  #endLine(): void {
    this.#lines.push(this.#current);
    this.#current = "";
    if (this.#lines.length > this.#limit) this.#lines.splice(0, this.#lines.length - this.#limit);
  }
}
