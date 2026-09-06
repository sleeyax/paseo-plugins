import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentSideConnection,
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { writeLog } from "./log.ts";
import { questionText } from "./question-text.ts";
import {
  launchedAgent,
  notificationFailed,
  parseTaskNotifications,
  subagentProse,
  subagentToolLine,
  SubagentLog,
  type TaskNotification,
} from "./subagent-transcript.ts";
import type { TranscriptRecord } from "./transcript-reader.ts";

const IGNORED_RECORD_TYPES = new Set([
  "agent-name",
  "agent-setting",
  "ai-title",
  "atis-latch",
  "bridge-session",
  "custom-title",
  "file-history-delta",
  "file-history-snapshot",
  "last-prompt",
  "mode",
  "permission-mode",
  "pr-link",
  "queue-operation",
  "relocated",
  "summary",
  "worktree-state",
]);

const TOOL_KINDS: Record<string, ToolKind> = {
  Agent: "other",
  Bash: "execute",
  BashOutput: "execute",
  Edit: "edit",
  Glob: "search",
  Grep: "search",
  KillShell: "execute",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Task: "other",
  WebFetch: "fetch",
  WebSearch: "search",
  Write: "edit",
};

/** The tools that hand work to a subagent, whose own transcript is where that work then happens. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** The last step on the card of a subagent whose session stopped before it said how it went. */
const UNREPORTED_AGENT = "Claude stopped before this agent reported back.";

/**
 * A subagent and the tool call standing for it. Nested subagents share their spawner's card, so one
 * card holds one log and an update never replaces another agent's steps with its own.
 */
type SubagentCard = {
  agentId: string;
  toolCallId: string | null;
  log: SubagentLog;
  status: "in_progress" | "completed" | "failed";
  /** Launched to run on its own and not yet reported, which is what keeps the session's turn open. */
  outstanding: boolean;
  /** Given up on by a turn that waited its bound out, so no later turn waits on it again. */
  abandoned: boolean;
};

export class TranscriptTranslator {
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly connection: AgentSideConnection;
  private readonly emitted = new Set<string>();
  private readonly emittedTools = new Set<string>();
  private readonly unknownKinds = new Set<string>();
  private readonly agentCalls = new Set<string>();
  /** The tool calls Paseo is still showing as running, which is what a stopped session has to close. */
  private readonly openToolCalls = new Set<string>();
  private readonly subagents = new Map<string, SubagentCard>();
  private readonly subagentsByToolCall = new Map<string, string>();
  private lastSubagentActivity = 0;
  private lastAssistantActivity = 0;
  private lastActivity = 0;
  private trackingSubagents = false;
  private lastPlan = "";
  private lastUsage = "";
  private assistantChunkCount = 0;
  private suppressedAssistantText: string | null = null;

