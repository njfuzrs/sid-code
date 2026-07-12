/**
 * 会话持久化（双模式：JSONL 事件溯源 + 旧 JSON 兼容）
 *
 * 新会话使用 JSONL 追加写入（崩溃安全、增量写入）
 * 旧会话仍可从 JSON 格式加载（向后兼容）
 *
 * 对齐 Claude Code 状态持久化差距分析（docs/bugfixes/todo/对齐cc/状态持久化与检查点.md）：
 * - P2-12 格式版本号：session_start 记录带 version 字段，供未来格式迁移判断
 * - P0-3 缓冲写入：per-file 内存队列 + 100ms 批量 flush，替代逐条 appendFileSync
 * - P2-9 延迟文件创建：startSession 不立即建文件，首条真实记录时才 materialize
 * - P0-1 parentUuid 链表 + P2-11 环检测：每条记录带 uuid/parentUuid，恢复时链式重建
 * - P2-8 compact boundary：仅作为诊断性元数据保留（isBoundary），**不**用于截断恢复内容——
 *   与 CC 不同，sid-code 已有明确修复历史（B2 方案A / bug②）证明"压缩处截断恢复"会
 *   导致 resume 后历史丢失，此处刻意不复现该问题，见 parseSessionJsonl 顶部说明。
 */

import type { Message } from "../llm/types.ts";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, appendFileSync, createReadStream } from "fs";
import { createInterface } from "readline";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import { generateSessionId } from "./id.ts";

/** 当前会话数据格式版本。1.0=旧版全量 JSON；2.0=JSONL 事件溯源（无链）；3.0=+uuid/parentUuid 链 */
const CURRENT_VERSION = "3.0";
/** 早期 JSONL（session_start 无 version 字段）的隐含版本号 */
const LEGACY_JSONL_VERSION = "2.0";

/** 记录公共字段：uuid 链（P0-1） */
interface ChainFields {
  /** 本条记录的唯一 ID */
  uuid: string;
  /** 前一条记录的 uuid；null 表示链头（新会话起点） */
  parentUuid: string | null;
}

/** JSONL 记录类型（调用方视角，不含链字段——链字段由 appendRecord 统一盖戳） */
type SessionRecordInput =
  | { type: "session_start"; version: string; sessionId: string; model: string; provider: string; cwd: string; timestamp: string }
  | { type: "user_message"; message: Message; timestamp: string }
  | { type: "assistant_message"; message: Message; timestamp: string }
  | { type: "tool_result"; message: Message; timestamp: string }
  | { type: "context_compact"; summary: string; removedCount: number; timestamp: string; isBoundary?: boolean }
  | { type: "metadata"; key: string; value: unknown; timestamp: string }
  | { type: "session_end"; totalCostUSD: number; totalMessages: number; timestamp: string };

/** 落盘记录形态：调用方记录 + 链字段 */
type SessionRecord = SessionRecordInput & ChainFields;

/** 关键记录类型：绕过写入缓冲，立即同步落盘（P0-3）——这两类记录界定文件生命周期
 *  （list()/loadLatest() 依赖它们存在与否判断会话边界），必须第一时间可见。 */
const CRITICAL_RECORD_TYPES = new Set<SessionRecordInput["type"]>(["session_start", "session_end"]);

/** 会话数据（兼容旧格式） */
export interface SessionData {
  version: string;
  id: string;
  model: string;
  provider: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  kind?: "main" | "subagent";
  projectHash?: string;
  directories?: string[];
  summary?: string;
  /** 会话元数据（metadata 记录的累积结果，用于恢复 goalState 等运行时状态） */
  metadata?: Record<string, unknown>;
}

/** 会话摘要数据 */
export interface SessionSummary {
  sessionId: string;
  summary: string;
  model: string;
  provider: string;
  createdAt: string;
  messageCount: number;
  estimatedTokens: number;
}

