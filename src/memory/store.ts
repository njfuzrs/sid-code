/**
 * 多层记忆栈 — Auto Memory 存储（文件系统后端）
 *
 * 从"单文件 JSON KV 存储"升级为"每条记忆一个 .md 文件 + MEMORY.md 索引"。
 * 对齐 Claude Code 的 memdir/ 架构：文件系统即数据库，模型可用 Read/Write/Grep
 * 直接读写记忆，用户也能直接查看编辑。
 *
 * 目录布局：
 *   全局: ~/.sid-code/memory/
 *   项目: ~/.sid-code/projects/<git-root-hash>/memory/
 *   每个目录下：MEMORY.md（索引） + <type>_<slug>.md（记忆文件）
 *
 * 向后兼容：保留 MemoryStore 的全部公共方法与 MemoryEntry 结构，
 * 内部实现改为文件系统；首次 load() 时自动迁移旧 memories.json。
 *
 * ADR-026: save_memory 写盘前的 secret 检测在 tool/memory.ts 完成，store 保持纯净。
 */

import { join, basename } from "path";
import { existsSync, mkdirSync } from "fs";
import { readdir, stat, unlink, rename } from "fs/promises";
import { getLogger } from "../debug/logger.ts";
import { getAutoMemPath } from "./paths.ts";
import { sidHomePath } from "../config/paths.ts";
import {
  MEMORY_LIMITS,
  MEMORY_TYPES,
  isMemoryType,
  type MemoryType,
} from "./types.ts";
import { memoryFilename } from "./paths.ts";

/** 单条记忆（向后兼容旧结构，新增可选 type/description） */
export interface MemoryEntry {
  key: string;
  value: string;
  scope: "global" | "project";
  createdAt: number;
  updatedAt: number;
  /** 4 类分类法（新增，旧数据迁移时启发式推断） */
  type?: MemoryType;
  /** 一行描述（新增，用于 MEMORY.md 索引与召回） */
  description?: string;
}

/** 旧版 JSON 存储格式（仅用于迁移） */
interface LegacyMemoryData {
  version: string;
  entries: Record<string, MemoryEntry>;
}

const LEGACY_FILE = "memories.json";
const INDEX_FILE = "MEMORY.md";

/** 模块级摘要缓存（预取和正式调用共享） */
let summaryCacheEntry: { summary: string | null; timestamp: number; key: string } | null = null;
const SUMMARY_CACHE_TTL = 30_000; // 30 秒

