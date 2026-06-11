/**
 * 会话持久化（双模式：JSONL 事件溯源 + 旧 JSON 兼容）
 *
 * 新会话使用 JSONL 追加写入（崩溃安全、增量写入）
 * 旧会话仍可从 JSON 格式加载（向后兼容）
 */

import type { Message } from "../llm/types.ts";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";

/** 当前会话数据格式版本 */
const CURRENT_VERSION = "2.0";

/** JSONL 记录类型 */
type SessionRecord =
  | { type: "session_start"; sessionId: string; model: string; provider: string; cwd: string; timestamp: string }
  | { type: "user_message"; message: Message; timestamp: string }
  | { type: "assistant_message"; message: Message; timestamp: string }
  | { type: "tool_result"; message: Message; timestamp: string }
  | { type: "context_compact"; summary: string; removedCount: number; timestamp: string }
  | { type: "metadata"; key: string; value: unknown; timestamp: string }
  | { type: "session_end"; totalCostUSD: number; totalMessages: number; timestamp: string };

/** 会话数据（兼容旧格式） */
export interface SessionData {
  version: string;
  id: string;
  model: string;
  provider: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  kind?: "main" | "subagent";
  projectHash?: string;
  directories?: string[];
  summary?: string;
}

/** 会话摘要数据 */
export interface SessionSummary {
  sessionId: string;
  summary: string;
  model: string;
  provider: string;
  createdAt: string;
  messageCount: number;
  estimatedTokens: number;
}

export class SessionStore {
  private sessionDir: string;
  private summaryDir: string;
  private currentFile: string | null = null;

  constructor() {
    this.sessionDir = sidPaths.sessions();
    this.summaryDir = join(this.sessionDir, "summaries");
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
    if (!existsSync(this.summaryDir)) {
      mkdirSync(this.summaryDir, { recursive: true });
    }
  }