// ─────────────────────────────────────────────────────────────
// P0-3：模块级共享写入缓冲。
//
// 所有 SessionStore 实例共享同一份队列与 exit 钩子——app.ts 恢复会话时会创建
// 多个只读 SessionStore 实例（用于 load/loadSummary），若每实例各自注册
// process.on("exit")，长会话/多次 resume 场景下会累积监听器
// （触发 MaxListenersExceededWarning）。改为模块级单例彻底避免。
// ─────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 100;
const pendingWrites = new Map<string, string[]>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** P1-6：JSONL 文件超过此字节数时走流式逐行读取（避免"巨串 + 行数组"双份内存尖峰）。
 *  4MB 约对应数千条记录，小于此值一次性读取更快、开销可忽略。 */
const JSONL_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** 把某个文件已排队的内容一次性落盘（同步 appendFileSync，批量合并 syscall） */
function flushFile(filePath: string): void {
  const timer = flushTimers.get(filePath);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(filePath);
  }
  const queue = pendingWrites.get(filePath);
  if (!queue || queue.length === 0) return;
  pendingWrites.set(filePath, []);
  try {
    appendFileSync(filePath, queue.join(""));
  } catch (e) {
    getLogger().error("SESSION", `批量写入会话失败: ${filePath} - ${(e as Error)?.message}`);
  }
}

/** 非关键记录：入队，由 100ms 定时器批量落盘 */
function enqueueWrite(filePath: string, chunk: string): void {
  let queue = pendingWrites.get(filePath);
  if (!queue) {
    queue = [];
    pendingWrites.set(filePath, queue);
  }
  queue.push(chunk);
  if (!flushTimers.has(filePath)) {
    const timer = setTimeout(() => flushFile(filePath), FLUSH_INTERVAL_MS);
    // 不阻塞进程自然退出（配合下方 exit 钩子兜底同步落盘）
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    flushTimers.set(filePath, timer);
  }
}

/** 关键记录：先把该文件已排队内容按序落盘，再同步写入本条——保证顺序且立即可见 */
function writeCritical(filePath: string, chunk: string): void {
  flushFile(filePath);
  try {
    appendFileSync(filePath, chunk);
  } catch (e) {
    getLogger().error("SESSION", `关键记录写入失败: ${filePath} - ${(e as Error)?.message}`);
  }
}

/**
 * 立即同步刷新所有待写入内容。
 *
 * 两个调用场景：
 * 1. 读路径（load / getAllSessionFiles）读取前调用，保证读到的内容与刚写入的保持
 *    一致——缓冲只是「延迟落盘」，绝不能让读者看到落后于内存状态的数据。
 * 2. 进程退出前兜底（见下方 process.on("exit")）。
 */
export function flushPendingSessionWrites(): void {
  for (const filePath of [...pendingWrites.keys()]) {
    flushFile(filePath);
  }
}

// 进程退出兜底：无论从哪条路径 process.exit()，退出前把缓冲区清空落盘。
// flushFile 内部用 appendFileSync（同步），"exit" 事件处理器只能做同步工作，天然匹配。
// 覆盖不到 SIGKILL/硬崩溃——与 CC 自身的设计取舍一致，这一点做不到更好。
process.on("exit", flushPendingSessionWrites);

export class SessionStore {
  private sessionDir: string;
  private summaryDir: string;
  private currentFile: string | null = null;
  /** P2-9：文件是否已实际创建（写入过至少一条记录）。startSession 后为 false，
   *  直到首条真实记录（appendMessage/appendMetadata/appendCompact）才置真。 */
  private materialized = false;
  /** P2-9：延迟写入的 session_start 记录，materialize 时补写在最前面 */
  private pendingStart: Extract<SessionRecord, { type: "session_start" }> | null = null;
  /** P0-1：当前链尾 uuid，null 表示尚无记录或链头 */
  private lastUuid: string | null = null;

  constructor() {
    this.sessionDir = sidPaths.sessions();
    this.summaryDir = join(this.sessionDir, "summaries");
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
    if (!existsSync(this.summaryDir)) {
      mkdirSync(this.summaryDir, { recursive: true });
    }
  }

