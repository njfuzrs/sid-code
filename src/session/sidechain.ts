/**
 * 子代理 sidechain 持久化（P2-10，对齐 Claude Code AgentTool sidechain）
 *
 * 主会话历史落在 `sessions/<sessionId>.jsonl`；子代理（SubAgent）的多轮内部对话此前
 * 完全是内存态——被 kill 后无法单独恢复、只能从头重跑。本模块给每个子代理开一份独立的
 * sidechain JSONL：`sessions/<sessionId>-<agentId>.jsonl`，与主会话同目录、按文件名前缀
 * 归属主会话。
 *
 * 设计取舍（相对主会话 store.ts 的轻量化）：
 * - 复用主会话相同的 JSONL 事件溯源思路（session_start / assistant_message / tool_result
 *   / metadata），但**不引入 uuid/parentUuid 链**——子代理对话是单线程顺序推进（无并行
 *   分支、无 fork），线性追加已足够，恢复时按写入顺序还原即可。
 * - 直接 appendFileSync 落盘（无 100ms 缓冲队列）：子代理每轮才写一次、写入频率低，
 *   且被 kill 时缓冲队列反而会丢最后一轮——即时同步写对"抗中断恢复"更稳。
 * - 完成/失败时写一条 sidechain_end（status），恢复时据此过滤掉已正常结束的 sidechain，
 *   只把「未见 sidechain_end」的视为中断、可恢复。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { currentProjectSessionDir, resolveSessionFileAcrossProjects } from "./store.ts";
import { getLogger } from "../debug/logger.ts";
import type { ContentBlock } from "../llm/types.ts";

/** sidechain 记录类型（子代理视角，线性顺序，无链字段）。 */
export type SidechainRecord =
  | { type: "sidechain_start"; sessionId: string; agentId: string; agentType: string; description: string; model: string; timestamp: string }
  | { type: "message"; role: "user" | "assistant" | "tool"; content: ContentBlock[]; turn: number; timestamp: string }
  | { type: "sidechain_end"; status: "completed" | "failed" | "aborted"; timestamp: string };

/** 恢复扫描时返回的未完成 sidechain 概要。 */
export interface UnfinishedSidechain {
  agentId: string;
  agentType: string;
  description: string;
  /** 已记录的对话轮数（message 记录数） */
  messageCount: number;
  /** sidechain 文件绝对路径 */
  filePath: string;
}

