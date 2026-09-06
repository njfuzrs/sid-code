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
import { MEMORY_LIMITS, MEMORY_TYPES, isMemoryType, type MemoryType } from "./types.ts";
import { memoryFilename, stripMemoryTypePrefix } from "./paths.ts";
// P0-3：freshness 此前唯一的生产引用在 recall.ts 内，而 recall 自己零接线 ⇒ 整条不可达。
// 索引注入是主路径，把它接到这里，freshness 才第一次真正到达模型。
import { memoryAge, memoryAgeDays } from "./freshness.ts";

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
 * 公网 IPv4 字面量（用于索引摘要脱敏）。
 *
 * 三重收紧，每一重都为压掉一类实测出来的误报：
 *
 * 1. **八位组必须合法**（0-255）。否则 `1.2.3.4` 之外的版本号（`10.15.2.300`）也会命中。
 * 2. **排除私网 / 环回 / 链路本地 / 全零 / 广播段**。`127.0.0.1`、`192.168.1.50`、
 *    `0.0.0.0` 常出现在"本地起服务在哪个端口"这类记忆里，抹掉纯属噪音。
 * 3. **前后不得紧邻数字或点**。挡住 `1.2.3.4.5` 这类被从中间截出一段的形态。
 *
 * 但**合法公网 IP 与四段版本号在字面上无法区分**（`8.8.8.8` 既是 DNS 也可以是版本号），
 * 所以正则只是必要条件，是否脱敏还要看语境信号 —— 见 `INFRA_CONTEXT_RE`。
 *
 * 刻意**不做**主机名/域名匹配：`example.com`、`git.internal.example.com` 在记忆摘要里是正常
 * 且必要的指路信息，抹掉会让索引失去价值。这与 secret-redact.ts `db_conn_string`
 * 那条注释的取舍**方向相反**且都成立："误把真 conn string 放过去比让 example.com 误报
 * 更危险"是**拒绝写入**场景的权衡；索引脱敏是**有损改写**，宁可漏，不可误伤可读性。
 */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const PUBLIC_IPV4_RE = new RegExp(
  [
    "(?<![\\d.])", // 左边界：不紧邻数字/点
    "(?!(?:10|127|0|255)\\.)", // 排除 10./127./0./255.
    "(?!169\\.254\\.)", // 排除链路本地
    "(?!192\\.168\\.)", // 排除 192.168.
    "(?!172\\.(?:1[6-9]|2\\d|3[01])\\.)", // 排除 172.16-31.
    `(?:${OCTET}\\.){3}${OCTET}`,
    "(?![\\d.])", // 右边界
  ].join(""),
  "g",
);

/**
 * 基础设施语境信号：出现这些词，才认为同条摘要里的四段数字是**服务器地址**而非版本号。
 *
 * 这是把"合法公网 IP"与"四段版本号"分开的唯一可靠手段。宁可漏判（某条摘要写了裸 IP
 * 却一个语境词都没有 → 不脱敏）也不误伤——漏判的后果是一条摘要多曝光一个地址，
 * 误伤的后果是索引里的版本号/端口信息变成 `<地址已省略>`，模型据此做出错误判断。
 */
const INFRA_CONTEXT_RE =
  /服务器|主机|机器|部署|发布|上传|登录|ssh|scp|sshpass|nginx|堡垒|跳板|内网|外网|生产环境|host|deploy|server/i;

/** 与基础设施地址同现的特权账号标注，如 `（root）` / `(admin)`。 */
const PRIVILEGED_ACCOUNT_RE = /[（(]\s*(?:root|admin|administrator)\s*[)）]/gi;

/**
 * 版本号否决：紧邻匹配点左侧出现版本语汇时，这四段数字是版本号，不是地址。
 *
 * `INFRA_CONTEXT_RE` 是**整条摘要**级别的粗筛，会被"部署脚本要求 node 版本 18.20.4.1"
 * 这种一句话里既有 `部署` 又有版本号的形态骗过（实测误报）。所以再加一道**匹配点近旁**
 * 的否决：只看左侧 12 字符，够覆盖 `版本 x.y.z.w` / `version x.y.z.w` / `v1.2.3.4`，
 * 又不会误伤 `服务器：1.2.3.4` 这种真地址。
 */
