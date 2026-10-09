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

import { join, basename } from "path";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile, stat } from "fs/promises";
import { getLogger } from "../../debug/logger.ts";
import { getTeamMemPath } from "./paths.ts";
import { scanForSecrets } from "./secret-scanner.ts";
import { inferMemoryType, normalizeMemoryDesc } from "../store.ts";
import { memoryFilename } from "../paths.ts";
import { MEMORY_LIMITS, type MemoryType } from "../types.ts";
import { readMemoryFrontmatter, enumerateMemoryFiles } from "../scan.ts";
import { buildTruncatedIndex } from "../index-budget.ts";
import { memoryAge, memoryAgeDays } from "../freshness.ts";

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
function serialize(
  key: string,
  value: string,
  description: string,
  type: MemoryType,
  now: number,
): string {
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
  if (!existsSync(dir)) return;
  // 缺陷 9：枚举、排序、预算全部与私有侧同口径。
  // ① **递归**：旧实现平铺 `readdir`，子目录里的团队记忆字节在本地、却不进索引 ——
  //    私有侧 P1-6 早已统一成递归，团队侧是漏掉的那条线；
  // ② **新的在前**：截断时留下的是最近改过的（与私有侧 `updatedAt` 降序同义，团队记忆
  //    没有 updatedAt 字段，取 mtime）；
  // ③ **200 条 / 25KB 真字节、行边界截断、超限告警**：走 `buildTruncatedIndex`。
  //    旧实现无上限，而这份索引整份进静态前缀，团队记忆越多每轮付得越多。
  const files = (await listTeamMemoryFiles(dir)).sort();
  const heads: Array<{ line: string; mtimeMs: number; rel: string }> = [];
  for (const rel of files) {
    try {
      const full = join(dir, rel);
      const [text, st] = await Promise.all([readFile(full, "utf8"), stat(full)]);
      // P2-13：与私有侧共用同一个 frontmatter 读取口径。这里曾用裸 `/^name:/m`
      // 全文匹配（连 frontmatter 块都不限定），正文里任何一行以 `name:` 开头
      // 都会被当成记忆名 —— 团队记忆是别人写的文件，格式假设只能更宽不能更窄。
      const fm = readMemoryFrontmatter(text);
      const name = fm.name || basename(rel).replace(/\.md$/, "");
      // 读侧也过归一化：既有旧文件的 frontmatter 里可能已存着 `## 标题`（本次修复前
      // 写入的），重建索引时剥掉，否则旧数据的陈述句标题会一直漏进注入侧索引。
      const desc = normalizeMemoryDesc(fm.description, "");
      heads.push({
        line: `- [${name}](${rel})${desc ? ` — ${desc}` : ""}`,
        mtimeMs: st.mtimeMs,
        rel,
      });
    } catch {
      /* 跳过损坏文件 */
    }
  }
  // 同 mtime 按路径字典序：结果不随文件系统顺序漂移
  heads.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const { content, entryCount, truncated } = buildTruncatedIndex(
    heads.map((h) => h.line),
    TEAM_INDEX_HEADER,
  );
  if (truncated) {
    getLogger().warn(
      "TEAMMEM",
      `团队记忆索引已截断：${heads.length} 条只列出 ${entryCount} 条（${dir}）——` +
        `未列出的记忆在磁盘上但不进上下文`,
    );
  }
  await writeFile(join(dir, INDEX_FILE), content, "utf8");
}

/** 团队索引表头（与私有侧 `# Memory Index` 区分，注入侧据此认出团队段）。 */
const TEAM_INDEX_HEADER = ["# 团队共享记忆", ""] as const;

/**
 * 枚举团队记忆条目（相对路径，递归）。
 *
 * 在私有侧 `enumerateMemoryFiles` 的 skip 名单之上，再排除团队线特有的两类：
 * 点文件（同步状态 `.sync-state.json` 之类的同级产物，以及编辑器临时文件）
 * 与冲突副本 `*.conflict-*.md`（缺陷 8 另议，这里保持旧口径不进索引）。
 * 同步侧 `readEntries` 用同一个函数 —— 「进索引」与「参与同步」必须是同一批文件。
 */
export async function listTeamMemoryFiles(dir: string): Promise<string[]> {
  const all = await enumerateMemoryFiles(dir);
  return all.filter((rel) => {
    const segs = rel.split(/[\\/]/);
    if (segs.some((seg) => seg.startsWith("."))) return false;
    if (segs[segs.length - 1].includes(".conflict-")) return false;
    return true;
  });
}

/**
 * 给团队索引行补「多久之前」（缺陷 9 ③）。私有侧 `annotateIndexAges` 按 key 查
 * `updatedAt`；团队记忆没有内存条目，按索引行里的链接（相对路径）取文件 mtime。
 */
async function annotateTeamIndexAges(dir: string, text: string): Promise<string> {
  const now = Date.now();
  const lines = await Promise.all(
    text.split("\n").map(async (line) => {
      const m = line.match(/^(\s*-\s*\[[^\]]*\]\(([^)]*)\))(.*)$/);
      if (!m) return line;
      try {
        const st = await stat(join(dir, m[2]));
        if (memoryAgeDays(st.mtimeMs, now) < 1) return line;
        return `${m[1]} ⏳${memoryAge(st.mtimeMs, now)}${m[3]}`;
      } catch {
        return line; // 索引里有、磁盘上没有：不编造年龄
      }
    }),
  );
  return lines.join("\n");
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
    // 缺陷 9 ③：新鲜度判据此前到不了团队记忆
    const annotated = await annotateTeamIndexAges(dir, text);
    return `#### 团队记忆（目录：${dir}）\n\n${annotated}`;
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
    } catch {
      /* watcher 未启动时忽略 */
    }

    return { success: true, filePath };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}
