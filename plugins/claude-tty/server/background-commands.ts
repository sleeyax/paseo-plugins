import { open } from "node:fs/promises";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { SubagentReader } from "./subsessions.ts";

/** Mirrors the adapter's own `BACKGROUND_COMMAND_META`; the plugin runs in the daemon and cannot import it. */
export const BACKGROUND_COMMAND_META = "claudeTty/backgroundCommand";

/** A subsession is where a command's output is read at length, so it keeps far more of it than the card does. */
const TAIL_BYTES = 64_000;

export const COMMAND_FAILED = "The command failed or was stopped.";

/** A command Claude runs in the background, as the card in the session's conversation describes it. */
export type BackgroundCommand = {
  taskId: string;
  outputFile: string | null;
  command: string;
  description: string | null;
};

/** The task and output file the adapter puts on a background command's card, or null for any other card. */
export function parseBackgroundCommandMeta(meta: unknown): { taskId: string; outputFile: string | null } | null {
  const value = asRecord(asRecord(meta)?.[BACKGROUND_COMMAND_META]);
  const taskId = value?.taskId;
  if (typeof taskId !== "string" || taskId === "") return null;
  return { taskId, outputFile: typeof value?.outputFile === "string" ? value.outputFile : null };
}

/** Follows one background command's output file as a single shell call that runs until the command's card closes. */
export class BackgroundCommandOutput implements SubagentReader {
  private readonly command: BackgroundCommand;
  private output: string | null = null;
  private announced = false;

  constructor(command: BackgroundCommand) {
    this.command = command;
  }

  async read(): Promise<ProviderTimelineItem[]> {
    const output = this.command.outputFile === null ? null : await readOutputTail(this.command.outputFile, TAIL_BYTES);
    if (this.announced && output === this.output) return [];
    this.announced = true;
    this.output = output;
    return [this.item("running")];
  }

  settle(ended?: "completed" | "failed"): ProviderTimelineItem[] {
    return [this.item(ended ?? "canceled")];
  }

  private item(status: "running" | "completed" | "failed" | "canceled"): ProviderTimelineItem {
    return {
      id: this.command.taskId,
      type: "tool_call",
      callId: this.command.taskId,
      name: "Bash",
      detail: { type: "shell", command: this.command.command, ...(this.output === null ? {} : { output: this.output }) },
      ...(status === "failed" ? { status, error: COMMAND_FAILED } : { status, error: null }),
    };
  }
}

/**
 * The end of what a command has written so far, as plain text, or null while there is no file.
 * Claude writes the command's raw terminal output there, so colours are dropped and a line redrawn in place by a carriage return keeps only its last drawing.
 */
export async function readOutputTail(file: string, bytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // A tail starts wherever the byte count fell, which may be mid-line or mid-character.
    // A tail that is all one line keeps its broken start, since dropping it would leave nothing.
    if (length < size) {
      const firstBreak = text.trimEnd().indexOf("\n");
      text = `…${firstBreak === -1 ? text : text.slice(firstBreak + 1)}`;
    }
    return plainText(text);
  } finally {
    await handle.close();
  }
}

function plainText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .join("\n")
    .trimEnd();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