  /** 开始新会话（JSONL 模式）。P2-9：不立即创建文件，延迟到首条真实记录时才 materialize，
   *  避免"打开即退出"的会话留下只有 session_start 的空文件噪音。 */
  startSession(sessionId: string, model: string, provider: string, cwd: string): void {
    this.currentFile = join(this.sessionDir, `${sessionId}.jsonl`);
    this.materialized = false;
    const uuid = crypto.randomUUID();
    this.pendingStart = {
      type: "session_start",
      version: CURRENT_VERSION,
      sessionId,
      model,
      provider,
      cwd,
      timestamp: new Date().toISOString(),
      uuid,
      parentUuid: null,
    };
    // 链尾提前指向待写入的 session_start，即便文件还未 materialize，
    // 后续记录的 parentUuid 也能正确指向它（写入顺序由 ensureMaterialized 保证）。
    this.lastUuid = uuid;
  }

  /**
   * 续写已有会话（B6：resume 场景）。
   *
   * 与 startSession 的区别：把 currentFile 指向**已存在**的旧 jsonl，且**不写 session_start**。
   * 这样 `-c` / `--resume` 恢复的会话，后续新消息会续写进原文件，而非另开新文件导致历史碎片化。
   * 若旧文件不存在（极端情况，如手动删了 jsonl），回退为新建会话以免丢失后续写入。
   *
   * Bug3 桥接：resume 时 SessionStore 续写旧 id 的 jsonl，而 TraceCollector 用本进程
   * 新生成的 id 写 trajectories/sessions/{新id}/（避免跨进程冲突，见 app.ts restoreSession）。
   * 两套存储 sessionId 不一致会导致无法关联。此处传入本进程 id（traceSessionId），
   * 续写时落一条 metadata 记录，使旧会话 jsonl 能反查到对应的 trajectory 目录。
   *
   * P0-1：续写前先读取旧文件尾部记录的 uuid，作为本进程新记录的链尾起点——
   * 否则续写的记录会以 parentUuid=null 另起一条断链，恢复时无法串联成一条完整历史。
   */
  resumeSession(
    sessionId: string,
    model: string,
    provider: string,
    cwd: string,
    traceSessionId?: string,
  ): void {
    const jsonlPath = join(this.sessionDir, `${sessionId}.jsonl`);
    if (existsSync(jsonlPath)) {
      this.currentFile = jsonlPath;
      this.materialized = true;
      this.pendingStart = null;
      this.lastUuid = this.loadTailUuid(jsonlPath);
      getLogger().info("SESSION", `会话续写已就绪（resume）: ${sessionId}`);
    } else {
      // 旧 jsonl 不存在（可能是从旧 JSON 格式恢复的会话）→ 新建 jsonl 续写
      getLogger().info("SESSION", `resume 会话无 jsonl，新建续写文件: ${sessionId}`);
      this.startSession(sessionId, model, provider, cwd);
    }
    // 记录本进程 trajectory 目录 id，桥接两套存储（仅当 id 与会话 id 不同才有意义）
    if (traceSessionId && traceSessionId !== sessionId) {
      this.appendMetadata("trace_session_id", traceSessionId);
    }
  }

  /** 当前会话转录文件（jsonl）路径；未启动会话时为 null。
   *  P2-9：会话已 startSession 但尚未写入任何真实消息时，此路径指向"即将创建"的文件，
   *  文件本身可能还不存在——调用方若要立即读取内容，应先触发一次 append 或自行判断存在性。 */
  getCurrentFile(): string | null {
    return this.currentFile;
  }

  /** 追加消息（增量写入） */
  appendMessage(message: Message): void {
    if (!this.currentFile) return;
    const type = message.role === "user" ? "user_message"
      : message.role === "assistant" ? "assistant_message"
      : "tool_result";
    this.appendRecord({ type, message, timestamp: new Date().toISOString() } as SessionRecordInput);
  }

