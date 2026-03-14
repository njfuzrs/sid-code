/**
 * 会话持久化
 * 将对话历史保存为 JSON 文件，支持恢复会话
 * 支持会话摘要保存和恢复（上下文溢出时自动触发）
 */

import type { Message } from "../llm/types.ts";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";

/** 当前会话数据格式版本 */
const CURRENT_VERSION = "1.0";

/** 文件锁超时时间（5 分钟） */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** 会话数据 */
export interface SessionData {
  /** 数据格式版本，方便后续升级兼容 */
  version: string;
  id: string;
  model: string;
  provider: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

/** 会话摘要数据 */
export interface SessionSummary {
  sessionId: string;
  summary: string;
  model: string;
  provider: string;
  createdAt: string;
  /** 摘要生成时的消息数 */
  messageCount: number;
  /** 摘要生成时的 token 估算 */
  estimatedTokens: number;
}

export class SessionStore {
  private sessionDir: string;
  private summaryDir: string;

  constructor() {
    const home = process.env.HOME || homedir();
    this.sessionDir = join(home, ".sid-code", "sessions");
    this.summaryDir = join(home, ".sid-code", "sessions", "summaries");
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
    if (!existsSync(this.summaryDir)) {
      mkdirSync(this.summaryDir, { recursive: true });
    }
  }

  /** 保存会话（带文件锁） */
  async save(session: SessionData): Promise<void> {
    session.version = CURRENT_VERSION;
    session.updatedAt = new Date().toISOString();
    const filePath = join(this.sessionDir, `${session.id}.json`);

    this.acquireLock(session.id);
    try {
      await Bun.write(filePath, JSON.stringify(session, null, 2));
    } finally {
      this.releaseLock(session.id);
    }
  }

  /** 加载会话（兼容无版本号的旧数据） */
  async load(id: string): Promise<SessionData | null> {
    const filePath = join(this.sessionDir, `${id}.json`);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = await Bun.file(filePath).text();
      const data = JSON.parse(content) as SessionData;
      // 兼容旧版本：补上 version 字段
      if (!data.version) {
        data.version = "0.0";
      }
      return data;
    } catch {
      return null;
    }
  }

  /** 获取最近一次会话 */
  async loadLatest(): Promise<SessionData | null> {
    if (!existsSync(this.sessionDir)) {
      return null;
    }

    const files = readdirSync(this.sessionDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        name: f,
        path: join(this.sessionDir, f),
        mtime: statSync(join(this.sessionDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      return null;
    }

    return this.load(files[0].name.replace(".json", ""));
  }

  /** 列出所有会话 */
  async list(): Promise<{ id: string; updatedAt: string; messageCount: number }[]> {
    if (!existsSync(this.sessionDir)) {
      return [];
    }

    const files = readdirSync(this.sessionDir).filter((f) => f.endsWith(".json"));
    const sessions: { id: string; updatedAt: string; messageCount: number }[] = [];

    for (const file of files) {
      try {
        const content = await Bun.file(join(this.sessionDir, file)).text();
        const data = JSON.parse(content) as SessionData;
        if (data.id && data.updatedAt && data.messages) {
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
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = await Bun.file(filePath).text();
      return JSON.parse(content) as SessionSummary;
    } catch {
      return null;
    }
  }

  /**
   * 构建恢复消息
   * 从摘要构建一条用户消息，让 LLM 从上次中断的地方继续
   */
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

  /**
   * 获取文件锁（防止并发写入）
   * 如果锁文件存在且未超时，抛出错误
   * 如果锁文件超时（5 分钟），自动清理僵尸锁
   */
  private acquireLock(sessionId: string): void {
    const lockPath = join(this.sessionDir, `.${sessionId}.lock`);
    if (existsSync(lockPath)) {
      try {
        const lockTimeStr = Bun.file(lockPath).text();
        const lockTime = parseInt(lockTimeStr as any, 10);
        if (Date.now() - lockTime > LOCK_TIMEOUT_MS) {
          // 超时，清理僵尸锁
          unlinkSync(lockPath);
        } else {
          throw new Error(`会话 ${sessionId} 被另一个进程锁定`);
        }
      } catch (err: any) {
        if (err.message.includes("锁定")) throw err;
        // 读取失败，清理损坏的锁文件
        unlinkSync(lockPath);
      }
    }
    // 写入锁文件
    Bun.write(lockPath, Date.now().toString());
  }

  /** 释放文件锁 */
  private releaseLock(sessionId: string): void {
    const lockPath = join(this.sessionDir, `.${sessionId}.lock`);
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  }
}
