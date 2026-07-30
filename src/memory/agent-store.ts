/**
 * 按 agent 类型的持久记忆读取器（G13，对标 claude-code agentMemory.ts）
 *
 * 每个垂直子代理类型（code-review / security-audit / …）有独立记忆目录，
 * 跨会话沉淀领域经验。spawn 该类型子代理时，把它累积的 MEMORY.md 索引注入
 * 其系统提示词——让子代理带着"历史积累的领域经验"开工。
 *
 * 目录布局见 paths.ts：~/.sid-code/memory/agents/<agentType>/MEMORY.md
 *
 * 与 MemoryStore（global/project 私有 scope）、team/store（团队共享 scope）并列的
 * 第四条记忆线：agent-scope。单独走这里，不侵入 MemoryStore 的 global/project 语义。
 * 读取失败 / 目录或索引不存在 / 内容为空均返回 null（无 agent 记忆时行为不变）。
 */

import { existsSync } from "fs";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import {
  getAgentMemoryIndexPath,
  ensureAgentMemPath,
  getAgentMemPath,
  memoryFilename,
  stripMemoryTypePrefix,
} from "./paths.ts";
import { MEMORY_LIMITS, isMemoryType, type MemoryType } from "./types.ts";
import { normalizeMemoryDesc } from "./store.ts";
import { getLogger } from "../debug/logger.ts";

/**
 * 读取某 agent 类型累积的 MEMORY.md 索引内容（供 system prompt 注入）。
 * 目录或索引不存在、读失败、内容为空均返回 null。
 *
 * ─── 2026-07-30：与私有/团队索引同步修掉「只给文件名不给目录」 ───
 *
 * 索引行是 `- [key](file.md)` 的裸相对链接，而注入文案只说「用 Read 读取对应文件」。
 * 子代理无从知道目录在哪，只能猜路径然后 Read 报「文件不存在」——主会话已实测过
 * 这个失败（模型把文件名拼到了 `~/.sid-code/memory/`）。
 *
 * 这里比主会话更严重：agent 记忆目录是 `~/.sid-code/memory/agents/<sanitized-type>/`,
 * 那个 slug 经过 sanitizeAgentType 变换，**子代理根本无法从 agentType 反推出来**。
 * 所以必须显式给出绝对目录。
 */
export async function getAgentIndexContent(agentType: string): Promise<string | null> {
  const indexPath = getAgentMemoryIndexPath(agentType);
  if (!existsSync(indexPath)) return null;
  try {
    const text = (await Bun.file(indexPath).text()).trim();
    if (!text) return null;
    return `#### ${agentType} 记忆（目录：${getAgentMemPath(agentType)}）\n\n${text}`;
  } catch {
    return null;
  }
}

/**
 * 构建"该 agent 类型历史积累记忆"的系统提示词片段。
 * 注入格式对齐主会话记忆注入（buildMemorySystemPrompt）：用 system-reminder
 * 包装，注明这是该 agent 类型跨会话沉淀的领域经验，需要完整内容时用 Read 读取。
 *
 * @param agentType    子代理类型（用于文案标注）
 * @param indexContent 该类型 MEMORY.md 索引内容（为 null / 空时返回空串）
 * @returns 可直接追加到子代理系统提示词的片段；无记忆时返回空串
 */
export function buildAgentMemorySection(
  agentType: string,
  indexContent: string | null,
): string {
  if (!indexContent || !indexContent.trim()) return "";
  return `<system-reminder>
### ${agentType} 类型的历史积累记忆（跨会话）

下面是「${agentType}」这一类子代理在过往会话中沉淀的领域经验索引。这些是同类任务反复积累的可复用知识（常见坑、领域约定、有效方法）。开始任务前先参考。
需要某条记忆的完整内容时，用 Read 工具读取「段标题里的目录 + 链接里的文件名」拼成的绝对路径。
注意：括号里的文件名才是真实文件名，方括号里的 key 可能与文件名不同，**不要拿 key 拼路径**。

${indexContent}
</system-reminder>`;
}