/** 时间戳（sidechain 写入频率低，直接用 ISO 串；测试可注入固定值）。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 构造 sidechain 文件名：`<sessionId>-<agentId>.jsonl`（与主会话同目录）。 */
function sidechainFileName(sessionId: string, agentId: string): string {
  // agentId 可能含路径不安全字符（理论上不会，但防御性替换），避免越界写入。
  const safeAgent = agentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${sessionId}-${safeAgent}.jsonl`;
}

/**
 * P0-1：sidechain 必须与主会话文件同目录。会话已按项目分目录（sessions/<projectKey>/），
 * 主会话可能属于当前项目、也可能是恢复进来的他项目会话。
 * 解析规则：先跨项目找到主会话 jsonl，取其所在目录；找不到（如主会话尚未 materialize）
 * 回退到「当前项目」目录。
 */
function resolveSessionDirForSidechain(sessionId: string): string {
  const mainFile = resolveSessionFileAcrossProjects(sessionId);
  if (mainFile) return dirname(mainFile);
  return currentProjectSessionDir();
}

/**
 * 子代理 sidechain 写入器。每个子代理实例持有一个，生命周期与子代理执行一致。
 *
 * 用法：
 *   const w = new SidechainWriter(parentSessionId, agentId);
 *   w.start(agentType, description, model);   // 落 sidechain_start
 *   w.appendMessage("assistant", blocks, turn); // 每轮落 message
 *   w.end("completed");                        // 落 sidechain_end
 *
 * 任一写入失败都只 warn、不抛——sidechain 是增强能力，绝不能影响子代理主流程。
 */
export class SidechainWriter {
  private readonly filePath: string;
  private started = false;
  private ended = false;

  /** sidechain 文件所在目录（与主会话同项目目录）。 */
  private readonly dir: string;

  constructor(
    private readonly parentSessionId: string,
    private readonly agentId: string,
  ) {
    this.dir = resolveSessionDirForSidechain(parentSessionId);
    this.filePath = join(this.dir, sidechainFileName(parentSessionId, agentId));
  }

  /** sidechain 文件绝对路径（供测试/日志）。 */
  getFilePath(): string {
    return this.filePath;
  }

  private write(record: SidechainRecord): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8");
    } catch (e) {
      getLogger().warn("SIDECHAIN", `写入失败（不阻断子代理）: ${(e as Error)?.message}`);
    }
  }

  /** 落 sidechain_start（幂等：重复调用只写一次）。 */
  start(agentType: string, description: string, model: string): void {
    if (this.started) return;
    this.started = true;
    this.write({
      type: "sidechain_start",
      sessionId: this.parentSessionId,
      agentId: this.agentId,
      agentType,
      description,
      model,
      timestamp: nowIso(),
    });
  }

  /** 追加一条子代理对话消息（每轮结束时调用）。 */
  appendMessage(role: "user" | "assistant" | "tool", content: ContentBlock[], turn: number): void {
    if (this.ended) return;
    this.write({ type: "message", role, content, turn, timestamp: nowIso() });
  }

  /** 落 sidechain_end 标记子代理结束（幂等）。之后 appendMessage 不再写入。 */
  end(status: "completed" | "failed" | "aborted"): void {
    if (this.ended) return;
    this.ended = true;
    this.write({ type: "sidechain_end", status, timestamp: nowIso() });
  }
}

/**
 * P2-10：扫描某主会话名下所有 sidechain，返回「未正常结束（无 sidechain_end）」的列表。
 *
 * 恢复主会话时调用，据此给用户/模型提示"有 N 个子代理上次被中断、可恢复"。
 * 已正常结束（末尾有 sidechain_end）的 sidechain 视为无需恢复，跳过。
 * 解析失败/空文件的 sidechain 静默跳过（不阻断主会话恢复）。
 *
 * @param sessionId 主会话 id
 * @returns 未完成 sidechain 概要数组（按 agentId 排序，稳定输出）
 */
export function scanUnfinishedSidechains(sessionId: string): UnfinishedSidechain[] {
  // P0-1：sidechain 与主会话同项目目录，按主会话解析所在目录。
  const dir = resolveSessionDirForSidechain(sessionId);
  if (!existsSync(dir)) return [];

  const prefix = `${sessionId}-`;
  const result: UnfinishedSidechain[] = [];

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  for (const name of files) {
    if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) continue;
    const filePath = join(dir, name);
    try {
      if (statSync(filePath).size === 0) continue;
      const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
      if (lines.length === 0) continue;

      let agentType = "";
      let description = "";
      let agentId = "";
      let messageCount = 0;
      let ended = false;

      for (const line of lines) {
        let rec: SidechainRecord;
        try {
          rec = JSON.parse(line) as SidechainRecord;
        } catch {
          continue; // 跳过损坏行，与主会话解析策略一致
        }
        if (rec.type === "sidechain_start") {
          agentType = rec.agentType;
          description = rec.description;
          agentId = rec.agentId;
        } else if (rec.type === "message") {
          messageCount++;
        } else if (rec.type === "sidechain_end") {
          ended = true;
        }
      }

      // 正常结束的 sidechain 不算未完成，跳过。
      if (ended) continue;
      // 无 sidechain_start（文件损坏或只写了 message）时用文件名兜底 agentId。
      if (!agentId) agentId = name.slice(prefix.length, -".jsonl".length);

      result.push({ agentId, agentType, description, messageCount, filePath });
    } catch {
      // 单个 sidechain 读取失败不影响其余，跳过。
      continue;
    }
  }

  result.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return result;
}

/**
 * 删除指定目录下某主会话名下所有 sidechain 文件。
 * 返回删除的文件数。失败静默（best-effort 清理）。
 *
 * P0-1：cleanup 已知会话所在项目目录（entry.dirPath），直接在该目录删，避免全局扫描。
 */
export function cleanupSidechainsInDir(dir: string, sessionId: string): number {
  if (!existsSync(dir)) return 0;
  const prefix = `${sessionId}-`;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) continue;
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch { /* 单个删除失败不影响其余 */ }
    }
  } catch { /* 目录读取失败返回已删除计数 */ }
  return removed;
}

/**
 * 删除某主会话名下所有 sidechain 文件（会话清理时调用，避免孤儿 sidechain 堆积）。
 * 返回删除的文件数。失败静默（best-effort 清理）。
 *
 * P0-1：自动解析主会话所在项目目录后删除。
 */
export function cleanupSidechains(sessionId: string): number {
  return cleanupSidechainsInDir(resolveSessionDirForSidechain(sessionId), sessionId);
}