/** 清除摘要缓存（写入记忆后调用） */
export function clearMemorySummaryCache(): void {
  summaryCacheEntry = null;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/** 根据 key/value 启发式推断记忆类型（迁移与 legacy set 使用） */
export function inferMemoryType(key: string, value: string): MemoryType {
  const hay = `${key} ${value}`.toLowerCase();
  if (/(http|url|dashboard|ticket|jira|链接|地址|文档|wiki)/.test(hay)) return "reference";
  if (/(偏好|喜欢|不要|always|prefer|纠正|反馈|以后都|风格|约定)/.test(hay)) return "feedback";
  if (/(用户|我是|角色|工程师|expert|新手|背景|profile)/.test(hay)) return "user";
  return "project";
}

/** 解析记忆 .md 文件正文为 MemoryEntry（含 created/updated） */
function parseMemoryFile(
  text: string,
  filename: string,
  scope: "global" | "project",
  mtimeMs: number,
): MemoryEntry | null {
  const m = text.match(FRONTMATTER_RE);
  let name: string | undefined;
  let description: string | undefined;
  let type: MemoryType | undefined;
  let created: number | undefined;
  let updated: number | undefined;
  let body: string;

  if (m) {
    for (const line of m[1].split("\n")) {
      const fm = line.match(/^(\w+):\s*(.+?)\s*$/);
      if (!fm) continue;
      const k = fm[1];
      const v = fm[2].trim().replace(/^["']|["']$/g, "");
      if (k === "name") name = v;
      else if (k === "description") description = v;
      else if (k === "type" && isMemoryType(v)) type = v as MemoryType;
      else if (k === "created") created = Number(v) || undefined;
      else if (k === "updated") updated = Number(v) || undefined;
    }
    body = text.replace(FRONTMATTER_RE, "").replace(/^\s*\n/, "").trimEnd();
  } else {
    body = text.trim();
  }

  const key = name || filename.replace(/\.md$/, "");
  if (!body) return null;
  return {
    key,
    value: body,
    scope,
    type,
    description,
    createdAt: created ?? mtimeMs,
    updatedAt: updated ?? mtimeMs,
  };
}

/** 序列化 MemoryEntry 为 .md 文件内容 */
function serializeMemoryFile(entry: MemoryEntry): string {
  const desc = (entry.description || entry.value.split("\n")[0] || "")
    .replace(/\n/g, " ")
    .slice(0, 150);
  const type = entry.type || inferMemoryType(entry.key, entry.value);
  return [
    "---",
    `name: ${entry.key}`,
    `description: ${desc}`,
    `type: ${type}`,
    `created: ${entry.createdAt}`,
    `updated: ${entry.updatedAt}`,
    "---",
    "",
    entry.value,
    "",
  ].join("\n");
}

export class MemoryStore {
  private globalDir: string;
  private projectDir: string | null;
  private projectRoot: string | null;
  /** 内存缓存：scope → key → entry */
  private globalEntries: Map<string, MemoryEntry> = new Map();
  private projectEntries: Map<string, MemoryEntry> = new Map();
  /** 文件名映射：scope → key → filename（用于删除/覆盖） */
  private globalFiles: Map<string, string> = new Map();
  private projectFiles: Map<string, string> = new Map();
  private loaded = false;

  constructor(
    projectRoot?: string,
    opts?: { projectMemoryDir?: string; globalMemoryDir?: string },
  ) {
    this.globalDir = opts?.globalMemoryDir ?? sidHomePath("memory");
    this.projectRoot = projectRoot ?? null;
    this.projectDir = opts?.projectMemoryDir
      ?? (projectRoot ? getAutoMemPath(projectRoot) : null);
  }

  /** 获取项目记忆目录（供召回/提示词注入使用） */
  getProjectMemoryDir(): string | null {
    return this.projectDir;
  }

  /** 获取全局记忆目录 */
  getGlobalMemoryDir(): string {
    return this.globalDir;
  }

  /** 加载记忆数据（含旧 JSON 迁移） */
  async load(): Promise<void> {
    if (this.loaded) return;

    await this.migrateLegacyIfNeeded(this.globalDir, "global");
    if (this.projectDir) {
      // 旧项目记忆位于 <project>/.sid-code/memory/memories.json
      if (this.projectRoot) {
        const oldProjectJson = join(this.projectRoot, ".sid-code", "memory", LEGACY_FILE);
        await this.migrateLegacyFile(oldProjectJson, this.projectDir, "project");
      }
      await this.migrateLegacyIfNeeded(this.projectDir, "project");
    }

    await this.loadDir(this.globalDir, "global", this.globalEntries, this.globalFiles);
    if (this.projectDir) {
      await this.loadDir(this.projectDir, "project", this.projectEntries, this.projectFiles);
    }
    this.loaded = true;
  }

  /** 扫描目录加载所有记忆 .md 文件到内存缓存 */
  private async loadDir(
    dir: string,
    scope: "global" | "project",
    entries: Map<string, MemoryEntry>,
    files: Map<string, string>,
  ): Promise<void> {
    if (!existsSync(dir)) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const filename of names) {
      if (!filename.endsWith(".md") || filename === INDEX_FILE) continue;
      const filePath = join(dir, filename);
      try {
        const st = await stat(filePath);
        if (!st.isFile()) continue;
        const text = await Bun.file(filePath).text();
        const entry = parseMemoryFile(text, filename, scope, st.mtimeMs);
        if (entry) {
          entries.set(entry.key, entry);
          files.set(entry.key, filename);
        }
      } catch {
        // 跳过损坏文件
      }
    }
  }

  /** 设置记忆（key-value，向后兼容签名） */
  async set(
    key: string,
    value: string,
    scope: "global" | "project" = "project",
    opts?: { type?: MemoryType; description?: string },
  ): Promise<void> {
    await this.load();
    const log = getLogger();

    if (value.length > MEMORY_LIMITS.ENTRY_MAX_CHARS) {
      value = value.slice(0, MEMORY_LIMITS.ENTRY_MAX_CHARS);
      log.warn("MEMORY", `记忆值超长，已截断为 ${MEMORY_LIMITS.ENTRY_MAX_CHARS} 字符: ${key}`);
    }

    const entries = scope === "global" ? this.globalEntries : this.projectEntries;
    const files = scope === "global" ? this.globalFiles : this.projectFiles;
    const dir = scope === "global" ? this.globalDir : this.projectDir;
    if (!dir) return;

    const now = Date.now();
    const existing = entries.get(key);
    const entry: MemoryEntry = {
      key,
      value,
      scope,
      type: opts?.type || existing?.type || inferMemoryType(key, value),
      description: opts?.description || existing?.description,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    entries.set(key, entry);

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // 复用已有文件名，否则按 type+slug 生成
    let filename = files.get(key);
    if (!filename) {
      filename = memoryFilename(entry.type!, key);
      // 避免文件名冲突（不同 key 派生出同名）
      let candidate = filename;
      let i = 1;
      while ([...files.values()].includes(candidate)) {
        candidate = filename.replace(/\.md$/, `-${i}.md`);
        i++;
      }
      filename = candidate;
      files.set(key, filename);
    }

    await Bun.write(join(dir, filename), serializeMemoryFile(entry));

    // 超过上限时移除最旧条目
    if (entries.size > MEMORY_LIMITS.SCAN_MAX_FILES) {
      const sorted = [...entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      const toRemove = sorted.slice(0, entries.size - MEMORY_LIMITS.SCAN_MAX_FILES);
      for (const old of toRemove) {
        const fn = files.get(old.key);
        if (fn) {
          try { await unlink(join(dir, fn)); } catch { /* ignore */ }
        }
        entries.delete(old.key);
        files.delete(old.key);
      }
    }

    await this.writeIndex(dir, entries);
    clearMemorySummaryCache();
    log.debug("MEMORY", `记忆已保存: [${scope}] ${key}`);
  }

  /** 获取记忆（项目优先于全局） */
  async get(key: string): Promise<MemoryEntry | null> {
    await this.load();
    return this.projectEntries.get(key) ?? this.globalEntries.get(key) ?? null;
  }

  /** 删除记忆 */
  async delete(key: string, scope?: "global" | "project"): Promise<boolean> {
    await this.load();
    let deleted = false;

    const tryDelete = async (
      entries: Map<string, MemoryEntry>,
      files: Map<string, string>,
      dir: string | null,
    ) => {
      if (!dir || !entries.has(key)) return;
      const fn = files.get(key);
      if (fn) {
        try { await unlink(join(dir, fn)); } catch { /* ignore */ }
      }
      entries.delete(key);
      files.delete(key);
      await this.writeIndex(dir, entries);
      deleted = true;
    };

    if (!scope || scope === "project") {
      await tryDelete(this.projectEntries, this.projectFiles, this.projectDir);
    }
    if (!scope || scope === "global") {
      await tryDelete(this.globalEntries, this.globalFiles, this.globalDir);
    }
    if (deleted) clearMemorySummaryCache();
    return deleted;
  }

  /** 列出所有记忆（合并，项目覆盖全局） */
  async list(): Promise<MemoryEntry[]> {
    await this.load();
    const merged = new Map<string, MemoryEntry>();
    for (const e of this.globalEntries.values()) merged.set(e.key, e);
    for (const e of this.projectEntries.values()) merged.set(e.key, e);
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 搜索记忆（key 或 value 含关键词） */
  async search(keyword: string): Promise<MemoryEntry[]> {
    const all = await this.list();
    const lower = keyword.toLowerCase();
    return all.filter(
      (e) => e.key.toLowerCase().includes(lower) || e.value.toLowerCase().includes(lower),
    );
  }

  /**
   * 生成记忆摘要（注入系统提示词）。
   * 格式与旧实现保持一致（`- [全局] key: value`），带模块级缓存。
   */
  async generateSummary(maxLength = 5000): Promise<string | null> {
    await this.load();
    const cacheKey = `${this.globalDir}|${this.projectDir ?? ""}`;
    if (
      summaryCacheEntry &&
      summaryCacheEntry.key === cacheKey &&
      Date.now() - summaryCacheEntry.timestamp < SUMMARY_CACHE_TTL
    ) {
      return summaryCacheEntry.summary;
    }

    const entries = await this.list();
    if (entries.length === 0) {
      summaryCacheEntry = { summary: null, timestamp: Date.now(), key: cacheKey };
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
    summaryCacheEntry = { summary, timestamp: Date.now(), key: cacheKey };
    return summary;
  }

  /** 读取项目 MEMORY.md 索引内容（供 Task 7 系统提示词注入） */
  async getIndexContent(): Promise<string | null> {
    await this.load();
    if (!this.projectDir) return null;
    const indexPath = join(this.projectDir, INDEX_FILE);
    if (!existsSync(indexPath)) return null;
    try {
      const text = await Bun.file(indexPath).text();
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  /** 获取统计信息 */
  async getStats(): Promise<{ globalCount: number; projectCount: number }> {
    await this.load();
    return {
      globalCount: this.globalEntries.size,
      projectCount: this.projectEntries.size,
    };
  }

  /**
   * 写入 / 重建 MEMORY.md 索引。
   * 格式：- [name](file.md) — description
   * 截断：≤200 行、≤25KB，超限附加警告。
   */
  private async writeIndex(dir: string, entries: Map<string, MemoryEntry>): Promise<void> {
    const indexPath = join(dir, INDEX_FILE);
    const files = dir === this.globalDir ? this.globalFiles : this.projectFiles;

    if (entries.size === 0) {
      if (existsSync(indexPath)) {
        try { await unlink(indexPath); } catch { /* ignore */ }
      }
      return;
    }

    const sorted = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const lines: string[] = ["# Memory Index", ""];
    let truncated = false;
    for (const e of sorted) {
      if (lines.length >= MEMORY_LIMITS.INDEX_MAX_LINES) {
        truncated = true;
        break;
      }
      const fn = files.get(e.key) ?? memoryFilename(e.type || "project", e.key);
      const desc = (e.description || e.value.split("\n")[0] || "").replace(/\n/g, " ").slice(0, 150);
      lines.push(`- [${e.key}](${fn}) — ${desc}`);
    }
    let content = lines.join("\n") + "\n";
    if (content.length > MEMORY_LIMITS.INDEX_MAX_BYTES) {
      content = content.slice(0, MEMORY_LIMITS.INDEX_MAX_BYTES);
      truncated = true;
    }
    if (truncated) {
      content += "\n> ⚠️ 索引已截断（超过 200 行 / 25KB 上限），部分记忆未列出。\n";
    }
    await Bun.write(indexPath, content);
  }

  /** 若目录下存在旧 memories.json，迁移为 .md 文件 */
  private async migrateLegacyIfNeeded(dir: string, scope: "global" | "project"): Promise<void> {
    const legacyPath = join(dir, LEGACY_FILE);
    await this.migrateLegacyFile(legacyPath, dir, scope);
  }

  /** 迁移单个旧 JSON 文件到目标目录 */
  private async migrateLegacyFile(
    legacyPath: string,
    targetDir: string,
    scope: "global" | "project",
  ): Promise<void> {
    if (!existsSync(legacyPath)) return;
    const log = getLogger();
    try {
      const text = await Bun.file(legacyPath).text();
      const data = JSON.parse(text) as LegacyMemoryData;
      const entries = Object.values(data.entries || {});
      if (entries.length === 0) {
        await rename(legacyPath, legacyPath + ".bak").catch(() => {});
        return;
      }
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

      const usedFilenames = new Set<string>();
      const indexEntries = new Map<string, MemoryEntry>();
      const indexFiles =
        targetDir === this.globalDir ? this.globalFiles : this.projectFiles;

      for (const e of entries) {
        const type = e.type || inferMemoryType(e.key, e.value);
        let filename = memoryFilename(type, e.key);
        let i = 1;
        while (usedFilenames.has(filename)) {
          filename = memoryFilename(type, e.key).replace(/\.md$/, `-${i}.md`);
          i++;
        }
        usedFilenames.add(filename);
        const migrated: MemoryEntry = {
          ...e,
          scope,
          type,
          description: e.description,
        };
        await Bun.write(join(targetDir, filename), serializeMemoryFile(migrated));
        indexEntries.set(e.key, migrated);
        indexFiles.set(e.key, filename);
      }

      await this.writeIndex(targetDir, indexEntries);
      await rename(legacyPath, legacyPath + ".bak").catch(() => {});
      log.info("MEMORY", `已迁移 ${entries.length} 条旧记忆: ${basename(legacyPath)} → .md (${scope})`);
    } catch (err: any) {
      log.warn("MEMORY", `旧记忆迁移失败 (${legacyPath}): ${err.message}`);
    }
  }
}

/** 导出供测试与外部使用 */
export { MEMORY_TYPES };
