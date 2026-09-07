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
// P1-7：索引截断口径的单一事实源（此前这里有一份同样三处口径错的副本）。
import { buildTruncatedIndex } from "./index-budget.ts";
// P1-8：agent 记忆线此前整条无 secret 闸门；判据与 save_memory / 私有记忆守卫同源。
import { getSharedSecretRedactHook } from "../llm/hooks/secret-redact.ts";
// P1-12 指标 ③：防线触发计数。
import { logMemoryGuard } from "../analytics/events.ts";
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
export function buildAgentMemorySection(agentType: string, indexContent: string | null): string {
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
  if (/(偏好|喜欢|不要|always|prefer|纠正|反馈|以后都|风格|约定|坑|注意)/.test(hay))
    return "feedback";
  if (/(用户|我是|角色|工程师|expert|新手|背景|profile)/.test(hay)) return "user";
  return "project";
}

/** 从记忆 .md 文件正文解析出 description / type / name（供重建索引） */
function parseAgentMemoryHead(
  text: string,
  filename: string,
): { key: string; description: string; type: MemoryType } {
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
  // P1-7：截断口径走 index-budget.ts 的共享实现。
  // 这里**曾经有一份逐字符雷同的副本**，三个口径（表头挤占条数配额 / 拿 char 数当字节 /
  // 硬切出半行链接后再追加警告顶破上限）与 store.ts 一模一样。只修 store 会留下一份
  // 「已知坏的副本」，而它服务子代理跨会话记忆、更少有人看，坏得更久。
  const entryLines = heads.map((h) => {
    const desc = (h.description || "").replace(/\n/g, " ").slice(0, 150);
    return `- [${h.key}](${h.filename}) — ${desc}`;
  });
  const { content, entryCount, truncated } = buildTruncatedIndex(entryLines);
  if (truncated) {
    getLogger().warn(
      "MEMORY",
      `agent 记忆索引已截断：${heads.length} 条只列出 ${entryCount} 条（${dir}）——` +
        `未列出的记忆在磁盘上但不进上下文`,
    );
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

  // ─── P1-8：agent 记忆线此前**整条没有 secret 闸门** ───
  //
  // 四条记忆线里 save_memory（任意 scope）、team store、team 目录 write/edit、
  // team push 都有闸门，唯独这里 `grep -n 'secret|detect|scanFor' agent-store.ts`
  // 零命中。而 agent 记忆的写入方是**子代理**（同样是无人监督的 LLM），
  // 内容来自它这一轮看到的对话与工具输出——报错栈里的连接串正是最常见的来源。
  //
  // 判据与 `save_memory` / 私有记忆守卫**同一个实现**（getSharedSecretRedactHook），
  // 刻意不另立一套：同一个代理换条路就能绕过的闸门等于没有闸门。
  // 抛错而非静默跳过：调用方（tool/memory.ts 的 agent 分支）会把它转成工具错误回给模型，
  // 让模型知道「这条没存成，因为含凭证」——静默丢弃会让模型以为存好了。
  {
    const hits = getSharedSecretRedactHook().detect(cleanValue);
    if (hits.length > 0) {
      const categories = Array.from(new Set(hits.map((h) => h.category))).join(", ");
      log.warn("MEMORY", `✗ 拒绝保存含 secret 的 agent 记忆 [${agentType}] ${cleanKey}`);
      // P1-12 指标 ③：防线触发计数（不记 key、不记内容、不记 agentType —— 都是用户数据）
      logMemoryGuard({ kind: "secret_rejected", via: "agent_store", scope: "agent" });
      throw new Error(
        `检测到内容包含敏感信息 (${categories})，拒绝写入 agent 记忆。` +
          `凭证应放在 .env / 环境变量，运行时经 process.env 读取，不要写入记忆。`,
      );
    }
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

  const entry: AgentMemoryEntry = {
    key: cleanKey,
    value: cleanValue,
    description,
    type,
    updatedAt: now,
    filename,
  };
  await Bun.write(filePath, serializeAgentMemoryFile(entry, createdAt));
  await rebuildAgentIndex(dir);
  log.info("MEMORY", `✓ agent 记忆已保存 [${agentType}] ${cleanKey}`);
}

/** 供权限校验：某 agent 类型的记忆目录绝对路径 */
export function agentMemoryDir(agentType: string): string {
  return getAgentMemPath(agentType);
}