  /** 开始新会话（JSONL 模式） */
  startSession(sessionId: string, model: string, provider: string, cwd: string): void {
    this.currentFile = join(this.sessionDir, `${sessionId}.jsonl`);
    this.appendRecord({
      type: "session_start",
      sessionId,
      model,
      provider,
      cwd,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 续写已有会话（B6：resume 场景）。
   *
   * 与 startSession 的区别：把 currentFile 指向**已存在**的旧 jsonl，且**不写 session_start**。
   * 这样 `-c` / `--resume` 恢复的会话，后续新消息会续写进原文件，而非另开新文件导致历史碎片化。
   * 若旧文件不存在（极端情况，如手动删了 jsonl），回退为新建会话以免丢失后续写入。
   */
  resumeSession(sessionId: string, model: string, provider: string, cwd: string): void {
    const jsonlPath = join(this.sessionDir, `${sessionId}.jsonl`);
    if (existsSync(jsonlPath)) {
      this.currentFile = jsonlPath;
      getLogger().info("SESSION", `会话续写已就绪（resume）: ${sessionId}`);
    } else {
      // 旧 jsonl 不存在（可能是从旧 JSON 格式恢复的会话）→ 新建 jsonl 续写
      getLogger().info("SESSION", `resume 会话无 jsonl，新建续写文件: ${sessionId}`);
      this.startSession(sessionId, model, provider, cwd);
    }
  }

  /** 追加消息（增量写入） */
  appendMessage(message: Message): void {
    if (!this.currentFile) return;
    const type = message.role === "user" ? "user_message"
      : message.role === "assistant" ? "assistant_message"
      : "tool_result";
    this.appendRecord({ type, message, timestamp: new Date().toISOString() } as SessionRecord);
  }

  /** 记录上下文压缩事件 */
  appendCompact(summary: string, removedCount: number): void {
    if (!this.currentFile) return;
    this.appendRecord({
      type: "context_compact",
      summary,
      removedCount,
      timestamp: new Date().toISOString(),
    });
  }

  /** 记录元数据变更 */
  appendMetadata(key: string, value: unknown): void {
    if (!this.currentFile) return;
    this.appendRecord({ type: "metadata", key, value, timestamp: new Date().toISOString() });
  }

  /** 结束会话 */
  endSession(totalCostUSD: number, totalMessages: number): void {
    if (!this.currentFile) return;
    this.appendRecord({
      type: "session_end",
      totalCostUSD,
      totalMessages,
      timestamp: new Date().toISOString(),
    });
    this.currentFile = null;
  }

  /** 保存会话（兼容旧接口，内部转为 JSONL 追加） */
  async save(session: SessionData): Promise<void> {
    const log = getLogger();
    session.version = CURRENT_VERSION;
    session.updatedAt = new Date().toISOString();

    // 如果已有 JSONL 文件在写入，跳过（消息已通过 appendMessage 增量写入）
    if (this.currentFile && existsSync(this.currentFile)) {
      log.debug("SESSION", `会话增量保存中: ${session.id}`);
      return;
    }

    // 回退到 JSON 全量保存（兼容未启动 JSONL 的场景）
    const filePath = join(this.sessionDir, `${session.id}.json`);
    await Bun.write(filePath, JSON.stringify(session, null, 2));
    const fileSize = statSync(filePath).size;
    const sizeStr = fileSize > 1024 * 1024
      ? `${(fileSize / 1024 / 1024).toFixed(1)}MB`
      : `${(fileSize / 1024).toFixed(1)}KB`;
    log.info("SESSION", `会话已保存: ${session.id} (${session.messages.length}条消息, ${sizeStr})`);
  }

  /** 加载会话（优先 JSONL，回退 JSON） */
  async load(id: string): Promise<SessionData | null> {
    const log = getLogger();

    // 优先尝试 JSONL 格式
    const jsonlPath = join(this.sessionDir, `${id}.jsonl`);
    if (existsSync(jsonlPath)) {
      const result = await this.loadFromJsonl(jsonlPath);
      if (result) {
        log.info("SESSION", `会话已加载(JSONL): ${id} (${result.messages.length}条消息)`);
        return result;
      }
    }

    // 回退到旧 JSON 格式
    const jsonPath = join(this.sessionDir, `${id}.json`);
    if (!existsSync(jsonPath)) return null;

    try {
      const content = await Bun.file(jsonPath).text();
      const data = JSON.parse(content) as SessionData;
      if (!data.version) data.version = "0.0";
      log.info("SESSION", `会话已加载(JSON): ${id} (${data.messages.length}条消息)`);
      return data;
    } catch {
      return null;
    }
  }

  /** 获取最近一次会话 */
  async loadLatest(): Promise<SessionData | null> {
    if (!existsSync(this.sessionDir)) return null;

    const files = readdirSync(this.sessionDir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        path: join(this.sessionDir, f),
        mtime: statSync(join(this.sessionDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    const latest = files[0].name;
    const id = latest.replace(/\.(json|jsonl)$/, "");
    return this.load(id);
  }

  /** 列出所有会话 */
  async list(): Promise<{ id: string; updatedAt: string; messageCount: number }[]> {
    if (!existsSync(this.sessionDir)) return [];

    const files = readdirSync(this.sessionDir).filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"));
    const sessions: { id: string; updatedAt: string; messageCount: number }[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const id = file.replace(/\.(json|jsonl)$/, "");
      if (seen.has(id)) continue;
      seen.add(id);

      try {
        const data = await this.load(id);
        if (data?.id && data.updatedAt && data.messages) {
          sessions.push({
            id: data.id,
            updatedAt: data.updatedAt,
            messageCount: data.messages.length,
          });
        }
      } catch {
        // 跳过损坏的会话文件
      }
    }

    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 保存会话摘要 */
  async saveSummary(summary: SessionSummary): Promise<void> {
    const filePath = join(this.summaryDir, `${summary.sessionId}.json`);
    await Bun.write(filePath, JSON.stringify(summary, null, 2));
  }

  /** 加载会话摘要 */
  async loadSummary(sessionId: string): Promise<SessionSummary | null> {
    const filePath = join(this.summaryDir, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;

    try {
      const content = await Bun.file(filePath).text();
      return JSON.parse(content) as SessionSummary;
    } catch {
      return null;
    }
  }

  /** 构建恢复消息 */
  static buildResumeMessage(summary: string): string {
    return `本次会话是从之前的对话中恢复的，之前的对话因上下文窗口限制而中断。
以下是之前对话的摘要：

${summary}

请从上次中断的地方继续，无需再次询问。`;
  }

  /** 生成新的会话 ID */
  static generateId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  /** 从 JSONL 文件恢复会话 */
  private async loadFromJsonl(filePath: string): Promise<SessionData | null> {
    const content = await Bun.file(filePath).text();
    const lines = content.trim().split("\n").filter(Boolean);

    const messages: Message[] = [];
    const metadata: Record<string, unknown> = {};
    let sessionId = "";
    let model = "";
    let provider = "";
    let createdAt = "";
    let updatedAt = "";

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as SessionRecord;
        switch (record.type) {
          case "session_start":
            sessionId = record.sessionId;
            model = record.model;
            provider = record.provider;
            createdAt = record.timestamp;
            updatedAt = record.timestamp;
            break;
          case "user_message":
          case "assistant_message":
          case "tool_result":
            messages.push(record.message);
            updatedAt = record.timestamp;
            break;
          case "metadata":
            metadata[record.key] = record.value;
            updatedAt = record.timestamp;
            break;
          case "context_compact":
            // B2 方案A：compact 记录退化为纯标记，**不再清空 messages**。
            // 旧实现 `messages.length = 0` + 只塞一条 `[上下文摘要]` 占位，会导致 resume 时
            // 历史被清空（bug②）。压缩效果本就已反映在后续写入的真实消息流里——
            // sid-code 的压缩多为截断/管道压缩而非 LLM 摘要，未必有可用摘要文本，
            // 保留真实消息流是最忠实、无损的恢复方式。
            updatedAt = record.timestamp;
            break;
          case "session_end":
            updatedAt = record.timestamp;
            break;
        }
      } catch {
        continue;
      }
    }

    if (!sessionId) return null;

    return {
      version: CURRENT_VERSION,
      id: sessionId,
      model,
      provider,
      messages,
      createdAt,
      updatedAt,
      summary: metadata["summary"] as string | undefined,
    };
  }

  /** 追加一条 JSONL 记录 */
  private appendRecord(record: SessionRecord): void {
    if (!this.currentFile) return;
    appendFileSync(this.currentFile, JSON.stringify(record) + "\n");
  }
}
