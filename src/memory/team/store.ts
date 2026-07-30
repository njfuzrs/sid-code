/**
 * 团队记忆写入器（E.11）。
 *
 * 把一条记忆以与 auto-memory 相同的 .md frontmatter 格式写入本地团队记忆目录，
 * 并维护 MEMORY.md 索引。写入前过 secret 扫描（团队记忆会同步给所有协作者）。
 *
 * 与 MemoryStore 的区别：MemoryStore 管理 global/project 两个私有 scope；团队
 * 记忆是「共享 scope」，单独走这里，避免把第三 scope 侵入式塞进 MemoryStore。
 * 落盘后由 watcher 同步到共享目录。
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { readdir, readFile, writeFile } from "fs/promises";
import { getLogger } from "../../debug/logger.ts";
import { getTeamMemPath } from "./paths.ts";
import { scanForSecrets } from "./secret-scanner.ts";
import { inferMemoryType, normalizeMemoryDesc } from "../store.ts";
import { memoryFilename } from "../paths.ts";
import { MEMORY_LIMITS, type MemoryType } from "../types.ts";

const INDEX_FILE = "MEMORY.md";

/** 团队记忆写入结果 */
export interface TeamMemoryWriteResult {
  success: boolean;
  /** 写入的文件路径（成功时） */
  filePath?: string;
  /** 失败/拒绝原因 */
  error?: string;
  /** 是否因 secret 被拒 */
  rejectedSecret?: boolean;
}

/** 序列化为 .md 文件内容（与 store.ts 的 serializeMemoryFile 同格式） */
function serialize(key: string, value: string, description: string, type: MemoryType, now: number): string {
  // 与私有索引同一根治点：desc 缺省回退取正文首行时，必须剥离 markdown 标题等结构
  // 标记，否则 `## 陈述句` 进索引后随 system prompt 注入，模型会误当成用户输入
  // （见 store.ts normalizeMemoryDesc 注释里的 2026-07-29 实测事故）。
  const desc = normalizeMemoryDesc(description, value);
  return [
    "---",
    `name: ${key}`,
    `description: ${desc}`,
    `type: ${type}`,
    `created: ${now}`,
    `updated: ${now}`,
    "---",
    "",
    value,
    "",
  ].join("\n");
}

/**
 * 重建团队记忆 MEMORY.md 索引（扫描目录内全部条目）。
 *
 * 索引是**注入侧的唯一事实源**（`getTeamIndexContent` 只读这个文件、无扫目录
 * fallback），所以任何改动本地团队记忆目录的一方都必须重建它，否则同步下来的
 * 条目躺在磁盘上却永远进不了 system prompt。两个调用方：
 *   - `saveTeamMemory`（本机写入）
 *   - `syncTeamMemory`（pull / 删除传播 / 冲突落盘后，见 sync.ts 收尾）
 */
export async function rebuildTeamIndex(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const lines: string[] = ["# 团队共享记忆", ""];
  for (const filename of names.sort()) {
    if (!filename.endsWith(".md") || filename === INDEX_FILE) continue;
    if (filename.startsWith(".") || filename.includes(".conflict-")) continue;
    try {
      const text = await readFile(join(dir, filename), "utf8");
      const nameM = text.match(/^name:\s*(.+)$/m);
      const descM = text.match(/^description:\s*(.+)$/m);
      const name = nameM?.[1]?.trim() || filename.replace(/\.md$/, "");
      // 读侧也过归一化：既有旧文件的 frontmatter 里可能已存着 `## 标题`（本次修复前
      // 写入的），重建索引时剥掉，否则旧数据的陈述句标题会一直漏进注入侧索引。
      const desc = normalizeMemoryDesc(descM?.[1]?.trim(), "");
      lines.push(`- [${name}](${filename})${desc ? ` — ${desc}` : ""}`);
    } catch {
      /* 跳过损坏文件 */
    }
  }
  lines.push("");
  await writeFile(join(dir, INDEX_FILE), lines.join("\n"), "utf8");
}

/**
 * 读取团队记忆 MEMORY.md 索引内容（供 system prompt 注入）。
 * 未启用 / 目录或索引不存在 / 读失败均返回 null。
 *
 * 2026-07-30：与私有索引同步修掉「只给文件名不给目录」——索引行是裸相对链接，
 * 模型无从知道团队记忆目录在哪，只能猜路径然后 Read 失败。这里在正文前显式
 * 声明绝对目录，模型拿「目录 + 链接文件名」即可直接 Read。
 */
export async function getTeamIndexContent(cwd: string = process.cwd()): Promise<string | null> {
  const dir = getTeamMemPath(cwd);
  const indexPath = join(dir, INDEX_FILE);
  if (!existsSync(indexPath)) return null;
  try {
    const text = (await readFile(indexPath, "utf8")).trim();
    if (!text) return null;
    return `#### 团队记忆（目录：${dir}）\n\n${text}`;
  } catch {
    return null;
  }
}

/**
 * 写入一条团队记忆。
 * @returns 成功 / 因 secret 被拒 / IO 失败。
 */
export async function saveTeamMemory(
  key: string,
  value: string,
  opts?: { type?: MemoryType; description?: string; cwd?: string },
): Promise<TeamMemoryWriteResult> {
  const log = getLogger();
  const cwd = opts?.cwd ?? process.cwd();

  if (value.length > MEMORY_LIMITS.ENTRY_MAX_CHARS) {
    value = value.slice(0, MEMORY_LIMITS.ENTRY_MAX_CHARS);
  }

  // secret 守卫：团队记忆共享给所有协作者，命中 secret 直接拒绝
  const matches = scanForSecrets(value);
  if (matches.length > 0) {
    const labels = Array.from(new Set(matches.map((m) => m.label))).join(", ");
    log.warn("TEAMMEM", `✗ 拒绝保存含 secret 的团队记忆 ${key} — 命中: ${labels}`);
    return {
      success: false,
      rejectedSecret: true,
      error: `检测到 secret (${labels})，拒绝写入团队记忆。团队记忆会同步给所有协作者，凭证应放 .env / 环境变量。`,
    };
  }

  const dir = getTeamMemPath(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const type: MemoryType = opts?.type || inferMemoryType(key, value);
  const filename = memoryFilename(type, key);
  const filePath = join(dir, filename);
  const now = Date.now();

  try {
    await writeFile(filePath, serialize(key, value, opts?.description ?? "", type, now), "utf8");
    await rebuildTeamIndex(dir);
    log.info("TEAMMEM", `✓ 团队记忆已保存: ${key}`);

    // 通知 watcher 同步到共享目录（best-effort，不阻断）
    try {
      const { notifyTeamMemoryWrite } = await import("./watcher.ts");
      await notifyTeamMemoryWrite();
    } catch { /* watcher 未启动时忽略 */ }

    return { success: true, filePath };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