/**
 * 便捷组合：读取 agent 类型记忆索引并构建注入片段。
 * 无记忆时返回空串（调用方拼接空串即为"行为不变"）。
 */
export async function buildAgentMemoryInjection(agentType: string): Promise<string> {
  const indexContent = await getAgentIndexContent(agentType);
  return buildAgentMemorySection(agentType, indexContent);
}

// ===== 写入端（G13 补齐：此前只有读取/注入，缺生产端导致目录永不被填充） =====

const AGENT_INDEX_FILE = "MEMORY.md";
const AGENT_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/** 一条 agent 记忆的最小结构（写入用） */
interface AgentMemoryEntry {
  key: string;
  value: string;
  description: string;
  type: MemoryType;
  updatedAt: number;
  filename: string;
}

/** 启发式推断记忆类型（与 store.inferMemoryType 同口径，避免跨模块耦合单独维护一份） */
function inferAgentMemoryType(key: string, value: string): MemoryType {
  const hay = `${key} ${value}`.toLowerCase();
  if (/(http|url|dashboard|ticket|jira|链接|地址|文档|wiki)/.test(hay)) return "reference";
  if (/(偏好|喜欢|不要|always|prefer|纠正|反馈|以后都|风格|约定|坑|注意)/.test(hay)) return "feedback";
  if (/(用户|我是|角色|工程师|expert|新手|背景|profile)/.test(hay)) return "user";
  return "project";
}

