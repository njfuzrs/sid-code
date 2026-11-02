/**
 * 记忆索引容量状态（记忆横向剖析 T3）—— 让写入侧知道索引满了。
 *
 * 剖析核出：sid-code 项目记忆 `file_count 209 / index_entry_count 83` 是常态，后台抽取
 * 每轮都在往一个早已截断的索引后面追加新条目，新写的大多直接成为「磁盘上有、模型看不见」
 * 的孤儿。写入侧此前完全不知道这件事 —— 提取提示词里没有容量信息，权限层也不区分新建与更新。
 *
 * 全部同步实现：`canUseTool` 在工具鉴权路径上，状态要在调用那一刻从磁盘读，
 * 不缓存（主模型与后台代理会交替写，缓存必然过期）。只在 save_memory / write 鉴权时触发，
 * 一次抽取至多几次，读 ≤200 个文件头的成本可以接受。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { MEMORY_LIMITS } from "./types.ts";
import { INDEX_TRUNCATION_NOTICE, utf8Bytes } from "./index-budget.ts";
import { isEnumerableMemoryPath, readMemoryFrontmatter } from "./scan.ts";

export interface IndexCapacity {
  /** MEMORY.md 里的指针条数 */
  entries: number;
  /** MEMORY.md 真 UTF-8 字节 */
  bytes: number;
  /** 索引是否已截断（以 writeIndex 追加的警告文案为准，与写侧同一判据） */
  truncated: boolean;
}

/** 读 MEMORY.md 的容量状态。索引不存在 = 空、未截断。 */
export function readIndexCapacity(memoryDir: string): IndexCapacity {
  const p = join(memoryDir, "MEMORY.md");
  if (!existsSync(p)) return { entries: 0, bytes: 0, truncated: false };
  try {
    const text = readFileSync(p, "utf8");
    const entries = (text.match(/^\s*-\s*\[[^\]]*\]\([^)]*\)/gm) ?? []).length;
    return {
      entries,
      bytes: utf8Bytes(text),
      truncated: text.includes(INDEX_TRUNCATION_NOTICE.trim()),
    };
  } catch {
    return { entries: 0, bytes: 0, truncated: false };
  }
}

/** 提取提示词里的一行容量状态 */
export function formatIndexCapacity(c: IndexCapacity): string {
  const kb = (n: number) => `${Math.round(n / 1000)}KB`;
  return (
    `索引已用 ${c.entries} / ${MEMORY_LIMITS.INDEX_MAX_ENTRIES} 条、` +
    `${kb(c.bytes)} / ${kb(MEMORY_LIMITS.INDEX_MAX_BYTES)}` +
    (c.truncated ? "；已截断" : "")
  );
}

/**
 * 记忆目录里已存在的 key 与文件名（同步枚举，与 `enumerateMemoryFiles` 同一过滤口径）。
 *
 * `names`：frontmatter `name:`，缺省回落文件名去 `.md`（与 store `parseMemoryFile` 一致）；
 * `files`：相对路径的 basename。两者合起来覆盖 `resolveMemoryKey` 的三步解析。
 */
export function listExistingMemoryKeys(memoryDir: string): {
  names: Set<string>;
  files: Set<string>;
} {
  const names = new Set<string>();
  const files = new Set<string>();
  let rels: string[];
  try {
    rels = readdirSync(memoryDir, { recursive: true }) as string[];
  } catch {
    return { names, files };
  }
  for (const rel of rels) {
    if (!isEnumerableMemoryPath(rel)) continue;
    const full = join(memoryDir, rel);
    try {
      if (!statSync(full).isFile()) continue;
      const fn = basename(rel);
      files.add(fn);
      const fm = readMemoryFrontmatter(readFileSync(full, "utf8").slice(0, 4096));
      names.add(fm.name || fn.replace(/\.md$/, ""));
    } catch {
      /* 单个文件读不动不影响其余 */
    }
  }
  return { names, files };
}

/**
 * 这个 key 是否对应一条已有记忆 —— 与 `MemoryStore.set` 里 `resolveMemoryKey` 的解析顺序对齐：
 * 精确 → 去 `.md` → 按真实文件名反查。key 先按 save_memory 工具同样的方式归一（去换行、trim）。
 */
export function isExistingMemoryKey(
  rawKey: string,
  existing: { names: Set<string>; files: Set<string> },
): boolean {
  const key = rawKey.replace(/\n/g, " ").trim();
  if (!key) return false;
  if (existing.names.has(key)) return true;
  const bare = key.replace(/\.md$/, "");
  return existing.names.has(bare) || existing.files.has(`${bare}.md`);
}