  /**
   * 记录上下文压缩事件。
   *
   * isBoundary 始终为 true，但**仅作诊断性元数据保留**，parseSessionJsonl 恢复时不会
   * 因它而截断历史——sid-code 已有明确的修复历史（B2 方案A）：早期实现在压缩处清空
   * messages，导致 resume 后历史丢失（bug②）。压缩效果本就已反映在后续写入的真实
   * 消息流里（sid-code 的压缩多为截断/管道压缩而非稳定的 LLM 摘要，未必有可靠摘要
   * 文本兜底），保留完整真实消息流才是"最忠实、无损"的恢复方式。见 parseSessionJsonl
   * 顶部注释与 rebuildRecordOrder 的实现说明。
   */
  appendCompact(summary: string, removedCount: number): void {
    if (!this.currentFile) return;
    this.appendRecord({
      type: "context_compact",
      summary,
      removedCount,
      timestamp: new Date().toISOString(),
      isBoundary: true,
    } as SessionRecordInput);
  }

  /** 记录元数据变更 */
  appendMetadata(key: string, value: unknown): void {
    if (!this.currentFile) return;
    this.appendRecord({ type: "metadata", key, value, timestamp: new Date().toISOString() } as SessionRecordInput);
  }

  /** 结束会话 */
  endSession(totalCostUSD: number, totalMessages: number): void {
    if (!this.currentFile) return;
    // P2-9：会话从未 materialize（没有任何真实消息）→ 无需落盘任何内容，直接重置状态，
    // 避免"打开即退出"留下空文件。
    if (!this.materialized) {
      this.currentFile = null;
      this.pendingStart = null;
      return;
    }
    this.appendRecord({
      type: "session_end",
      totalCostUSD,
      totalMessages,
      timestamp: new Date().toISOString(),
    } as SessionRecordInput);
    this.currentFile = null;
  }

  /** 保存会话（兼容旧接口，内部转为 JSONL 追加） */
  async save(session: SessionData): Promise<void> {
    const log = getLogger();
    session.version = CURRENT_VERSION;
    session.updatedAt = new Date().toISOString();

    // 如果已有 JSONL 文件在写入，跳过（消息已通过 appendMessage 增量写入）
    if (this.currentFile && existsSync(this.currentFile)) {
      log.debug("SESSION", `会话增量保存中: ${session.id}`);
      return;
    }

    // 回退到 JSON 全量保存（兼容未启动 JSONL 的场景）
    const filePath = join(this.sessionDir, `${session.id}.json`);
    await Bun.write(filePath, JSON.stringify(session, null, 2));
    const fileSize = statSync(filePath).size;
    const sizeStr = fileSize > 1024 * 1024
      ? `${(fileSize / 1024 / 1024).toFixed(1)}MB`
      : `${(fileSize / 1024).toFixed(1)}KB`;
    log.info("SESSION", `会话已保存: ${session.id} (${session.messages.length}条消息, ${sizeStr})`);
  }

  /** 加载会话（优先 JSONL，回退 JSON） */
  async load(id: string): Promise<SessionData | null> {
    const log = getLogger();

    // 优先尝试 JSONL 格式
    const jsonlPath = join(this.sessionDir, `${id}.jsonl`);
    if (existsSync(jsonlPath)) {
      // P0-3：读取前先把该文件的缓冲写入落盘，避免读到落后于内存状态的内容
      // （缓冲只延迟落盘时机，绝不能改变"读到的就是最新写入"这一语义）。
      flushFile(jsonlPath);
      const result = await this.loadFromJsonl(jsonlPath);
      if (result) {
        log.info("SESSION", `会话已加载(JSONL): ${id} (${result.messages.length}条消息)`);
        return result;
      }
    }

    // 回退到旧 JSON 格式
    const jsonPath = join(this.sessionDir, `${id}.json`);
    if (!existsSync(jsonPath)) return null;

    try {
      const content = await Bun.file(jsonPath).text();
      const data = JSON.parse(content) as SessionData;
      if (!data.version) data.version = "0.0";
      log.info("SESSION", `会话已加载(JSON): ${id} (${data.messages.length}条消息)`);
      return data;
    } catch {
      return null;
    }
  }

