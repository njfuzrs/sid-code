/**
 * 双层记忆系统
 * 全局记忆：~/.sid-code/memory/
 * 项目记忆：<project>/.sid-code/memory/
 *
 * 每条记忆带 key、value、scope、createdAt、updatedAt
 * 查询优先级：项目 > 全局
 * 注入到系统提示词（通过附件系统，priority 30）
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { getLogger } from "../debug/logger.ts";

/** 单条记忆 */
export interface MemoryEntry {
  key: string;
  value: string;
  scope: "global" | "project";
  createdAt: number;
  updatedAt: number;
}

/** 记忆存储文件格式 */
interface MemoryData {
  version: string;
  entries: Record<string, MemoryEntry>;
}

/** 记忆存储限制 */
const MAX_ENTRIES_PER_SCOPE = 200;
const MAX_VALUE_LENGTH = 10000;
const MEMORY_FILE = "memories.json";

/** 模块级摘要缓存（预取和正式调用共享） */
let summaryCacheEntry: { summary: string | null; timestamp: number; projectRoot: string } | null = null;
const SUMMARY_CACHE_TTL = 30_000; // 30 秒

/** 清除摘要缓存（写入记忆后调用） */
export function clearMemorySummaryCache(): void {
  summaryCacheEntry = null;
}

export class MemoryStore {
  private globalDir: string;
  private projectDir: string | null;
  private globalData: MemoryData;
  private projectData: MemoryData;
  private loaded: boolean = false;

  constructor(projectRoot?: string) {
    this.globalDir = join(homedir(), ".sid-code", "memory");
    this.projectDir = projectRoot ? join(projectRoot, ".sid-code", "memory") : null;
    this.globalData = { version: "1.0", entries: {} };
    this.projectData = { version: "1.0", entries: {} };
  }

  /** 加载记忆数据 */
  async load(): Promise<void> {
    if (this.loaded) return;

    this.globalData = await this.loadFile(join(this.globalDir, MEMORY_FILE));
    if (this.projectDir) {
      this.projectData = await this.loadFile(join(this.projectDir, MEMORY_FILE));
    }
    this.loaded = true;
  }

  /** 设置记忆（key-value） */
  async set(key: string, value: string, scope: "global" | "project" = "project"): Promise<void> {
    await this.load();
    const log = getLogger();

    if (value.length > MAX_VALUE_LENGTH) {
      value = value.slice(0, MAX_VALUE_LENGTH);
      log.warn("MEMORY", `记忆值超长，已截断为 ${MAX_VALUE_LENGTH} 字符: ${key}`);
    }

    const data = scope === "global" ? this.globalData : this.projectData;
    const now = Date.now();

    const existing = data.entries[key];
    data.entries[key] = {
      key,
      value,
      scope,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    // 超过限制时，移除最旧的条目
    const entries = Object.values(data.entries);
    if (entries.length > MAX_ENTRIES_PER_SCOPE) {
      entries.sort((a, b) => a.updatedAt - b.updatedAt);
      const toRemove = entries.slice(0, entries.length - MAX_ENTRIES_PER_SCOPE);
      for (const entry of toRemove) {
        delete data.entries[entry.key];
      }
    }

    await this.saveData(scope);
    clearMemorySummaryCache(); // 写入后清除摘要缓存
    log.debug("MEMORY", `记忆已保存: [${scope}] ${key}`);
  }

  /** 获取记忆（项目优先于全局） */
  async get(key: string): Promise<MemoryEntry | null> {
    await this.load();

    // 项目记忆优先
    if (this.projectData.entries[key]) {
      return this.projectData.entries[key];
    }
    if (this.globalData.entries[key]) {
      return this.globalData.entries[key];
    }
    return null;
  }

  /** 删除记忆 */
  async delete(key: string, scope?: "global" | "project"): Promise<boolean> {
    await this.load();

    let deleted = false;
    if (!scope || scope === "project") {
      if (this.projectData.entries[key]) {
        delete this.projectData.entries[key];
        await this.saveData("project");
        deleted = true;
      }
    }
    if (!scope || scope === "global") {
      if (this.globalData.entries[key]) {
        delete this.globalData.entries[key];
        await this.saveData("global");
        deleted = true;
      }
    }
    if (deleted) clearMemorySummaryCache();
    return deleted;
  }

  /** 列出所有记忆（合并，项目覆盖全局） */
  async list(): Promise<MemoryEntry[]> {
    await this.load();

    const merged = new Map<string, MemoryEntry>();

    // 先加全局
    for (const entry of Object.values(this.globalData.entries)) {
      merged.set(entry.key, entry);
    }
    // 项目覆盖
    for (const entry of Object.values(this.projectData.entries)) {
      merged.set(entry.key, entry);
    }

    return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 搜索记忆（key 或 value 包含关键词） */
  async search(keyword: string): Promise<MemoryEntry[]> {
    const all = await this.list();
    const lower = keyword.toLowerCase();
    return all.filter(e =>
      e.key.toLowerCase().includes(lower) ||
      e.value.toLowerCase().includes(lower)
    );
  }

  /**
   * 生成记忆摘要（用于注入系统提示词）
   * 返回格式化的记忆内容，按更新时间排序
   * 带模块级缓存，预取和正式调用共享结果
   */
  async generateSummary(maxLength: number = 5000): Promise<string | null> {
    // 命中缓存
    const projectRoot = this.projectDir ? this.projectDir.replace(/\/.sid-code\/memory$/, "") : "";
    if (summaryCacheEntry
      && summaryCacheEntry.projectRoot === projectRoot
      && Date.now() - summaryCacheEntry.timestamp < SUMMARY_CACHE_TTL) {
      return summaryCacheEntry.summary;
    }

    const entries = await this.list();
    if (entries.length === 0) {
      summaryCacheEntry = { summary: null, timestamp: Date.now(), projectRoot };
      return null;
    }

    const lines: string[] = [];
    let totalLen = 0;

    for (const entry of entries) {
      const scope = entry.scope === "global" ? "[全局]" : "[项目]";
      const line = `- ${scope} ${entry.key}: ${entry.value}`;

      if (totalLen + line.length > maxLength) break;
      lines.push(line);
      totalLen += line.length;
    }

    const summary = lines.join("\n");
    summaryCacheEntry = { summary, timestamp: Date.now(), projectRoot };
    return summary;
  }

  /** 从文件加载记忆数据 */
  private async loadFile(filePath: string): Promise<MemoryData> {
    try {
      if (!existsSync(filePath)) {
        return { version: "1.0", entries: {} };
      }
      const text = await Bun.file(filePath).text();
      return JSON.parse(text);
    } catch {
      return { version: "1.0", entries: {} };
    }
  }

  /** 保存记忆数据到文件 */
  private async saveData(scope: "global" | "project"): Promise<void> {
    const dir = scope === "global" ? this.globalDir : this.projectDir;
    if (!dir) return;

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const filePath = join(dir, MEMORY_FILE);
    const data = scope === "global" ? this.globalData : this.projectData;
    await Bun.write(filePath, JSON.stringify(data, null, 2));
  }

  /** 获取统计信息 */
  async getStats(): Promise<{ globalCount: number; projectCount: number }> {
    await this.load();
    return {
      globalCount: Object.keys(this.globalData.entries).length,
      projectCount: Object.keys(this.projectData.entries).length,
    };
  }
}