const VERSION_PREFIX_RE = /(?:版本|版本号|version|ver\.?|@|\bv)\s*$/i;
const VERSION_LOOKBEHIND_CHARS = 12;

/**
 * 索引摘要脱敏：抹掉基础设施坐标（公网 IP + 特权账号标注）。
 *
 * 2026-07-30 实测发现：一条 `reference` 记忆把生产发布服务器的公网 IP 和 `（root）`
 * 写进了 frontmatter 的 `description`，于是它**随 MEMORY.md 索引进入每一个会话的
 * system prompt**（索引常驻 core 区，见 config/system-prompt.ts:372）。凭证类 secret
 * 有 tool/memory.ts 的 detect 拦着，但"公网 IP + root"不在 secret 模式里，畅通无阻。
 *
 * 为什么落在这里而不是扩展 secret-redact：
 *   - secret-redact 的语义是**命中即拒绝写入**（tool/memory.ts:113）。IP 形态天然易误报
 *     （版本号、私网、示例地址），一旦误报，代价是用户合法记忆存不进去——比泄漏更烦人。
 *   - 索引摘要是**有损压缩**的产物，脱敏本就是它的分内事；正文完整保留，模型需要时
 *     Read 那个文件仍拿得到真实地址。信息没丢，只是不再常驻每个会话的 system prompt。
 *
 * 因此这里只做"降低常驻曝光面"，不做准入拦截，两条防线职责不重叠。
 */
