/**
 * 会话持久化
 * 将对话历史保存为 JSON 文件，支持恢复会话
 */

import type { Message } from "../llm/types.ts";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, statSync } from "fs";

/** 会话数据 */
export interface SessionData {
  id: string;
  model: string;
  provider: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export class SessionStore {
  private sessionDir: string;

  constructor() {
    const home = process.env.HOME || homedir();
    this.sessionDir = join(home, ".sid-code", "sessions");
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  /** 保存会话 */
  async save(session: SessionData): Promise<void> {
    session.updatedAt = new Date().toISOString();
    const filePath = join(this.sessionDir, `${session.id}.json`);
    await Bun.write(filePath, JSON.stringify(session, null, 2));
  }

  /** 加载会话 */
  async load(id: string): Promise<SessionData | null> {
    const filePath = join(this.sessionDir, `${id}.json`);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = await Bun.file(filePath).text();
      return JSON.parse(content) as SessionData;
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

  /** 生成新的会话 ID */
  static generateId(): string {
    return crypto.randomUUID().slice(0, 8);
  }
}
