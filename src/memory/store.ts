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
import { memoryFilename, stripMemoryTypePrefix } from "./paths.ts";

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

/** MEMORY.md 索引单条摘要长度上限（对标 claude-code memdir 的 ~150 字符硬约束） */
const MEMORY_DESC_MAX_LEN = 150;

/**
 * 归一化索引/frontmatter 用的一句话摘要（**写入端根治点**）。
 *
 * 根因（上下文注入淹没用户指令，2026-07-29 复现）：desc 缺省时回退取正文首行，
 * 而记忆正文首行绝大多数是 markdown 标题（`## 负收益防线审计第 2 版完成`）。
 * 这类 `## 陈述句` 进了 MEMORY.md 索引、再随 system prompt 注入每个会话后，
 * 在模型眼里与"用户刚说的话"无法区分——实测 glm-5.2 把其中一条当成了用户输入，
 * 第一轮直接跑去 glob 那条记忆文件，完全偏离真实的 /commit 任务。
 *
 * 因此这里剥离 markdown 结构标记（标题 `#`、列表 `-`/`*`/`1.`、引用 `>`、
 * 强调 `**`），只保留纯粹的陈述内容。根治点必须在写入端：这样 MEMORY.md 文件
 * 本身就是干净的，不依赖渲染端逐行补救（渲染端另有一层兜底，见 memory/prompt.ts）。
 *
 * 对标 claude-code `memdir/memdir.ts`：索引格式硬约束为
 * `- [Title](file.md) — one-line hook`、单条 ~150 字符，且明令
 * "MEMORY.md is an index, not a memory / Never write memory content directly into MEMORY.md"。
 */
export function normalizeMemoryDesc(
  description: string | undefined,
  value: string,
): string {
  // 优先用显式 description；缺省时取正文第一个**非空**行（原实现只取 [0]，
  // 正文以空行开头时会得到空串 → 索引里出现 `- [key](file) — ` 空摘要）
  let raw = (description ?? "").trim();
  if (!raw) {
    for (const line of value.split("\n")) {
      const t = line.trim();
      if (t) { raw = t; break; }
    }
  }
  return raw
    .replace(/^#{1,6}\s+/, "")        // markdown 标题标记（`## 标题` → `标题`）
    .replace(/^>\s*/, "")             // 引用标记
    .replace(/^(?:[-*+]|\d+\.)\s+/, "") // 列表标记
    .replace(/\*\*/g, "")             // 强调标记（`**Why:**` → `Why:`）
    .replace(/\s*\n\s*/g, " ")        // 折行压平（description 可能多行）
    .trim()
    .slice(0, MEMORY_DESC_MAX_LEN);
}

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
    // 读侧同样过归一化：本次修复前写入的旧文件，frontmatter 里已经存着 `## 标题`。
    // 只修写入端的话，那些历史条目会一直把陈述句标题漏进索引（索引重建也照抄 desc）。
    description: description ? normalizeMemoryDesc(description, body) : undefined,
    createdAt: created ?? mtimeMs,
    updatedAt: updated ?? mtimeMs,
  };
}