  constructor(sessionId: string, cwd: string, connection: AgentSideConnection) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.connection = connection;
  }

  get assistantChunks(): number {
    return this.assistantChunkCount;
  }

  /** When Claude itself last said, thought or ran anything, whichever kind of record it was. */
  get assistantActivityAt(): number {
    return this.lastAssistantActivity;
  }

  /**
   * When anything last happened in this session: Claude's own records, a subagent's, or a user turn
   * Claude was woken with. A replay of records already shown moves nothing, because every update is
   * deduplicated before it is sent, so this reads as the session's last real sign of life.
   */
  get activityAt(): number {
    return Math.max(this.lastActivity, this.lastAssistantActivity, this.lastSubagentActivity);
  }

  /**
   * Subagents that were launched to run on their own and have not reported. Nested subagents share
   * their spawner's card, so they are counted once, as the one piece of work the session launched.
   */
  get runningSubagents(): number {
    return new Set([...this.subagents.values()].filter((card) => card.outstanding)).size;
  }

  /** When any subagent last did anything, which is all there is to say whether one is still alive. */
  get subagentActivityAt(): number {
    return this.lastSubagentActivity;
  }

  /**
   * Stops counting the agents a turn has given up waiting on. Their cards keep saying they are
   * working, which is still true — nothing has reported — and they are closed when the process is.
   * Without this every later turn holds for a poll interval and gives up again in the same breath.
   */
  abandonRunningSubagents(): void {
    for (const card of this.subagents.values()) {
      if (!card.outstanding) continue;
      card.outstanding = false;
      card.abandoned = true;
    }
  }

  /** An agent that has reported writes nothing more, so its transcript stops being worth reading. */
  subagentSettled(agentId: string): boolean {
    const card = this.subagents.get(agentId);
    return card !== undefined && card.status !== "in_progress";
  }

  /**
   * Called as a prompt starts. Loading a persisted session replays its whole transcript first, and
   * an agent launched in a session that has since been closed left its launch behind without the
   * notification that would have ended it: history says it is running when nothing is.
   */
  trackRunningSubagents(): void {
    this.trackingSubagents = true;
  }

  suppressNextAssistantText(text: string): void {
    this.suppressedAssistantText = text.trim() || null;
  }

  async translate(records: TranscriptRecord[]): Promise<void> {
    for (const record of records) await this.translateRecord(record);
  }

  private async translateRecord(record: TranscriptRecord): Promise<void> {
    const type = stringValue(record.type);
    switch (type) {
      case "user":
        await this.translateUser(record);
        return;
      case "assistant":
        await this.translateAssistant(record);
        return;
      case "system":
        await this.translateSystem(record);
        return;
      case "attachment":
        await this.translateAttachment(record);
        return;
      default:
        if (type && !IGNORED_RECORD_TYPES.has(type)) this.reportUnknown(type);
    }
  }

  private async translateUser(record: TranscriptRecord): Promise<void> {
    const message = objectValue(record.message);
    const content = message?.content;
    const recordId = stringValue(record.uuid) || stableUuid(JSON.stringify(record));
    if (record.isMeta !== true && record.isSidechain !== true) this.suppressedAssistantText = null;
    await this.translateNotifications(content, recordId);
    if (typeof content === "string") {
      await this.emitUserText(`${recordId}:text`, recordId, content, record);
      return;
    }
    if (!Array.isArray(content)) return;
    for (let index = 0; index < content.length; index += 1) {
      const block = objectValue(content[index]);
      if (!block) continue;
      const key = `${recordId}:${index}:${String(block.type)}`;
      if (block.type === "text") await this.emitUserText(key, recordId, stringValue(block.text) || "", record);
      if (block.type === "image") await this.emitContent("user_message_chunk", key, recordId, imageContent(block));
      if (block.type === "tool_result") await this.translateToolResult(block, record);
    }
  }

  private async emitUserText(key: string, recordId: string, rawText: string, record: TranscriptRecord): Promise<void> {
    if (record.isMeta === true || record.isSidechain === true) return;
    const text = cleanUserText(rawText);
    if (text) await this.emitContent("user_message_chunk", key, recordId, { type: "text", text });
  }

  private async translateAssistant(record: TranscriptRecord): Promise<void> {
    const message = objectValue(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) return;
    const recordId = stringValue(record.uuid) || stableUuid(JSON.stringify(record));
    const messageId = stringValue(record.requestId) || recordId;
    for (let index = 0; index < content.length; index += 1) {
      const block = objectValue(content[index]);
      if (!block) continue;
      const key = `${recordId}:${index}:${String(block.type)}`;
      switch (block.type) {
        case "text": {
          const text = stringValue(block.text)?.trim();
          if (text && text === this.suppressedAssistantText) {
            this.suppressedAssistantText = null;
            this.emitted.add(key);
          } else if (text) {
            await this.emitContent("agent_message_chunk", key, messageId, { type: "text", text });
          }
          break;
        }
        case "thinking": {
          const text = stringValue(block.thinking)?.trim();
          if (text) await this.emitContent("agent_thought_chunk", key, messageId, { type: "text", text });
          break;
        }
        case "tool_use":
          await this.translateToolUse(block);
          break;
        case "image":
          await this.emitContent("agent_message_chunk", key, messageId, imageContent(block));
          break;
        default:
          this.reportUnknown(`assistant:${String(block.type)}`);
      }
    }
    await this.translateUsage(record, message);
  }

  private async translateToolUse(block: TranscriptRecord): Promise<void> {
    const toolCallId = stringValue(block.id);
    const name = stringValue(block.name) || "Tool";
    const input = objectValue(block.input) || {};
    if (!toolCallId) {
      this.reportUnknown(`tool:${name}:missing-id`);
      return;
    }
    if (name === "TodoWrite") {
      await this.translatePlan(input.todos);
      return;
    }
    if (AGENT_TOOLS.has(name)) this.agentCalls.add(toolCallId);
    if (this.emittedTools.has(toolCallId)) return;
    this.emittedTools.add(toolCallId);
    this.openToolCalls.add(toolCallId);
    this.lastAssistantActivity = Date.now();
    const locations = toolLocations(input, this.cwd);
    const content = toolContents(name, input, this.cwd);
    await this.send({
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolTitle(name, input),
      kind: TOOL_KINDS[name] || "other",
      status: "in_progress",
      rawInput: input,
      ...(locations.length > 0 ? { locations } : {}),
      ...(content.length > 0 ? { content } : {}),
    });
  }

  private async translateToolResult(block: TranscriptRecord, record: TranscriptRecord): Promise<void> {
    const toolCallId = stringValue(block.tool_use_id);
    if (!toolCallId || !this.emittedTools.has(toolCallId)) return;
    const launch = this.agentCalls.has(toolCallId) ? launchedAgent(record.toolUseResult) : null;
    if (launch !== null) {
      await this.linkSubagent(launch.agentId, toolCallId, launch.running);
      // An asynchronous agent answers the moment it starts, so closing the card here would report a
      // minutes-long agent as finished before it had done anything. It is closed by its notification.
      if (launch.running) return;
      // A synchronous one has already finished, and the result below is its report. Its card is
      // settled on that, or a session stopping later would rewrite the report as a failure.
      this.settleSubagentCard(launch.agentId, block.is_error === true);
    }
    const resultKey = `${toolCallId}:result:${createHash("sha256").update(JSON.stringify(block)).digest("hex")}`;
    if (this.emitted.has(resultKey)) return;
    this.emitted.add(resultKey);
    // A result is Claude's tool finishing, which is as much its own progress as calling it was.
    this.lastAssistantActivity = Date.now();
    const content = resultContent(block.content);
    this.openToolCalls.delete(toolCallId);
    await this.send({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: block.is_error === true ? "failed" : "completed",
      rawOutput: block.content,
      ...(content.length > 0 ? { content } : {}),
    });
  }

  /**
   * The end of an asynchronous agent is reported in the next user turn and nowhere else, and the
   * text carrying it is scrubbed before the user sees it, so it is read here on the way past.
   */
  private async translateNotifications(content: unknown, recordId: string): Promise<void> {
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((value) => {
              const block = objectValue(value);
              const text = block?.type === "text" ? stringValue(block.text) : null;
              return text ? [text] : [];
            })
          : [];
    for (const text of texts) {
      for (const notification of parseTaskNotifications(text)) await this.applyNotification(notification, recordId);
    }
  }

  /**
   * A notification for a background command rather than an agent names no card here, and is left
   * alone. One for an agent whose launch is no longer in the transcript has no tool call to close,
   * but still says the agent has stopped, which is what lets its transcript stop being followed.
   */
  private async applyNotification(notification: TaskNotification, recordId: string): Promise<void> {
    const agentId =
      notification.agentId ??
      (notification.toolCallId === null ? null : this.subagentsByToolCall.get(notification.toolCallId) ?? null);
    const card = agentId === null ? undefined : this.subagents.get(agentId);
    if (card === undefined) return;
    const key = `${card.agentId}:notification:${recordId}`;
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    card.status = notificationFailed(notification.status) ? "failed" : "completed";
    card.outstanding = false;
    this.lastSubagentActivity = Date.now();
    card.log.append(notification.summary ?? `Agent ${notification.status ?? "finished"}`);
    await this.publishSubagent(card);
  }

  /**
   * The steps a subagent took, streamed onto the tool call that launched it. They are never sent as
   * message chunks: a turn is judged finished by counting those, and a subagent still working after
   * its launcher has answered would keep the session's turn open for as long as it ran.
   */
  async translateSubagent(agentId: string, records: TranscriptRecord[]): Promise<void> {
    const card = this.subagentCard(agentId);
    // A nested subagent shares its spawner's card, so its steps are marked as its own.
    const prefix = card.agentId === agentId ? "" : "\u21b3 ";
    let appended = false;
    for (const record of records) appended = this.logSubagentRecord(card, record, prefix) || appended;
    if (!appended) return;
    this.lastSubagentActivity = Date.now();
    await this.publishSubagent(card);
  }

  private logSubagentRecord(card: SubagentCard, record: TranscriptRecord, prefix: string): boolean {
    const nested = launchedAgent(record.toolUseResult);
    if (nested !== null) this.adoptSubagent(nested.agentId, card);
    const message = objectValue(record.message);
    const content = message?.content;
    if (stringValue(record.type) !== "assistant" || !Array.isArray(content)) return false;
    let appended = false;
    for (const value of content) {
      const block = objectValue(value);
      if (!block) continue;
      if (block.type === "text") {
        const text = subagentProse(stringValue(block.text) ?? "", this.cwd);
        if (text) {
          card.log.append(`${prefix}${text}`);
          appended = true;
        }
      }
      if (block.type === "tool_use") {
        const name = stringValue(block.name) || "Tool";
        card.log.append(`${prefix}• ${subagentToolLine(name, objectValue(block.input) || {}, this.cwd)}`);
        appended = true;
      }
    }
    return appended;
  }

  /**
   * Moves a subagent onto the card of the agent that launched it. Its transcript is often read
   * before the record naming it as nested, so whatever it has already logged is carried across
   * rather than left on a card of its own that nothing will ever show.
   */
  private adoptSubagent(agentId: string, card: SubagentCard): void {
    const existing = this.subagents.get(agentId);
    if (existing === card || (existing !== undefined && existing.toolCallId !== null)) return;
    for (const step of existing?.log.steps() ?? []) card.log.append(step.startsWith("↳") ? step : `↳ ${step}`);
    this.subagents.set(agentId, card);
  }

  private async linkSubagent(agentId: string, toolCallId: string, running: boolean): Promise<void> {
    const card = this.subagentCard(agentId);
    // A compaction rewrites the transcript, and the re-read that follows replays the launch of an
    // agent that has since reported, or that a turn gave up waiting on. Neither is waited on again.
    card.outstanding = running && this.trackingSubagents && card.status === "in_progress" && !card.abandoned;
    this.lastSubagentActivity = Date.now();
    if (card.toolCallId === toolCallId) return;
    card.toolCallId = toolCallId;
    this.subagentsByToolCall.set(toolCallId, agentId);
    await this.publishSubagent(card);
  }

  /** Records how an agent went, on the card that has to go on saying so after Claude has stopped. */
  private settleSubagentCard(agentId: string, failed: boolean): void {
    const card = this.subagents.get(agentId);
    if (card === undefined || card.status !== "in_progress") return;
    card.status = failed ? "failed" : "completed";
    card.outstanding = false;
  }

  private subagentCard(agentId: string): SubagentCard {
    const existing = this.subagents.get(agentId);
    if (existing) return existing;
    const card: SubagentCard = {
      agentId,
      toolCallId: null,
      log: new SubagentLog(),
      status: "in_progress",
      outstanding: false,
      abandoned: false,
    };
    this.subagents.set(agentId, card);
    return card;
  }

  /**
   * Closes every tool call that is still shown as running. What closes one is written by the Claude
   * process that ran it — a result, or the notification that reports an asynchronous agent — so once
   * that process has stopped nothing is coming, and a card left open goes on saying it is working.
   */
  async settleOpenToolCalls(): Promise<void> {
    for (const card of new Set(this.subagents.values())) {
      if (card.status !== "in_progress") continue;
      card.status = "failed";
      card.outstanding = false;
      // An agent with no tool call has nothing to show the last step on, and is only marked so that its transcript is let go of.
      if (card.toolCallId === null) continue;
      card.log.append(UNREPORTED_AGENT);
      await this.publishSubagent(card);
    }
    for (const toolCallId of [...this.openToolCalls]) {
      this.openToolCalls.delete(toolCallId);
      await this.send({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
    }
  }

  /** A tool call's content is replaced rather than added to, so the whole tail goes out each time. */
  private async publishSubagent(card: SubagentCard): Promise<void> {
    if (card.toolCallId === null) return;
    if (card.status !== "in_progress") this.openToolCalls.delete(card.toolCallId);
    const text = card.log.empty ? "Started; waiting for its first step." : card.log.text();
    await this.send({
      sessionUpdate: "tool_call_update",
      toolCallId: card.toolCallId,
      status: card.status,
      content: [{ type: "content", content: { type: "text", text } }],
    });
  }

  private async translatePlan(value: unknown): Promise<void> {
    if (!Array.isArray(value)) return;
    const entries: PlanEntry[] = [];
    for (const todo of value) {
      const item = objectValue(todo);
      const content = stringValue(item?.content);
      if (!item || !content) continue;
      const status = item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
      entries.push({ content, priority: "medium", status });
    }
    const signature = JSON.stringify(entries);
    if (signature === this.lastPlan) return;
    this.lastPlan = signature;
    await this.send({ sessionUpdate: "plan", entries });
  }

  private async translateUsage(record: TranscriptRecord, message: TranscriptRecord | null): Promise<void> {
    const usage = objectValue(message?.usage) || objectValue(record.usage);
    if (!usage) return;
    const size = firstNumber(record.contextWindow, record.context_window, usage.contextWindow, usage.context_window);
    const input = firstNumber(usage.input_tokens, usage.inputTokens) || 0;
    const cacheRead = firstNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens) || 0;
    const cacheWrite = firstNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens) || 0;
    const used = firstNumber(record.contextUsed, record.context_used, usage.contextUsed, usage.context_used) ?? input + cacheRead + cacheWrite;
    if (size === null || size <= 0 || used < 0) return;
    const update = { sessionUpdate: "usage_update" as const, size, used: Math.min(used, size) };
    const signature = JSON.stringify(update);
    if (signature === this.lastUsage) return;
    this.lastUsage = signature;
    await this.send(update);
  }

  private async translateSystem(record: TranscriptRecord): Promise<void> {
    const content = stringValue(record.content)?.trim();
    const subtype = stringValue(record.subtype);
    if (!content || subtype === "turn_duration") return;
    const key = `${stringValue(record.uuid) || stableUuid(JSON.stringify(record))}:system`;
    await this.emitContent("agent_message_chunk", key, key, { type: "text", text: content });
  }

  private async translateAttachment(record: TranscriptRecord): Promise<void> {
    const attachment = objectValue(record.attachment);
    const type = stringValue(attachment?.type);
    if (!attachment || !type) return;
    if (type === "hook_system_message" || type === "hook_non_blocking_error" || type === "hook_cancelled") {
      const text = stringValue(attachment.content) || stringValue(attachment.stderr) || `${stringValue(attachment.hookName) || "Hook"} ${type.replace("hook_", "")}`;
      const key = `${stringValue(record.uuid) || stableUuid(JSON.stringify(record))}:attachment`;
      await this.emitContent("agent_message_chunk", key, key, { type: "text", text });
    }
  }

  private async emitContent(
    sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
    key: string,
    sourceMessageId: string,
    content: ContentBlock | null,
  ): Promise<void> {
    if (!content || this.emitted.has(key)) return;
    this.emitted.add(key);
    if (sessionUpdate === "agent_message_chunk") this.assistantChunkCount += 1;
    if (sessionUpdate !== "user_message_chunk") this.lastAssistantActivity = Date.now();
    await this.send({ sessionUpdate, messageId: stableUuid(sourceMessageId), content });
  }

  private async send(update: SessionUpdate): Promise<void> {
    this.lastActivity = Date.now();
    await this.connection.sessionUpdate({ sessionId: this.sessionId, update });
  }

  private reportUnknown(kind: string): void {
    if (this.unknownKinds.has(kind)) return;
    this.unknownKinds.add(kind);
    writeLog({ level: "warn", message: "Unknown Claude transcript kind", sessionId: this.sessionId, kind });
  }
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function objectValue(value: unknown): TranscriptRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TranscriptRecord) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function cleanUserText(text: string): string {
  return text
    .replace(/<(system-reminder|task-notification|user-prompt-submit-hook|local-command-stdout|local-command-stderr|command-message)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

function imageContent(block: TranscriptRecord): ContentBlock | null {
  const source = objectValue(block.source);
  const data = stringValue(source?.data);
  if (!data) return null;
  return { type: "image", data, mimeType: stringValue(source?.media_type) || "image/png" };
}

function toolTitle(name: string, input: TranscriptRecord): string {
  const detail = stringValue(input.description) || stringValue(input.file_path) || stringValue(input.query) || stringValue(input.pattern) || stringValue(input.command)?.split("\n")[0];
  return detail ? `${name}: ${detail}` : name;
}

function toolLocations(input: TranscriptRecord, cwd: string): ToolCallLocation[] {
  const filePath = stringValue(input.file_path) || stringValue(input.path);
  if (!filePath) return [];
  return [{ path: path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath), ...(typeof input.offset === "number" ? { line: input.offset } : {}) }];
}

function toolContents(name: string, input: TranscriptRecord, cwd: string): ToolCallContent[] {
  if (name === "AskUserQuestion" && Array.isArray(input.questions)) {
    const questions = input.questions.flatMap((value) => {
      const question = objectValue(value);
      const text = stringValue(question?.question)?.trim();
      return question && text ? [questionText(question, text)] : [];
    });
    if (questions.length > 0) return [{ type: "content", content: { type: "text", text: questions.join("\n\n") } }];
  }
  const filePath = stringValue(input.file_path) || stringValue(input.notebook_path);
  const resolvedPath = filePath ? (path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)) : null;
  if ((name === "Edit" || name === "NotebookEdit") && resolvedPath) {
    return [{ type: "diff", path: resolvedPath, oldText: stringValue(input.old_string), newText: stringValue(input.new_string) || "" }];
  }
  if (name === "MultiEdit" && resolvedPath && Array.isArray(input.edits)) {
    return input.edits.flatMap((value) => {
      const edit = objectValue(value);
      return edit ? [{ type: "diff" as const, path: resolvedPath, oldText: stringValue(edit.old_string), newText: stringValue(edit.new_string) || "" }] : [];
    });
  }
  if (name === "Write" && resolvedPath) return [{ type: "diff", path: resolvedPath, newText: stringValue(input.content) || "" }];
  const command = stringValue(input.command);
  return command ? [{ type: "content", content: { type: "text", text: command } }] : [];
}

function resultContent(value: unknown): ToolCallContent[] {
  const blocks = Array.isArray(value) ? value : typeof value === "string" ? [{ type: "text", text: value }] : [];
  const content: ToolCallContent[] = [];
  for (const blockValue of blocks) {
    const block = objectValue(blockValue);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") content.push({ type: "content", content: { type: "text", text: block.text } });
    if (block.type === "image") {
      const image = imageContent(block);
      if (image) content.push({ type: "content", content: image });
    }
  }
  return content;
}
