/**
 * 轨迹文件写入器
 * 负责本地文件的创建、追加写入和目录管理。
 * 输出三个文件：session.traj / raw.jsonl / events.jsonl
 *
 * 设计原则：
 * - 所有写入操作 try-catch，失败时仅记录警告不抛异常（采集不影响正常使用）
 * - session.traj 使用原子覆盖写入（每次 AfterModel 后重建）
 * - raw.jsonl / events.jsonl 使用追加写入（崩溃安全）
 */

import { join } from "node:path";
import { mkdirSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { getLogger } from "../debug/logger.ts";

/** hook 事件记录（写入 events.jsonl 的行格式） */
export interface HookEvent {
  /** 事件名称 */
  event: string;
  /** 会话 ID */
  session_id: string;
  /** 时间戳 */
  timestamp: string;
  /** 工作目录 */
  cwd?: string;
  /** 事件附加数据 */
  data?: Record<string, unknown>;
}

/** raw.jsonl 中的请求/响应对（对齐 claude-trace proxy.py 的 _append_raw_jsonl） */
export interface RawJsonlEntry {
  /** 时间戳 */
  timestamp: string;
  /** 序号（从 1 开始） */
  index: number;
  /** 模型名称 */
  model: string;
  /** 请求侧数据 */
  request: {
    model: string;
    /** system prompt（仅首行有值） */
    system?: unknown;
    /** 完整 messages（仅首行有值） */
    messages?: unknown[];
    /** 工具定义列表（仅首行有值） */
    tools?: unknown[];
    /** 增量 messages（非首行使用） */
    new_messages?: unknown[];
    /** 完整 messages 数量（非首行时记录，便于调试） */
    _messages_count?: number;
  };
  /** 响应侧数据 */
  response: {
    content: unknown[];
    stop_reason: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
  };
  /** 顶层冗余：usage（便于 merger.py 快速读取） */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  /** 顶层冗余：stop_reason */
  stop_reason: string;
  /** 是否为不完整响应 */
  is_partial: boolean;
  /** compact_boundary 信息（压缩事件发生时设置） */
  compact_boundary?: {
    summary: string;
    messageCountBefore: number;
    timestamp: string;
  };
}

export class TraceWriter {
  private sessionDir: string;
  private initialized = false;

  constructor(baseDir: string, sessionId: string) {
    this.sessionDir = join(baseDir, "sessions", sessionId);
  }

  /** 获取输出目录路径 */
  getSessionDir(): string {
    return this.sessionDir;
  }

  /** 确保输出目录存在 */
  private ensureDir(): boolean {
    if (this.initialized) return true;
    try {
      if (!existsSync(this.sessionDir)) {
        mkdirSync(this.sessionDir, { recursive: true });
      }
      this.initialized = true;
      return true;
    } catch (err) {
      getLogger().warn("TRACE", `创建输出目录失败: ${this.sessionDir} - ${err}`);
      return false;
    }
  }

  /**
   * 写入/覆盖 session.traj
   * 使用 Bun.write() 原子写入，每次 AfterModel 后重建
   */
  async writeSessionTraj(content: string): Promise<void> {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "session.traj");
      await Bun.write(filePath, content);
    } catch (err) {
      getLogger().warn("TRACE", `写入 session.traj 失败: ${err}`);
    }
  }

  /**
   * 追加一行到 raw.jsonl
   * 每次 AfterModel 完成 pair 后调用
   */
  appendRawJsonl(line: string): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "raw.jsonl");
      appendFileSync(filePath, line.endsWith("\n") ? line : line + "\n");
    } catch (err) {
      getLogger().warn("TRACE", `追加 raw.jsonl 失败: ${err}`);
    }
  }

  /**
   * 追加一行到 events.jsonl
   * 每个 hook 事件触发时调用
   */
  appendEventsJsonl(line: string): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "events.jsonl");
      appendFileSync(filePath, line.endsWith("\n") ? line : line + "\n");
    } catch (err) {
      getLogger().warn("TRACE", `追加 events.jsonl 失败: ${err}`);
    }
  }

  // ─── 便捷方法：序列化 + 写入 ───

  /**
   * 序列化并写入 session.traj
   * @param traj - 完整轨迹对象（包含 trajectory/history/info/metadata）
   */
  async writeTraj(traj: object): Promise<void> {
    const content = JSON.stringify(traj, null, 2);
    await this.writeSessionTraj(content);
  }

  /**
   * 序列化并追加一行到 raw.jsonl
   * @param entry - 请求/响应对数据
   */
  appendRaw(entry: RawJsonlEntry): void {
    const line = JSON.stringify(entry);
    this.appendRawJsonl(line);
  }

  /**
   * 序列化并追加一行到 events.jsonl
   * @param event - hook 事件数据
   */
  appendEvent(event: HookEvent): void {
    const line = JSON.stringify(event);
    this.appendEventsJsonl(line);
  }

  /**
   * 追加一行到 errors.jsonl
   * 任何被 engine/queryLoop/fallback catch 的异常都应落盘于此
   */
  appendErrorsJsonl(line: string): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "errors.jsonl");
      appendFileSync(filePath, line.endsWith("\n") ? line : line + "\n");
    } catch (err) {
      getLogger().warn("TRACE", `追加 errors.jsonl 失败: ${err}`);
    }
  }

  /**
   * 序列化并追加一行到 errors.jsonl
   * @param entry - 错误事件数据
   */
  appendError(entry: object): void {
    const line = JSON.stringify(entry);
    this.appendErrorsJsonl(line);
  }

  /**
   * 写入/覆盖 messages.json — D3-1 崩溃验尸快照。
   *
   * 落实 CLAUDE.md 评测纪律不变量第 1 条「transcript 必落盘」到真实交互退出路径。
   * 此前崩溃 session 只有 metadata.json，无完整消息历史，无法验尸（如孤儿 tool_use 现场）。
   *
   * @param snapshot 完整消息历史快照对象（含 messages + 退出归因）
   */
  writeMessagesSnapshot(snapshot: object): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "messages.json");
      writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      getLogger().warn("TRACE", `写入 messages.json 失败: ${err}`);
    }
  }

  /**
   * 写入/覆盖 session-summary.json — 优化 2：批量分诊入口。
   *
   * 固化的是 digest（唯一事实源）在 SessionEnd 时算好的瘦身结论，而非在 collector
   * 里另起一套摘要逻辑（否则会与 digest 的 20+ 条异常规则漂移出两套结果）。
   * 用途：用 jq 过滤 sessions 下所有 session-summary.json（如 errors>0）一键批量筛问题会话。
   *
   * @param summary 瘦身后的会话摘要对象
   */
  writeSessionSummary(summary: object): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "session-summary.json");
      writeFileSync(filePath, JSON.stringify(summary, null, 2));
    } catch (err) {
      getLogger().warn("TRACE", `写入 session-summary.json 失败: ${err}`);
    }
  }
}
