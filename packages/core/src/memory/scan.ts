/**
 * 记忆文件扫描 + frontmatter 解析
 *
 * 只解析每个 .md 文件的前若干行获取 frontmatter（节省 I/O），
 * 不读取完整正文。用于 MEMORY.md 索引构建、提取代理清单、召回初筛。
 */

import { join } from "path";
import { existsSync } from "fs";
import { readdir, stat } from "fs/promises";
import {
  isMemoryType,
  type MemoryHeader,
  type MemoryFrontmatter,
  type MemoryType,
} from "./types.ts";
import { MEMORY_LIMITS } from "./types.ts";

/** 匹配 --- 包围的 frontmatter 块（文件开头） */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/** 允许从嵌套块里降级取值的父键白名单（当前只有 cc 的 `metadata:`）。 */
const NESTED_PARENTS = new Set(["metadata"]);

/**
 * 读 frontmatter 块里的字段，返回**扁平字符串映射**（P2-13）。
 *
 * ─── 为什么不能只逐行 `key: value` ───
 *
 * cc 真实落盘的记忆文件用**嵌套**写法，`type` 在 `metadata:` 之下缩进两格：
 *
 * ```yaml
 * name: some-memory
 * description: 一行描述
 * metadata:
 *   node_type: memory
 *   type: project              ← 我们要的 type 在这一层
 *   modified: 2026-09-03T03:38:42.648Z
 * ```
 *
 * 三种错法各自的后果（都不报错，只是结果错）：
 *
 * 1. **不认缩进、把子键当顶层读**（`indexOf(":")` 那种写法）：`metadata.name`
 *    会覆盖顶层 `name` —— 记忆的逻辑标识被子键改写，而 `name` 是 P0-1 的去重键，
 *    改错它等于把两条记忆并成一条。所以子键**只能降级参与，绝不能覆盖顶层**。
 * 2. **只认顶层、完全忽略缩进行**（本次修复前的实现）：cc 的 `type` 恒读不到，
 *    落到 `inferMemoryType` 启发式去猜 —— 猜错会改变文件名前缀与索引分类。
 * 3. **用 `indexOf(":")` 切值**：ISO 时间戳 `2026-09-03T03:38:42.648Z` 会被截成
 *    `2026-09-03T03`（取第一个冒号）。此处用非贪婪 `(.+?)` 到行尾，值里的冒号原样保留。
 *
 * 所以本函数的口径是：**顶层键优先，白名单父键（`metadata:`）下的子键作降级来源，
 * 其余缩进行一律丢弃**。丢弃而非提升是刻意的 —— 未知嵌套结构的语义我们不知道，
 * 猜它等于第 1 种错法。
 */
export function readFrontmatterFields(block: string): Record<string, string> {
  const top: Record<string, string> = {};
  const nested: Record<string, string> = {};
  /** 当前所处的嵌套父键；null = 在顶层 */
  let parent: string | null = null;

  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    const indented = /^\s/.test(line);

    if (!indented) {
      // 顶层行：无论是否有值，都结束上一个嵌套块
      const m = line.match(/^([\w-]+):\s*(.*?)\s*$/);
      if (!m) {
        parent = null;
        continue;
      }
      const key = m[1];
      const value = unquote(m[2]);
      if (value === "") {
        // `metadata:` 这样的空值顶层键 = 嵌套块开始（白名单内才收子键）
        parent = NESTED_PARENTS.has(key) ? key : null;
        continue;
      }
      parent = null;
      // 同名顶层键重复出现时以**首次**为准，避免后文覆盖
      if (!(key in top)) top[key] = value;
      continue;
    }

    // 缩进行：只有在白名单父键之下才作为降级来源
    if (parent === null) continue;
    const m = line.match(/^\s+([\w-]+):\s*(.*?)\s*$/);
    if (!m) continue;
    const value = unquote(m[2]);
    if (value === "") continue;
    if (!(m[1] in nested)) nested[m[1]] = value;
  }

  // 顶层覆盖嵌套：`metadata.name` 永远盖不住顶层 `name`
  return { ...nested, ...top };
}