  /** 获取最近一次会话 */
  async loadLatest(): Promise<SessionData | null> {
    if (!existsSync(this.sessionDir)) return null;

    const files = readdirSync(this.sessionDir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        path: join(this.sessionDir, f),
        mtime: statSync(join(this.sessionDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    const latest = files[0].name;
    const id = latest.replace(/\.(json|jsonl)$/, "");
    return this.load(id);
  }

  /** 列出所有会话 */
  async list(): Promise<{ id: string; updatedAt: string; messageCount: number }[]> {
    if (!existsSync(this.sessionDir)) return [];

    const files = readdirSync(this.sessionDir).filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"));
    const sessions: { id: string; updatedAt: string; messageCount: number }[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const id = file.replace(/\.(json|jsonl)$/, "");
      if (seen.has(id)) continue;
      seen.add(id);

      try {
        const data = await this.load(id);
        if (data?.id && data.updatedAt && data.messages) {
          sessions.push({
            id: data.id,
            updatedAt: data.updatedAt,
            messageCount: data.messages.length,
          });
        }
      } catch {
        // 跳过损坏的会话文件
      }
    }

    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 保存会话摘要 */
  async saveSummary(summary: SessionSummary): Promise<void> {
    const filePath = join(this.summaryDir, `${summary.sessionId}.json`);
    await Bun.write(filePath, JSON.stringify(summary, null, 2));
  }

  /** 加载会话摘要 */
  async loadSummary(sessionId: string): Promise<SessionSummary | null> {
    const filePath = join(this.summaryDir, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;

    try {
      const content = await Bun.file(filePath).text();
      return JSON.parse(content) as SessionSummary;
    } catch {
      return null;
    }
  }

  /** 构建恢复消息 */
  static buildResumeMessage(summary: string): string {
    return `本次会话是从之前的对话中恢复的，之前的对话因上下文窗口限制而中断。
以下是之前对话的摘要：

${summary}

请从上次中断的地方继续，无需再次询问。`;
  }

  /**
   * 缺口 B：构建轻量续接标记（无摘要场景用）。
   *
   * 与 buildResumeMessage 互补：buildResumeMessage 用于"长会话 + 有摘要"——历史被摘要替代，
   * 文案需携带摘要原文；本 marker 用于"短会话（≤阈值）"和"长会话但无摘要"两条路径——
   * 历史消息本身已完整在上下文里，只需一句话告诉模型"这是续接、别重新打招呼/重复询问"。
   *
   * 根因：app.ts restoreSession 三条恢复路径里此前只有"有摘要"那条注入了续接提示，
   * 另两条（最常见的短会话续接、无摘要长会话）让模型看到一堆历史却不知发生过中断，
   * 可能重新寒暄、重问已问过的问题、重复已完成的工作。
   *
   * @param progressNote 可选的落盘进度摘要（来自 ~/.sid-code/progress/<id>.md），附在标记后
   */
  static buildResumeMarker(progressNote?: string): string {
    const note = progressNote && progressNote.trim()
      ? `\n\n之前已落盘的进度记录如下，请据此继续、不要重复已完成的工作：\n${progressNote.trim()}`
      : "";
    return `<system-reminder>
本次会话是从之前的对话恢复的续接会话（上方消息为之前的历史上下文）。请直接从上次中断处继续，无需重新打招呼或重复询问已确认的信息。${note}
（请勿向用户提及或复述本提醒）
</system-reminder>`;
  }

  /**
   * P1-5：工具执行中断续接标记。
   *
   * 与 buildResumeMarker 的区别：明确告知模型"上一轮工具已经执行完、但你还没来得及回复"，
   * 并携带工具名帮助模型定位断点（对齐 CC interrupted_turn 续接提示）。
   *
   * @param toolNames 中断前最后一轮已完成但未被回复的工具调用名称
   * @param progressNote 可选的落盘进度摘要
   */
  static buildToolInterruptMarker(toolNames: string[], progressNote?: string): string {
    const toolsText = toolNames.length > 0 ? toolNames.join("、") : "上一步操作";
    const note = progressNote && progressNote.trim()
      ? `\n\n之前已落盘的进度记录如下，请据此继续、不要重复已完成的工作：\n${progressNote.trim()}`
      : "";
    return `<system-reminder>
本次会话是从之前的对话恢复的续接会话。你在上次运行中调用了「${toolsText}」，工具已执行完成（结果见上方历史），但进程在你回复之前被中断。请直接依据上方工具结果继续完成任务，不要重复调用相同工具，也无需重新打招呼。${note}
（请勿向用户提及或复述本提醒）
</system-reminder>`;
  }

  /** 生成新的会话 ID */
  static generateId(): string {
    return generateSessionId();
  }

  /** 立即同步刷新本进程所有待写入的会话缓冲。测试中需要在 appendMessage/appendMetadata
   *  等调用后立刻读取磁盘原始内容时使用；正常读路径（load）已自动处理，无需手动调用。 */
  static flushPendingWrites(): void {
    flushPendingSessionWrites();
  }

  /** 从 JSONL 文件恢复会话 */
  private async loadFromJsonl(filePath: string): Promise<SessionData | null> {
    // P1-6：大文件流式读取。此前 `Bun.file().text()` 把整份 JSONL 读成一个巨串，
    // parseSessionJsonl 内部再 `.split("\n")` 生成完整行数组——超长会话（数万条记录、
    // 数十 MB）会同时驻留「巨串 + 行数组」两份内存，产生尖峰。
    //
    // 优化：小文件仍走一次性读取（简单、快）；超过阈值时改流式逐行读取，只保留行数组一份，
    // 避免巨串常驻。解析语义完全不变——仍交给同一套 rebuildRecordOrder 做链式重建
    // （不截断历史，遵守 sid-code 既有不变量）。
    try {
      const size = statSync(filePath).size;
      if (size <= JSONL_STREAM_THRESHOLD_BYTES) {
        const content = readFileSync(filePath, "utf-8");
        return parseSessionJsonl(content);
      }
      const lines = await readJsonlLinesStreaming(filePath);
      getLogger().info("SESSION", `大会话流式读取: ${filePath}（${(size / 1024 / 1024).toFixed(1)}MB, ${lines.length} 行）`);
      return parseSessionJsonlLines(lines);
    } catch (e) {
      // statSync/流式读取任何环节失败都回退到一次性读取，保证鲁棒（不因优化引入新失败面）。
      getLogger().warn("SESSION", `流式读取失败，回退整读: ${filePath} - ${(e as Error)?.message}`);
      try {
        const content = readFileSync(filePath, "utf-8");
        return parseSessionJsonl(content);
      } catch {
        return null;
      }
    }
  }

  /** P0-1：读取已存在 jsonl 尾部记录的 uuid，用于 resume 时续接链尾。
   *  旧格式（无 uuid）或读取失败时返回 null——新记录将以 parentUuid=null 另起链头，
   *  是可接受的降级（不影响 messages 内容恢复，只影响链的连续性）。 */
  private loadTailUuid(filePath: string): string | null {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        try {
          const rec = JSON.parse(lines[i]);
          return typeof rec.uuid === "string" ? rec.uuid : null;
        } catch {
          continue;
        }
      }
    } catch {
      /* 文件不存在或不可读 */
    }
    return null;
  }

  /** P2-9：确保文件已实际创建；首次调用时把延迟的 session_start 记录补写在最前面。 */
  private ensureMaterialized(): void {
    if (this.materialized || !this.currentFile) return;
    this.materialized = true;
    if (this.pendingStart) {
      writeCritical(this.currentFile, JSON.stringify(this.pendingStart) + "\n");
      this.pendingStart = null;
    }
  }

  /** 追加一条 JSONL 记录：materialize 文件 → 盖上 uuid 链戳 → 按关键性选择同步/缓冲写入 */
  private appendRecord(partial: SessionRecordInput): void {
    if (!this.currentFile) return;
    this.ensureMaterialized();

    const uuid = crypto.randomUUID();
    const record: SessionRecord = { ...partial, uuid, parentUuid: this.lastUuid };
    this.lastUuid = uuid;

    const line = JSON.stringify(record) + "\n";
    if (CRITICAL_RECORD_TYPES.has(record.type)) {
      writeCritical(this.currentFile, line);
    } else {
      enqueueWrite(this.currentFile, line);
    }
  }
}

/**
 * 解析 JSONL 会话内容为 SessionData（单一真相源）。
 *
 * 抽出为模块级纯函数，供 SessionStore.loadFromJsonl 与 session/utils.ts 的
 * getAllSessionFiles 共用——避免后者用 `JSON.parse(整个文件)` 解析多行 JSONL
 * 而恒抛错、把所有 jsonl 会话误判为损坏文件（Bug1）。
 *
 * P0-1/P2-11：若记录带 uuid 链（v3+ 格式），由 rebuildRecordOrder 从物理尾行沿
 * parentUuid 反向重建，天然获得环检测（P2-11）与"抗物理交叉写入"两个效果——多进程
 * 意外同时 append 同一文件时（如重复 resume 同一会话），只有与链尾在同一条 parentUuid
 * 链上的记录会被采纳，外部分支的物理行被跳过，避免把两段不相关对话拼接成一份语义
 * 错乱的历史喂给模型。无 uuid 字段的旧格式文件（v2 及更早）保持原有线性解析，零回归。
 *
 * 注意：即便记录了 compact boundary（context_compact.isBoundary），也**不会**据此截断
 * 回溯——sid-code 的既有不变量是"resume 永不丢失真实历史"（B2 方案A 已修复的 bug②：
 * 早期实现在压缩处截断过，导致 resume 后历史被清空）。boundary 信息仍会被解析出来，
 * 供未来诊断/展示使用，但不参与"是否继续回溯"的判断。这是相对 CC 原设计的刻意偏离。
 *
 * @param content JSONL 文件全文（一行一条记录）
 * @returns 解析出的 SessionData；无 session_start 行时返回 null
 */
export function parseSessionJsonl(content: string): SessionData | null {
  const lines = content.trim().split("\n").filter(Boolean);
  return parseSessionJsonlLines(lines);
}

/**
 * P1-6：从"已切分好的 JSONL 行数组"解析会话（parseSessionJsonl 与流式读取路径共用核心）。
 * 与 parseSessionJsonl 的唯一区别是入参已是行数组（流式读取时逐行 push 得到，无需巨串），
 * 解析语义完全一致。
 *
 * @param lines 非空 JSONL 行数组（每行一条记录；调用方已过滤空行）
 * @returns 解析出的 SessionData；无 session_start 行时返回 null
 */
export function parseSessionJsonlLines(lines: string[]): SessionData | null {
  if (lines.length === 0) return null;

  const orderedRecords = rebuildRecordOrder(lines);

  const messages: Message[] = [];
  const metadata: Record<string, unknown> = {};
  let sessionId = "";
  let model = "";
  let provider = "";
  let createdAt = "";
  let updatedAt = "";
  let version = LEGACY_JSONL_VERSION;

  for (const record of orderedRecords) {
    switch (record.type) {
      case "session_start":
        sessionId = record.sessionId;
        model = record.model;
        provider = record.provider;
        createdAt = record.timestamp;
        updatedAt = record.timestamp;
        // P2-12：v3+ 文件带 version 字段；v2 及更早无此字段，保持 LEGACY_JSONL_VERSION 兜底。
        if (typeof (record as { version?: string }).version === "string") {
          version = (record as { version: string }).version;
        }
        break;
      case "user_message":
      case "assistant_message":
      case "tool_result":
        messages.push(record.message);
        updatedAt = record.timestamp;
        break;
      case "metadata":
        metadata[record.key] = record.value;
        updatedAt = record.timestamp;
        break;
      case "context_compact":
        // B2 方案A：compact 记录退化为纯标记，**不清空 messages**（详见函数顶部说明）。
        updatedAt = record.timestamp;
        break;
      case "session_end":
        updatedAt = record.timestamp;
        break;
    }
  }

  if (!sessionId) return null;

  return {
    version,
    id: sessionId,
    model,
    provider,
    messages,
    createdAt,
    updatedAt,
    kind: metadata["kind"] as "main" | "subagent" | undefined,
    summary: metadata["summary"] as string | undefined,
    metadata,
  };
}

/**
 * 把物理行顺序的 JSONL 重建为"应当被采信"的记录顺序（P0-1 链式重建）。
 *
 * - 新格式（尾行带 uuid）：从物理尾行沿 parentUuid 反向回溯到链头（parentUuid=null），
 *   过程中用 seenUuids 检测环（P2-11）——一旦发现环立即停止，防止死循环。
 * - 旧格式（尾行无 uuid，或全部行都无法解析出合法尾行）：回退为线性解析全部行，
 *   逐行 try/catch 跳过损坏行，与改造前行为完全一致，零回归。
 */
function rebuildRecordOrder(lines: string[]): SessionRecord[] {
  let tailIdx = -1;
  let tail: (SessionRecord & Record<string, unknown>) | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      tail = JSON.parse(lines[i]);
      tailIdx = i;
      break;
    } catch {
      continue;
    }
  }

  if (!tail || typeof (tail as unknown as { uuid?: unknown }).uuid !== "string") {
    // 旧格式或全部行都损坏 → 线性解析兜底
    const records: SessionRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return records;
  }

  const chain: SessionRecord[] = [tail];
  const seenUuids = new Set<string>([tail.uuid]);
  let expectedParentUuid: string | null = tail.parentUuid ?? null;

  for (let i = tailIdx - 1; i >= 0 && expectedParentUuid !== null; i--) {
    let rec: (SessionRecord & Record<string, unknown>) | null = null;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!rec || rec.uuid !== expectedParentUuid) continue; // 物理交叉写入的外部分支记录，跳过

    if (seenUuids.has(rec.uuid)) {
      getLogger().warn("SESSION", `检测到会话记录链出现环（uuid=${rec.uuid}），提前截断恢复内容`);
      break;
    }
    seenUuids.add(rec.uuid);
    chain.push(rec);
    expectedParentUuid = rec.parentUuid ?? null;
  }

  chain.reverse();
  return chain;
}

/**
 * P1-6：流式逐行读取 JSONL，返回非空行数组（不构造整份巨串）。
 *
 * 用 Node createReadStream + readline 逐行消费，只把非空行 push 进数组——相比
 * `Bun.file().text()` + `split("\n")` 少一份巨串常驻内存。返回的行数组交给
 * parseSessionJsonlLines 走与整读完全一致的解析/链重建逻辑（语义不变）。
 *
 * 注意：这里仍会把所有行收进内存数组——因为链式重建需要按 uuid 回溯，无法真正做到
 * "只读尾部"（尾行的 parentUuid 可能指向文件任意位置）。本优化消除的是"巨串"这一份
 * 额外拷贝，而非行数组本身；对数十 MB 文件已能显著削峰。
 */
function readJsonlLinesStreaming(filePath: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const lines: string[] = [];
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    stream.on("error", reject);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      // 与 split("\n").filter(Boolean) 对齐：去掉两端空白后仍非空才收（跳过空行）。
      if (line.trim()) lines.push(line);
    });
    rl.on("error", reject);
    rl.on("close", () => resolve(lines));
  });
}
