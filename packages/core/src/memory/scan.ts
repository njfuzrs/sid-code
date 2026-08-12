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

/**
 * 从文本中解析 frontmatter 字段。
 * 用简单正则而非完整 YAML 解析器，避免额外依赖。
 * 支持 `key: value` 行。
 */
export function parseFrontmatter(text: string): Partial<MemoryFrontmatter> {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return {};
  const block = m[1];
  const result: Partial<MemoryFrontmatter> = {};
  for (const line of block.split("\n")) {
    const fieldMatch = line.match(/^(\w+):\s*(.+?)\s*$/);
    if (!fieldMatch) continue;
    const key = fieldMatch[1];
    let value = fieldMatch[2].trim();
    // 去掉成对引号
    value = value.replace(/^["']|["']$/g, "");
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
    else if (key === "type" && isMemoryType(value)) result.type = value as MemoryType;
  }
  return result;
}

/** 去掉正文里的 frontmatter 块，返回正文部分 */
export function stripFrontmatter(text: string): string {
  return text
    .replace(FRONTMATTER_RE, "")
    .replace(/^\s*\n/, "")
    .trimEnd();
}

/** 应跳过的文件名 / 目录名 */
const SKIP_NAMES = new Set(["MEMORY.md", "memories.json", "memories.json.bak"]);
const SKIP_DIRS = new Set(["logs", "archive", ".trash"]);

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

  let entries: string[];
  try {
    entries = await readdir(memoryDir, { recursive: true });
  } catch {
    return [];
  }

  const candidates = entries.filter((rel) => {
    if (signal?.aborted) return false;
    if (!rel.endsWith(".md")) return false;
    const segments = rel.split(/[\\/]/);
    const base = segments[segments.length - 1];
    if (SKIP_NAMES.has(base)) return false;
    if (segments.some((s) => SKIP_DIRS.has(s))) return false;
    return true;
  });

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