/** 序列化 MemoryEntry 为 .md 文件内容 */
function serializeMemoryFile(entry: MemoryEntry): string {
  const desc = normalizeMemoryDesc(entry.description, entry.value);
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

    // 2026-07-30：修掉 memoryFilename 的双前缀后，**存量**文件仍叫
    // `project_project-xxx.md`。不迁移的话索引里的 key 与文件名会继续对不上
    // （模型照 key 拼路径依旧 Read 失败），等于治标不治本，所以在这里一次性改名。
    //
    // 改名只治了文件名。`name:` frontmatter 里残留的类型前缀是同一个 bug 的另一半，
    // 必须一起清（详见 migrateDoublePrefixNames 的「第二步」注释）。
    const globalRenamed = await this.migrateDoublePrefixNames(this.globalDir);
    const projectRenamed = this.projectDir
      ? await this.migrateDoublePrefixNames(this.projectDir)
      : false;

    await this.loadDir(this.globalDir, "global", this.globalEntries, this.globalFiles);
    if (this.projectDir) {
      await this.loadDir(this.projectDir, "project", this.projectEntries, this.projectFiles);
    }
    this.loaded = true;

    // 改过名就必须重建索引：索引行里的链接是文件名，改名后旧索引整行都指向
    // 不存在的文件——那正是本次要修的「Read 报文件不存在」，不能自己再造一遍。
    // 放在 loaded=true 之后：writeIndex 依赖 loadDir 填好的 files 映射。
    if (globalRenamed) await this.writeIndex(this.globalDir, this.globalEntries);
    if (projectRenamed && this.projectDir) {
      await this.writeIndex(this.projectDir, this.projectEntries);
    }
  }

  /**
   * 把存量的双类型前缀文件名归一化：`project_project-xxx.md` → `project_xxx.md`。
   *
   * 只处理「`<type>_` 后紧跟又一个类型词 + 分隔符」这一种确定形态，别的文件一律不碰。
   * 判据来自 `memoryFilename`：新逻辑对同一个 key 会产出归一化后的名字，所以这里
   * 用「重算文件名 ≠ 当前文件名」作为需要改名的信号，与生成侧共用同一套规则，
   * 不会漂移。
   *
   * 三条安全约束：
   * - **目标已存在则跳过**（不覆盖用户数据，宁可留着旧名也不丢内容）
   * - 任一步失败只 warn 不抛（记忆加载不能因为改名失败而整体失效）
   * - 幂等：改完再跑重算结果与现名一致，不再触发
   *
   * @returns 是否实际改过名（调用方据此决定要不要重建 MEMORY.md 索引）
   */
  private async migrateDoublePrefixNames(dir: string): Promise<boolean> {
    if (!existsSync(dir)) return false;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return false;
    }
    let renamed = false;
    const log = getLogger();
    const existing = new Set(names);
    for (const filename of names) {
      if (!filename.endsWith(".md") || filename === INDEX_FILE) continue;
      // 仅当形如 <type>_<type>[_-]... 时才考虑改名，避免误伤正常语义名
      const m = filename.match(
        /^(user|feedback|project|reference)_(user|feedback|project|reference)[_-]/,
      );
      if (!m) continue;
      const type = m[1]!;
      const bare = filename.replace(/\.md$/, "").slice(type.length + 1);
      const target = memoryFilename(type, bare);
      if (target === filename || existing.has(target)) continue;
      try {
        await rename(join(dir, filename), join(dir, target));
        existing.delete(filename);
        existing.add(target);
        renamed = true;
        log.debug("MEMORY", `记忆文件名归一化: ${filename} → ${target}`);
      } catch (err) {
        log.warn("MEMORY", `记忆文件名归一化失败（跳过）: ${filename} — ${(err as Error)?.message}`);
      }
    }

    // ─── 第二步：清 `name:` frontmatter 里残留的类型前缀 ───
    //
    // 上面只改了文件名，key 来自 frontmatter 的 `name:`（parseMemoryFile），所以
    // `name: project_xxx` 会继续把带前缀的 key 灌进索引方括号。这不是命名方案的
    // 固有差异，而是同一个 bug 的另一半，两个具体危害：
    //
    // 1. **索引里出现自相矛盾的分类**：改名后文件真实 type 由文件名前缀决定，而
    //    key 里那个前缀是模型当初随手写的，两者可以不一致——实测 7 条残留里有 4 条
    //    矛盾（`key=project_...` 却在 `user_*.md` / `feedback_*.md` / `reference_*.md`
    //    里）。模型读到「project_website-deploy…」会以为这是项目上下文，实际它被
    //    分类为 reference。这是会误导判断的脏数据，不是无害的命名差异。
    // 2. **key 不稳定**：同一条记忆下次被 set() 覆盖时，若模型传的 key 不带前缀，
    //    会被当成新 key 而非覆盖，产出重复条目。
    //
    // 对照实现（claude-code memdir）索引行是 `- [Title](file.md)`，方括号里就是
    // 人类可读标题、本就不等于文件名。所以**方括号 ≠ 文件名本身不是缺陷**，
    // 我们只清「key 里混进了类型前缀」这一种确定的脏数据，不去强求 key == 文件名。
    //
    // 安全约束同上：只认封闭分类法 4 个词 + 紧跟分隔符（`projection-matrix` 这类
    // 正常语义名不受影响）；单文件失败只 warn；幂等（清过一次后正则不再命中）。
    for (const filename of existing) {
      if (!filename.endsWith(".md") || filename === INDEX_FILE) continue;
      const filePath = join(dir, filename);
      try {
        const text = await Bun.file(filePath).text();
        const nameM = text.match(/^name:\s*(.+)$/m);
        const rawName = nameM?.[1]?.trim();
        if (!rawName) continue;
        // 剥离规则与文件名生成共用 stripMemoryTypePrefix（剥完为空时返回原值，
        // 所以 `name: project` 这种 key 整体是类型词的情况天然不动）
        const cleaned = stripMemoryTypePrefix(rawName);
        if (cleaned === rawName) continue;
        await Bun.write(filePath, text.replace(/^name:\s*.+$/m, `name: ${cleaned}`));
        renamed = true;
        log.debug("MEMORY", `记忆 key 归一化: ${rawName} → ${cleaned}（${filename}）`);
      } catch (err) {
        log.warn("MEMORY", `记忆 key 归一化失败（跳过）: ${filename} — ${(err as Error)?.message}`);
      }
    }

    return renamed;
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

  /**
   * M5：解析某条记忆对应的 .md 文件绝对路径（供 /memory 面板用编辑器打开）。
   * 未找到（key 不存在或无文件映射）返回 null。
   */
  async resolveEntryPath(key: string, scope?: "global" | "project"): Promise<string | null> {
    await this.load();
    const tryResolve = (files: Map<string, string>, dir: string | null): string | null => {
      if (!dir) return null;
      const fn = files.get(key);
      return fn ? join(dir, fn) : null;
    };
    // 优先按传入 scope；未指定时项目覆盖全局（与 get 一致）
    if (scope === "global") return tryResolve(this.globalFiles, this.globalDir);
    if (scope === "project") return tryResolve(this.projectFiles, this.projectDir);
    return tryResolve(this.projectFiles, this.projectDir)
      ?? tryResolve(this.globalFiles, this.globalDir);
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

  /**
   * 读取 MEMORY.md 索引内容（供 Task 7 系统提示词注入）。
   *
   * ─── 2026-07-30 修复：两个让索引「指不到文件」的缺陷 ───
   *
   * **缺陷 A：只给文件名、不给目录 → 模型只能猜路径。**
   * 索引正文是 `- [key](file.md)` 的裸相对链接，注入提示词只说「用 Read 工具
   * 读取对应文件」，全程不出现记忆目录。实测模型把 `project_xxx.md` 拼到
   * `~/.sid-code/memory/`（该目录真实存在且有文件，是最像的落点），而项目记忆
   * 实际在 `~/.sid-code/projects/<key>/memory/`——文件名对、目录错、Read 报
   * 「文件不存在」。修法是在每段索引前显式声明该段所在的**绝对目录**。
   *
   * **缺陷 B：global scope 索引从不注入。**
   * 旧实现 `if (!this.projectDir) return null` + 只读 projectDir 的 INDEX_FILE，
   * 于是 `~/.sid-code/memory/` 下的全局记忆（用户画像、跨项目偏好）永远进不了
   * system prompt——写得进、读不到，与团队记忆曾经的「半黑洞」同型。而函数
   * 的 doc 和 prompt.ts 的形参注释都写着「global/project scope」，属实现与
   * 契约不符。现在两个 scope 各出一段，各自带自己的目录。
   *
   * 顺序：项目段在前、全局段在后——同 key 时项目记忆优先（与 `get()` 的覆盖
   * 语义一致），越具体的越靠前。
   */
  async getIndexContent(): Promise<string | null> {
    await this.load();

    const sections: string[] = [];
    for (const [dir, label] of [
      [this.projectDir, "项目记忆"] as const,
      [this.globalDir, "全局记忆"] as const,
    ]) {
      if (!dir) continue;
      const indexPath = join(dir, INDEX_FILE);
      if (!existsSync(indexPath)) continue;
      let text: string;
      try {
        text = (await Bun.file(indexPath).text()).trim();
      } catch {
        continue;
      }
      if (!text) continue;
      // 目录必须是绝对路径且与链接可直接拼接：模型拿 `${dir}/${链接}` 就能 Read。
      sections.push(`#### ${label}（目录：${dir}）\n\n${text}`);
    }

    return sections.length > 0 ? sections.join("\n\n") : null;
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
      const desc = normalizeMemoryDesc(e.description, e.value);
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