/** 从记忆 .md 文件正文解析出 description / type / name（供重建索引） */
function parseAgentMemoryHead(text: string, filename: string): { key: string; description: string; type: MemoryType } {
  const m = text.match(AGENT_FRONTMATTER_RE);
  let name: string | undefined;
  let description = "";
  let type: MemoryType | undefined;
  let body = text;
  if (m) {
    for (const line of m[1].split("\n")) {
      const fm = line.match(/^(\w+):\s*(.+?)\s*$/);
      if (!fm) continue;
      const k = fm[1];
      const v = fm[2].trim().replace(/^["']|["']$/g, "");
      if (k === "name") name = v;
      else if (k === "description") description = v;
      else if (k === "type" && isMemoryType(v)) type = v as MemoryType;
    }
    body = text.replace(AGENT_FRONTMATTER_RE, "").trim();
  }
  // key 归一化：剥掉 name 里冗余的类型前缀（与私有记忆同规则）。
  // 不剥的话索引方括号会出现 `project_xxx` 这种自带分类的 key，而文件真实分类由
  // 文件名前缀决定，两者可以矛盾 —— 私有记忆里实测 7 条残留有 4 条矛盾。
  // 这里在解析处收口，读写两侧都走 parseAgentMemoryHead，一处修即全覆盖。
  const rawKey = name || filename.replace(/\.md$/, "");
  const key = stripMemoryTypePrefix(rawKey);
  // 读侧同样过归一化：既有旧文件的 frontmatter 里可能已存着 `## 标题`，
  // 重建索引时必须在这里剥掉，否则旧数据的陈述句标题会一直漏进索引。
  description = normalizeMemoryDesc(description, body);
  return { key, description, type: type ?? inferAgentMemoryType(key, body) };
}

/** 序列化 agent 记忆为 .md 文件内容（与 store.serializeMemoryFile 同书式） */
function serializeAgentMemoryFile(entry: AgentMemoryEntry, createdAt: number): string {
  return [
    "---",
    `name: ${entry.key}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    `created: ${createdAt}`,
    `updated: ${entry.updatedAt}`,
    "---",
    "",
    entry.value,
    "",
  ].join("\n");
}

/**
 * 重建某 agent 类型目录的 MEMORY.md 索引（扫描目录下所有 .md 记忆文件）。
 * 与 store.writeIndex 同书式：`# Memory Index` + `- [key](file) — desc`，带行数/字节截断保护。
 */
async function rebuildAgentIndex(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const heads: { key: string; description: string; filename: string; mtimeMs: number }[] = [];
  for (const filename of names) {
    if (!filename.endsWith(".md") || filename === AGENT_INDEX_FILE) continue;
    const filePath = join(dir, filename);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const text = await Bun.file(filePath).text();
      const head = parseAgentMemoryHead(text, filename);
      heads.push({ key: head.key, description: head.description, filename, mtimeMs: st.mtimeMs });
    } catch {
      // 跳过损坏文件
    }
  }

  const indexPath = join(dir, AGENT_INDEX_FILE);
  if (heads.length === 0) return;

  heads.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const lines: string[] = ["# Memory Index", ""];
  let truncated = false;
  for (const h of heads) {
    if (lines.length >= MEMORY_LIMITS.INDEX_MAX_LINES) {
      truncated = true;
      break;
    }
    const desc = (h.description || "").replace(/\n/g, " ").slice(0, 150);
    lines.push(`- [${h.key}](${h.filename}) — ${desc}`);
  }
  let content = lines.join("\n") + "\n";
  if (content.length > MEMORY_LIMITS.INDEX_MAX_BYTES) {
    content = content.slice(0, MEMORY_LIMITS.INDEX_MAX_BYTES);
    truncated = true;
  }
  if (truncated) {
    content += "\n> ⚠️ 索引已截断（超过上限），部分记忆未列出。\n";
  }
  await Bun.write(indexPath, content);
}

/**
 * 写入一条 agent 类型记忆（G13 生产端）。
 *
 * 布局：~/.sid-code/memory/agents/<agentType>/<type>_<slug>.md + MEMORY.md 索引。
 * 与 MemoryStore（global/project）、team/store（团队）并列的第四条记忆线——agent scope。
 * 写入后重建索引，使 getAgentIndexContent 能立即读到（打通「写→读→注入」闭环）。
 *
 * @param agentType 子代理类型（用于定位目录，做 slug 安全化）
 * @param key       记忆键名
 * @param value     记忆内容
 * @param opts      可选类型/描述
 */
export async function saveAgentMemory(
  agentType: string,
  key: string,
  value: string,
  opts?: { type?: MemoryType; description?: string },
): Promise<void> {
  const log = getLogger();
  const cleanKey = key.replace(/\n/g, " ").trim();
  let cleanValue = value.trim();
  if (!cleanKey || !cleanValue) throw new Error("key/value 不能为空");
  if (cleanValue.length > MEMORY_LIMITS.ENTRY_MAX_CHARS) {
    cleanValue = cleanValue.slice(0, MEMORY_LIMITS.ENTRY_MAX_CHARS);
    log.warn("MEMORY", `agent 记忆值超长，已截断: ${cleanKey}`);
  }

  const dir = ensureAgentMemPath(agentType);
  const type = opts?.type ?? inferAgentMemoryType(cleanKey, cleanValue);
  // 与私有/团队索引同一根治点：desc 回退取正文首行时剥离 markdown 标题等结构标记，
  // 避免 `## 陈述句` 进索引后被模型误当用户输入（见 store.ts normalizeMemoryDesc）。
  const description = normalizeMemoryDesc(opts?.description, cleanValue);
  const filename = memoryFilename(type, cleanKey);
  const now = Date.now();

  // 覆盖式写入（同名文件保留原 created）：先探测既有 created
  const filePath = join(dir, filename);
  let createdAt = now;
  if (existsSync(filePath)) {
    try {
      const existing = await Bun.file(filePath).text();
      const m = existing.match(AGENT_FRONTMATTER_RE);
      if (m) {
        const cm = m[1].match(/created:\s*(\d+)/);
        if (cm) createdAt = Number(cm[1]) || now;
      }
    } catch {
      // 读失败按新建处理
    }
  }

  const entry: AgentMemoryEntry = { key: cleanKey, value: cleanValue, description, type, updatedAt: now, filename };
  await Bun.write(filePath, serializeAgentMemoryFile(entry, createdAt));
  await rebuildAgentIndex(dir);
  log.info("MEMORY", `✓ agent 记忆已保存 [${agentType}] ${cleanKey}`);
}

/** 供权限校验：某 agent 类型的记忆目录绝对路径 */
export function agentMemoryDir(agentType: string): string {
  return getAgentMemPath(agentType);
}