/** 去掉成对引号 */
function unquote(v: string): string {
  return v.trim().replace(/^["']|["']$/g, "");
}

/**
 * 从**整篇文件文本**里读 frontmatter 字段，返回扁平映射（无 frontmatter 块 → 空对象）。
 *
 * 与 `readFrontmatterFields` 的区别只在入参：那个收 frontmatter **块内容**，
 * 这个负责先用 `FRONTMATTER_RE` 把块框出来。**框出来这一步不能省** ——
 * 省掉就退化成对全文做 `/^name:/m` 匹配，正文里任意一行 `name: xxx`
 * 都会被当成 frontmatter 字段。
 */
export function readMemoryFrontmatter(text: string): Record<string, string> {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return {};
  return readFrontmatterFields(m[1]);
}

/**
 * 从文本中解析记忆 frontmatter。
 * 用简单正则而非完整 YAML 解析器，避免额外依赖；嵌套写法的兼容口径见
 * `readFrontmatterFields`。
 */
export function parseFrontmatter(text: string): Partial<MemoryFrontmatter> {
  const fields = readMemoryFrontmatter(text);
  const result: Partial<MemoryFrontmatter> = {};
  if (fields.name !== undefined) result.name = fields.name;
  if (fields.description !== undefined) result.description = fields.description;
  if (fields.type !== undefined && isMemoryType(fields.type))
    result.type = fields.type as MemoryType;
  return result;
}

/** 去掉正文里的 frontmatter 块，返回正文部分 */
export function stripFrontmatter(text: string): string {
  return text
    .replace(FRONTMATTER_RE, "")
    .replace(/^\s*\n/, "")
    .trimEnd();
}

/**
 * 应跳过的文件名 / 目录名（记忆目录枚举的**唯一**口径，P1-6）。
 *
 * ⚠️ 这两张表与 `enumerateMemoryFiles` 现在被 `MemoryStore.loadDir` 共用。
 * 加成员前想清楚**两条线都会受影响**：
 * - `archive/` 是 P0-2 的归档区，**必须**在 SKIP_DIRS 里。漏了它，被归档的记忆
 *   会重新进索引 —— 归档等于没归档，且淘汰循环会把它再归档一次，来回震荡。
 * - `memories.json.bak` 是 legacy 迁移产物。它当前不是 `.md` 所以本来也进不来，
 *   但迁移逻辑若哪天改成 `.md` 后缀，没有这张表就会被当成记忆条目加载。
 */
const SKIP_NAMES = new Set(["MEMORY.md", "memories.json", "memories.json.bak"]);
const SKIP_DIRS = new Set(["logs", "archive", ".trash"]);

/**
 * 枚举记忆目录下所有**该被当成记忆条目**的 `.md` 文件，返回相对 `memoryDir` 的路径。
 *
 * ─── P1-6：这个函数存在的理由是「同一个目录此前有两套互不兼容的枚举」 ───
 *
 * | 枚举方 | 旧实现 | 递归 | 服务对象 |
 * | --- | --- | --- | --- |
 * | `scanMemoryFiles` | `readdir(dir, {recursive:true})` | ✅ | 提取/dream manifest、召回候选 |
 * | `MemoryStore.loadDir` | `readdir(dir)` | ❌ | **MEMORY.md 索引**、`list()`、`get()` |
 *
 * 于是放在子目录里的记忆进入一个**自相矛盾**的状态：提取代理的「现有记忆清单」里
 * 有它（于是判定「已存在，不重复保存」），**但索引里没有它**（注入侧永远看不见）——
 * 记忆既不会被重新保存，也不会被读到。实测：`scanMemoryFiles` 看到
 * `[reference_nested.md, reference_top.md]`，`store.list()` 只看到 `[top]`。
 *
 * 子目录不是假想场景，三条现实路径都会造出来：
 * 1. `SKIP_DIRS` 自己就预期了 `archive/` / `logs/` 的存在 —— 而旧 `loadDir`
 *    **连这张 skip 名单都没有**（平铺读碰不到目录名）。两个模块对「目录长什么样」
 *    的假设本来就不一致。
 * 2. dream 的 prune 指令鼓励模型整理记忆库，模型很可能建 `archive/` 搬旧记忆。
 * 3. 用户手动整理 —— 记忆目录是**明确设计给人直接编辑**的（见 store.ts 头注释）。
 *
 * ⚠️ 返回的是**相对路径**（如 `sub/x.md`），不是 basename。索引链接
 * `- [key](sub/x.md)` 相对 `MEMORY.md` 所在目录解析，模型拿 `${dir}/${链接}` 直接可读；
 * 换成 basename 会让子目录里的记忆产出**指不到东西的链接**。
 */
export async function enumerateMemoryFiles(memoryDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(memoryDir, { recursive: true });
  } catch {
    return [];
  }
  return entries.filter((rel) => {
    if (!rel.endsWith(".md")) return false;
    const segments = rel.split(/[\\/]/);
    const base = segments[segments.length - 1];
    if (SKIP_NAMES.has(base)) return false;
    // 任一层目录命中 skip 名单即整条排除（`archive/a/b.md` 也要排除）
    if (segments.slice(0, -1).some((s) => SKIP_DIRS.has(s))) return false;
    return true;
  });
}

/**
 * 扫描记忆目录，提取所有 .md 文件的 frontmatter 头信息。
 * - 跳过 MEMORY.md、logs/ 等
 * - 并行 stat + 读取前若干字节
 * - 按 mtime 降序（最新优先）
 * - 限制 SCAN_MAX_FILES 个
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal?: AbortSignal,
): Promise<MemoryHeader[]> {
  if (!existsSync(memoryDir)) return [];

  // P1-6：枚举口径与 MemoryStore.loadDir 共用同一个函数，两条线不再各写一套
  const all = await enumerateMemoryFiles(memoryDir);
  const candidates = signal?.aborted ? [] : all;

  const settled = await Promise.allSettled(
    candidates.map(async (rel) => {
      const filePath = join(memoryDir, rel);
      const st = await stat(filePath);
      if (!st.isFile()) throw new Error("not a file");
      // 只读取前 4KB 获取 frontmatter
      const fd = Bun.file(filePath);
      const head = (await fd.text()).slice(0, 4096);
      const fm = parseFrontmatter(head);
      const segments = rel.split(/[\\/]/);
      const filename = segments[segments.length - 1];
      const header: MemoryHeader = {
        filename,
        filePath,
        mtimeMs: st.mtimeMs,
        description: fm.description ?? null,
        name: fm.name ?? filename.replace(/\.md$/, ""),
        type: fm.type,
      };
      return header;
    }),
  );

  const headers: MemoryHeader[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") headers.push(r.value);
  }

  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return headers.slice(0, MEMORY_LIMITS.SCAN_MAX_FILES);
}

/**
 * 格式化记忆清单，用于提取代理和召回选择器。
 * 输出每行一个文件：
 *   filename: user_role.md | type: user | desc: 后端工程师，Go 专家
 */
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  if (headers.length === 0) return "(no memories yet)";
  return headers
    .map((h) => {
      const type = h.type ?? "unknown";
      const desc = h.description ?? "(no description)";
      return `filename: ${h.filename} | type: ${type} | desc: ${desc}`;
    })
    .join("\n");
}