export function redactInfraCoordinates(desc: string): string {
  // 双条件：形态像公网 IP **且**上下文提到服务器/部署类词汇。缺任一条都不动。
  if (!INFRA_CONTEXT_RE.test(desc)) return desc;
  PUBLIC_IPV4_RE.lastIndex = 0;
  if (!PUBLIC_IPV4_RE.test(desc)) {
    PUBLIC_IPV4_RE.lastIndex = 0;
    return desc;
  }
  PUBLIC_IPV4_RE.lastIndex = 0;
  let redactedAny = false;
  const out = desc.replace(PUBLIC_IPV4_RE, (m, offset: number) => {
    const left = desc.slice(Math.max(0, offset - VERSION_LOOKBEHIND_CHARS), offset);
    if (VERSION_PREFIX_RE.test(left)) return m; // 版本号，原样保留
    redactedAny = true;
    return "<地址已省略>";
  });
  if (!redactedAny) return desc;
  return (
    out
      // 账号标注只在**同一条摘要里真抹掉过公网 IP** 时才处理：脱离了主机的 `（root）`
      // 已无指向性，但同现时二者拼起来就是一份可直接用的登录坐标。
      .replace(PRIVILEGED_ACCOUNT_RE, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

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
export function normalizeMemoryDesc(description: string | undefined, value: string): string {
  // 优先用显式 description；缺省时取正文第一个**非空**行（原实现只取 [0]，
  // 正文以空行开头时会得到空串 → 索引里出现 `- [key](file) — ` 空摘要）
  let raw = (description ?? "").trim();
  if (!raw) {
    for (const line of value.split("\n")) {
      const t = line.trim();
      if (t) {
        raw = t;
        break;
      }
    }
  }
  const cleaned = raw
    .replace(/^#{1,6}\s+/, "") // markdown 标题标记（`## 标题` → `标题`）
    .replace(/^>\s*/, "") // 引用标记
    .replace(/^(?:[-*+]|\d+\.)\s+/, "") // 列表标记
    .replace(/\*\*/g, "") // 强调标记（`**Why:**` → `Why:`）
    .replace(/\s*\n\s*/g, " ") // 折行压平（description 可能多行）
    .trim();
  // 脱敏在截断**之前**：否则 150 字符边界可能把 IP 切成半截，
  // 既没抹干净又匹配不上（`121.196.14` 这种残留同样有指向性）。
  return redactInfraCoordinates(cleaned).slice(0, MEMORY_DESC_MAX_LEN);
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
    body = text
      .replace(FRONTMATTER_RE, "")
      .replace(/^\s*\n/, "")
      .trimEnd();
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

/**
 * 给索引正文逐行补上「这条记忆多久之前写的」（P0-3 的第一半）。
 *
 * ─── 为什么这一行时间戳是整条读取侧防线里最便宜、最该先做的一步 ───
 *
 * 参考文档的主线论点是：**漂移不可能在存储层根治，防御全部押在读取侧**。
 * 而 sid-code 主路径（MEMORY.md 索引全量注入 + 模型按需 Read）此前**完全不带年龄信息**：
 *
 * - 索引行是 `- [key](file) — 一句话摘要`，没有 mtime、没有「N 天前」；
 * - 模型 `Read` 出正文时，`stripFrontmatter` 又把 `updated:` 一起剥掉了 ——
 *   frontmatter 里那个时间戳**读到模型眼前时已经不在了**。
 *
 * 净效果：模型看到的每条记忆都是**无时间戳的陈述句**，与「刚刚核实过的事实」不可区分。
 * 这正是文档 §1.2「有害记忆伪装成已验证结论」的形态 —— 它消灭的是**求证的动作**。
 *
 * cc 的做法是在每条被注入的记忆正文前加年龄，理由写在它的 `memoryAge.ts`：
 * 模型不擅长算日期差，「47 天前」比 ISO 时间戳更能触发过时警觉。
 * 所以这里给的是 `memoryAge()` 的人类可读相对时间，**不是**裸时间戳。
 *
 * 实现上刻意选了「逐行注解」而不是「另起一段警告」：
 * - 警告段落与具体某条记忆之间没有绑定关系，模型读到第 40 行时早忘了段首那句；
 * - 逐行注解让年龄与摘要**同处一行**，引用哪条就看到哪条的年龄。
 *
 * 只给超过 1 天的条目加（`buildFreshnessWarning` 的同一判据，见 freshness.ts）：
 * 今天刚写的记忆加「today」纯属噪声，还会每天击穿一次 prompt cache 前缀。
 *
 * ⚠️ cache 影响是刻意接受的 trade-off（北极星「更安全 ↔ 更省」）：
 * 相对天数每天会变一次，所以这段内容**按天漂移**、跨天会击穿一次静态前缀。
 * 代价上界是「每天一次」而非「每轮一次」——因为注解粒度是天，不是小时或毫秒。
 * 换来的是模型每轮都能看见「这条 47 天前写的」。
 *
 * @param text    索引正文（`- [key](file) — desc` 逐行）
 * @param entries 该 scope 的内存条目（key → entry，取 `updatedAt`）
 */
export function annotateIndexAges(text: string, entries: Map<string, MemoryEntry>): string {
  const now = Date.now();
  return text
    .split("\n")
    .map((line) => {
      // 只处理索引条目行；段标题、空行、截断警告原样保留
      const m = line.match(/^(\s*-\s*\[([^\]]*)\]\([^)]*\))(.*)$/);
      if (!m) return line;
      const entry = entries.get(m[2]);
      if (!entry) return line; // 索引里有、内存里没有（孤儿行）：不编造年龄
      const days = memoryAgeDays(entry.updatedAt, now);
      if (days < 1) return line; // 与 buildFreshnessWarning 同判据：1 天内不加噪声
      return `${m[1]} ⏳${memoryAge(entry.updatedAt, now)}${m[3]}`;
    })
    .join("\n");
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
  /**
   * P0-1：因 frontmatter `name:` 重名而被遮蔽的文件（磁盘上有、索引里没有）。
   * 每次 `loadDir` 前清空，由 `listShadowedFiles()` 对外暴露。
   */
  private shadowedFiles: Array<{
    dir: string;
    filename: string;
    key: string;
    scope: "global" | "project";
  }> = [];

  constructor(
    projectRoot?: string,
    opts?: { projectMemoryDir?: string; globalMemoryDir?: string },
  ) {
    this.globalDir = opts?.globalMemoryDir ?? sidHomePath("memory");
    this.projectRoot = projectRoot ?? null;
    this.projectDir = opts?.projectMemoryDir ?? (projectRoot ? getAutoMemPath(projectRoot) : null);
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

    // 重名清单按「本次加载」重算，否则重复 load 会把同一条重复计入
    this.shadowedFiles = [];
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
        log.warn(
          "MEMORY",
          `记忆文件名归一化失败（跳过）: ${filename} — ${(err as Error)?.message}`,
        );
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

  /**
   * 扫描目录加载所有记忆 .md 文件到内存缓存。
   *
   * ─── P0-1：重名 `name:` 不再静默丢一半 ───
   *
   * `entries` 的主键是 frontmatter 的 `name:`，而落盘时的**文件名**另有一套去重
   * （撞名加 `-1` 后缀）。两套 key 不同源 ⇒ 「两个不同文件、同一个 `name:`」在磁盘上
   * 完全合法。旧实现在这里直接 `entries.set(entry.key, ...)`，于是：
   *
   * 1. **留下哪条取决于 `readdir` 返回顺序** —— 非确定性，同一份磁盘两次加载可能不同结果；
   * 2. 被覆盖的那个文件从此无人引用，索引重建后它**永久不进上下文**（孤儿记忆）。
   *
   * 这不是构造出来的边界场景：本仓库自己的记忆库就命中过（111 个 `.md` / 索引 110 条指针，
   * 丢掉的那半条恰是「问题现象与复现方式」，留下的是「已修复」—— 下一个 agent 读到
   * 结论却看不到依据）。而 `list()` / `getStats()` 报的都是内存视角的 110，
   * **任何基于 store API 的自检都发现不了**，只有直接比对磁盘与索引才暴露。
   *
   * 修法两条，都不删用户数据：
   * - **确定性**：文件名排序后加载，撞 key 时按 `updatedAt` 取新（同值则按文件名字典序），
   *   结果不再随文件系统顺序漂移；
   * - **可见性**：被遮蔽的文件记进 `shadowedFiles`，`log.warn` 点名两个文件，
   *   并经 `listShadowedFiles()` 暴露给自检 / `/memory` 侧。
   *   刻意**不自动合并、不自动删**：哪一半该留是语义判断，只能由人决定。
   */
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
    const log = getLogger();
    // 排序 = 确定性的前提：readdir 不保证顺序，撞 key 时的胜者不能取决于文件系统实现
    for (const filename of [...names].sort()) {
      if (!filename.endsWith(".md") || filename === INDEX_FILE) continue;
      const filePath = join(dir, filename);
      try {
        const st = await stat(filePath);
        if (!st.isFile()) continue;
        const text = await Bun.file(filePath).text();
        const entry = parseMemoryFile(text, filename, scope, st.mtimeMs);
        if (!entry) continue;

        const prev = entries.get(entry.key);
        if (prev) {
          const prevFile = files.get(entry.key);
          // 取新：updatedAt 更大者胜；相等时按文件名字典序取前者（纯为确定性，无语义）
          const incomingWins =
            entry.updatedAt > prev.updatedAt ||
            (entry.updatedAt === prev.updatedAt && filename < (prevFile ?? ""));
          const loser = incomingWins ? prevFile : filename;
          if (loser) {
            this.shadowedFiles.push({ dir, filename: loser, key: entry.key, scope });
            log.warn(
              "MEMORY",
              `记忆 key 重名（${entry.key}）：保留 ${incomingWins ? filename : prevFile}、` +
                `遮蔽 ${loser} —— 被遮蔽的文件不会进索引，需人工合并或改名（scope=${scope}）`,
            );
          }
          if (!incomingWins) continue;
        }

        entries.set(entry.key, entry);
        files.set(entry.key, filename);
      } catch {
        // 跳过损坏文件
      }
    }
  }

  /**
   * 把一条超限记忆移进 `archive/` 子目录（P0-2）。返回归档后的文件名，失败返回 null。
   *
   * 为什么是 `rename` 而不是 `unlink`：淘汰口径（LWU，见 types.ts `STORE_MAX_ENTRIES`）
   * 与记忆价值无关，所以这个判断**没有资格删用户数据**——它只有资格「移出索引」。
   * `archive/` 在 `scan.ts` 的 `SKIP_DIRS` 里，移进去即不再被扫描与索引，
   * 但字节还在，用户 / 下一个 agent 能捞回来。
   *
   * 撞名时加 `-N` 后缀：归档区可能已经有同名文件（同一条记忆被淘汰两次），
   * 覆盖它等于在「不删数据」的路径上又删一次。
   */
  private async archiveMemoryFile(dir: string, filename: string): Promise<string | null> {
    const src = join(dir, filename);
    if (!existsSync(src)) return null;
    try {
      const archiveDir = join(dir, "archive");
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
      let target = filename;
      let i = 1;
      while (existsSync(join(archiveDir, target))) {
        target = filename.replace(/\.md$/, `-${i}.md`);
        i++;
      }
      await rename(src, join(archiveDir, target));
      return target;
    } catch {
      return null;
    }
  }

  /**
   * 读磁盘上某个记忆文件的 frontmatter `name:`（P0-1 写入侧判据）。
   *
   * 返回 null = 文件不存在 / 读不动 / 没有 `name:`。**只读 frontmatter 那几行**
   * （4KB 上限，与 `scanMemoryFiles` 同口径），不整文件读——这条在 `set()` 的
   * 撞名循环里可能被调用多次。
   *
   * 为什么不能省掉这次 I/O 直接信内存：`files` 映射只覆盖 `loadDir` 认得的文件，
   * 磁盘上完全可能有它不知道的同名记忆（子目录、解析失败、模型用 Write 直写），
   * 而正是这些「内存看不见、磁盘上有」的文件让旧代码造出了重名。
   */
  private async diskNameOf(dir: string, filename: string): Promise<string | null> {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) return null;
    try {
      const head = (await Bun.file(filePath).text()).slice(0, 4096);
      const m = head.match(FRONTMATTER_RE);
      if (!m) return null;
      const nameM = m[1].match(/^name:\s*(.+)$/m);
      const raw = nameM?.[1]?.trim().replace(/^["']|["']$/g, "");
      return raw || null;
    } catch {
      return null;
    }
  }

  /**
   * 列出因 `name:` 重名而被遮蔽的记忆文件（P0-1 的可见性出口）。
   *
   * 这些文件真实存在于磁盘、但不在索引里，所以模型永远读不到它们。
   * 返回空数组 = 无重名。**这是唯一能发现该状态的 store API**——
   * `list()` / `getStats()` 都是内存视角，重名时报的是去重后的数字。
   */
  async listShadowedFiles(): Promise<
    ReadonlyArray<{ dir: string; filename: string; key: string; scope: "global" | "project" }>
  > {
    await this.load();
    return this.shadowedFiles;
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
      //
      // ─── P0-1 写入侧：加 `-N` 后缀前必须先问「磁盘上那个文件是不是同一个 key」 ───
      //
      // 旧实现只查内存里的 `files.values()`。而 `files` 只装得下 `loadDir` 认得的文件：
      // 子目录里的记忆（缺陷 6）、frontmatter 解析失败的、以及模型用 Write 工具直接写的，
      // 都不在其中。于是「磁盘上已有 reference_x.md（`name: x`），但 files 里没有 x」时，
      // 旧代码走新建分支 → 撞名 → 加 `-1` → 落出**第二个 `name: x`**，
      // 也就是加载侧刚修的那个孤儿状态的**生产路径**。
      //
      // 修法：候选文件名若已在磁盘上，就读它的 `name:`——
      // 同 key ⇒ 认领它（这本来就是这条记忆的文件，正常更新即可）；
      // 不同 key ⇒ 才继续加后缀。只有「磁盘上没有」或「同 key」两种情况会落笔。
      const taken = new Set(files.values());
      let candidate = filename;
      let i = 1;
      // 每轮只读一次磁盘（diskNameOf 有 I/O，别在同一轮里问两遍同一个文件）
      for (;;) {
        if (taken.has(candidate)) {
          candidate = filename.replace(/\.md$/, `-${i}.md`);
          i++;
          continue;
        }
        const onDisk = await this.diskNameOf(dir, candidate);
        // 磁盘上没有，或那个文件就是本 key 的记忆 ⇒ 用它（后者是「认领并更新」）
        if (onDisk === null || onDisk === key) break;
        candidate = filename.replace(/\.md$/, `-${i}.md`);
        i++;
      }
      filename = candidate;
      files.set(key, filename);
    }

    await Bun.write(join(dir, filename), serializeMemoryFile(entry));

    // ─── P0-2：超过上限时**归档**最旧条目，不再静默删除 ───
    //
    // 旧实现在这里 `unlink` + `catch { /* ignore */ }`：真删、无备份、无告警，
    // 连失败都不报（同函数截断 value 时反倒会 log.warn）。三个理由让它必须改：
    //
    // 1. **淘汰口径与价值无关**。排序键 `updatedAt` 只在 `set()` 时更新 ⇒ 这是
    //    LWU 而非 LRU：被频繁召回但从不重写的记忆恒为「最旧」，优先被删的恰是
    //    「写下来之后一直有用、只是没人改过」的那些。
    // 2. **无法事后追溯**。记忆子系统零埋点，删了也不知道删的是什么。
    // 3. 上限借用的是**扫描用**常量（见 types.ts `SCAN_MAX_FILES` 注释），
    //    语义本就不符——现已分成两个常量。
    //
    // 归档目标 `archive/` 是 `scan.ts` 的 `SKIP_DIRS` 成员，所以归档过的文件
    // 既不再进索引、也不再被扫描计数，但**字节还在**、用户能自己捞回来。
    if (entries.size > MEMORY_LIMITS.STORE_MAX_ENTRIES) {
      const sorted = [...entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      const toRemove = sorted.slice(0, entries.size - MEMORY_LIMITS.STORE_MAX_ENTRIES);
      for (const old of toRemove) {
        const fn = files.get(old.key);
        if (fn) {
          const archived = await this.archiveMemoryFile(dir, fn);
          log.warn(
            "MEMORY",
            archived
              ? `记忆条数超过 ${MEMORY_LIMITS.STORE_MAX_ENTRIES}（scope=${scope}），` +
                  `已归档最旧的一条: ${old.key} → archive/${archived}（未删除，可人工恢复）`
              : `记忆条数超过 ${MEMORY_LIMITS.STORE_MAX_ENTRIES}（scope=${scope}），` +
                  `归档 ${old.key}（${fn}）失败——该文件保留在原处，仅从索引移除`,
          );
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
        try {
          await unlink(join(dir, fn));
        } catch {
          /* ignore */
        }
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
    return (
      tryResolve(this.projectFiles, this.projectDir) ?? tryResolve(this.globalFiles, this.globalDir)
    );
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
      // P0-3：正文逐行补「多久之前」，让 freshness 真的到达模型眼前（见 annotateIndexAges）。
      const entries = dir === this.globalDir ? this.globalEntries : this.projectEntries;
      sections.push(`#### ${label}（目录：${dir}）\n\n${annotateIndexAges(text, entries)}`);
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
        try {
          await unlink(indexPath);
        } catch {
          /* ignore */
        }
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
      const indexFiles = targetDir === this.globalDir ? this.globalFiles : this.projectFiles;

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
      log.info(
        "MEMORY",
        `已迁移 ${entries.length} 条旧记忆: ${basename(legacyPath)} → .md (${scope})`,
      );
    } catch (err: any) {
      log.warn("MEMORY", `旧记忆迁移失败 (${legacyPath}): ${err.message}`);
    }
  }
}

/** 导出供测试与外部使用 */
export { MEMORY_TYPES };
