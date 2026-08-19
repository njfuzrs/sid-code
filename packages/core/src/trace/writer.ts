/**
 * 轨迹文件写入器
 * 负责本地文件的创建、追加写入和目录管理。
 * 输出三个文件：session.traj / raw.jsonl / events.jsonl
 *
 * 设计原则：
 * - 所有写入操作 try-catch，失败时仅记录警告不抛异常（采集不影响正常使用）
 * - session.traj 使用原子覆盖写入（每次 AfterModel 后重建）
 * - raw.jsonl / events.jsonl 使用追加写入（崩溃安全）
 * - **所有落盘内容统一经 maskSensitiveData 脱敏**（见下）
 *
 * 脱敏（SEC-AUDIT-2026-07-19 P2）：
 *   轨迹是本仓的核心资产——它会被 /trace 读、被 uploader 上传、被贴进 issue 和 PR。
 *   而它记录的恰好是「完整请求/响应对」，包含 Authorization 头、模型吐出的 key、
 *   用户粘贴的凭证。此前这里**零脱敏**，凭证随轨迹一起落盘并可能出境。
 *
 *   本文件的 6 个写入方法（traj / raw.jsonl / events.jsonl / errors.jsonl /
 *   messages.json / session-summary.json）是全部落盘路径的收口点，统一在这里过一遍脱敏，
 *   而不是让每个调用方自己记得脱敏——"每个调用方都要记得"这种约定必然会漏。
 *   （注释原本写"5 个"却有 6 个方法，errors.jsonl 因此长期漏脱敏。数量写进注释就要与代码对账。）
 *
 *   masked 值形如 `Bearer abc********2345`：保留头尾便于对照排查（"是不是我那个 key"），
 *   中间抹掉。替换只产生 `*`，不破坏 JSON 转义，落盘后仍可 JSON.parse / jq。
 *
 * 脱敏必须结构化（2026-08-07 事故修复）：
 *   上面那句「落盘后仍可 JSON.parse」曾经是**假的**。纯文本脱敏对「当前位置是 JSON
 *   数字还是字符串」一无所知，信用卡号规则命中了 `"total_cost_usd": 0.4428123456780257`
 *   的 16 位尾数，把它改写成 `0.4428********0257`——`*` 是真实字节，整份 session.traj
 *   `JSON.parse` 失败，`/trace` 与 `trace-digest` 单文件损坏即整体 rc=1。
 *
 *   所以本文件所有 JSON 落盘一律走 `maskSensitiveJson`（只脱敏字符串值/键名，
 *   数字字面量绝不触碰），再叠一道 `assertParsable` 自校验：脱敏产物解析不了就
 *   **落原始内容 + 告警**，绝不把损坏数据写进盘。宁可少脱一次敏，也不能毁掉轨迹本身
 *   ——轨迹损坏是静默的、不可逆的，且会连带打死诊断入口。
 */

import { join } from "node:path";
import { mkdirSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { getLogger } from "../debug/logger.ts";
import { maskSensitiveJson } from "../permission/sensitive.ts";

/** hook 事件记录（写入 events.jsonl 的行格式） */
export interface HookEvent {
  /** 事件名称 */
  event: string;
  /** 会话 ID */
  session_id: string;
  /** 时间戳 */
  timestamp: string;
  /** 工作目录 */
  cwd?: string;
  /** 事件附加数据 */
  data?: Record<string, unknown>;
}

/** raw.jsonl 中的请求/响应对（对齐 claude-trace proxy.py 的 _append_raw_jsonl） */
export interface RawJsonlEntry {
  /** 时间戳 */
  timestamp: string;
  /** 序号（从 1 开始） */
  index: number;
  /** 模型名称 */
  model: string;
  /** 请求侧数据 */
  request: {
    model: string;
    /** system prompt（仅首行有值） */
    system?: unknown;
    /** 完整 messages（仅首行有值） */
    messages?: unknown[];
    /** 工具定义列表（仅首行有值） */
    tools?: unknown[];
    /** 增量 messages（非首行使用） */
    new_messages?: unknown[];
    /** 完整 messages 数量（非首行时记录，便于调试） */
    _messages_count?: number;
  };
  /** 响应侧数据 */
  response: {
    content: unknown[];
    stop_reason: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
  };
  /** 顶层冗余：usage（便于 merger.py 快速读取） */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  /** 顶层冗余：stop_reason */
  stop_reason: string;
  /** 是否为不完整响应 */
  is_partial: boolean;
  /** compact_boundary 信息（压缩事件发生时设置） */
  compact_boundary?: {
    summary: string;
    messageCountBefore: number;
    timestamp: string;
  };
}

/**
 * 脱敏 + 落盘前自校验：脱敏产物必须仍是合法 JSON，否则退回原文并告警。
 *
 * 这是最后一道闸门。上游 `maskSensitiveJson` 已从结构上保证不碰数字，本函数防的是
 * 「未来又有人加了个纯文本规则、或结构化路径出了别的意外」——落盘损坏的代价远高于
 * 少脱一次敏（损坏是静默且不可逆的，还会打死 /trace 与 trace-digest）。
 *
 * @param content 原始 JSON 文本
 * @param indent 原始序列化缩进（需与调用方 JSON.stringify 一致）
 * @param what 文件名，仅用于告警文案
 */
function maskJsonSafe(content: string, indent: number, what: string): string {
  let masked: string;
  try {
    masked = maskSensitiveJson(content, indent);
  } catch (err) {
    getLogger().warn("TRACE", `${what} 脱敏异常，落原始内容: ${err}`);
    return content;
  }
  try {
    JSON.parse(masked);
    return masked;
  } catch (err) {
    // 脱敏把 JSON 弄坏了 —— 这是 bug，必须响，不能静默降级
    getLogger().warn(
      "TRACE",
      `${what} 脱敏后 JSON 不可解析（脱敏逻辑有 bug，已回退为原始内容，` +
        `可能包含未脱敏凭证）: ${err}`,
    );
    return content;
  }
}

export class TraceWriter {
  private sessionDir: string;
  private initialized = false;
  private readonly recordRawPayloads: boolean;

  /**
   * @param opts.recordRawPayloads 是否落 raw.jsonl 的**内容型**记录（默认 true）。
   *   传 `false` 时 {@link appendRaw} 静默跳过，但 {@link appendRawJsonl} 仍可写
   *   ——两者的区别见 appendRaw 的注释，那是本开关唯一容易搞错的地方。
   */
  constructor(baseDir: string, sessionId: string, opts?: { recordRawPayloads?: boolean }) {
    this.sessionDir = join(baseDir, "sessions", sessionId);
    // `!== false`：undefined（既有的两参构造，含 20+ 处测试）与 null 都按"记录"处理，
    // 只有显式 false 才关。默认开是兼容性要求。
    this.recordRawPayloads = opts?.recordRawPayloads !== false;
  }

  /** 内容型 raw 记录是否启用（供 collector 决定要不要构造大对象） */
  isRecordingRawPayloads(): boolean {
    return this.recordRawPayloads;
  }

  /** 获取输出目录路径 */
  getSessionDir(): string {
    return this.sessionDir;
  }

  /** 确保输出目录存在 */
  private ensureDir(): boolean {
    if (this.initialized) return true;
    try {
      if (!existsSync(this.sessionDir)) {
        mkdirSync(this.sessionDir, { recursive: true });
      }
      this.initialized = true;
      return true;
    } catch (err) {
      getLogger().warn("TRACE", `创建输出目录失败: ${this.sessionDir} - ${err}`);
      return false;
    }
  }

  /**
   * 写入/覆盖 session.traj
   * 使用 Bun.write() 原子写入，每次 AfterModel 后重建
   */
  async writeSessionTraj(content: string): Promise<void> {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "session.traj");
      await Bun.write(filePath, maskJsonSafe(content, 2, "session.traj"));
    } catch (err) {
      getLogger().warn("TRACE", `写入 session.traj 失败: ${err}`);
    }
  }

  /**
   * 追加一行到 raw.jsonl
   * 每次 AfterModel 完成 pair 后调用
   */
  appendRawJsonl(line: string): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "raw.jsonl");
      // jsonl 每行独立 JSON，indent=0 保持单行
      const safe = maskJsonSafe(line, 0, "raw.jsonl");
      appendFileSync(filePath, safe.endsWith("\n") ? safe : safe + "\n");
    } catch (err) {
      getLogger().warn("TRACE", `追加 raw.jsonl 失败: ${err}`);
    }
  }

  /**
   * 追加一行到 events.jsonl
   * 每个 hook 事件触发时调用
   */
  appendEventsJsonl(line: string): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "events.jsonl");
      const safe = maskJsonSafe(line, 0, "events.jsonl");
      appendFileSync(filePath, safe.endsWith("\n") ? safe : safe + "\n");
    } catch (err) {
      getLogger().warn("TRACE", `追加 events.jsonl 失败: ${err}`);
    }
  }

  // ─── 便捷方法：序列化 + 写入 ───

  /**
   * 序列化并写入 session.traj
   * @param traj - 完整轨迹对象（包含 trajectory/history/info/metadata）
   */
  async writeTraj(traj: object): Promise<void> {
    const content = JSON.stringify(traj, null, 2);
    await this.writeSessionTraj(content);
  }

  /**
   * 序列化并追加一行到 raw.jsonl
   * @param entry - 请求/响应对数据
   *
   * ## 为什么开关拦在这里，而不是在 {@link appendRawJsonl}
   *
   * raw.jsonl 里有**两种形态的记录**，隐私属性完全不同：
   *
   * | 记录 | 内容 | 谁写 |
   * |---|---|---|
   * | `{type:"request_sent", index, model, msg_count, estimated_input_tokens}` | **无任何 prompt 原文**，只有计数 | `collector` 直接调 `appendRawJsonl` |
   * | 完整 pair（system prompt + messages + tools + 响应全文） | **全是原文** | 本函数 |
   *
   * 企业诉求是「不落 prompt 原文」，拦住后者就够了。而前者必须留着：
   * `collector.countExistingPairs()` 靠数「没有 type 字段的行」来续接会话的
   * index —— 两种记录一起关掉，续接就只剩 `metadata.json` 一条回退路，
   * 而那个文件**只有 uploader 会写**（实测全仓仅 `uploader.ts` 一处）。
   * 没配上传的用户续接会话时 index 会从 1 重号，与远端历史冲突。
   *
   * 换句话说：**这个开关关的是内容，不是文件**。想连文件都不要，
   * 关掉整个 trace 即可（那会连带失去 `/trace` 排查能力，是另一个取舍）。
   */
  appendRaw(entry: RawJsonlEntry): void {
    if (!this.recordRawPayloads) return;
    const line = JSON.stringify(entry);
    this.appendRawJsonl(line);
  }

  /**
   * 序列化并追加一行到 events.jsonl
   * @param event - hook 事件数据
   */
  appendEvent(event: HookEvent): void {
    const line = JSON.stringify(event);
    this.appendEventsJsonl(line);
  }

  /**
   * 追加一行到 errors.jsonl
   * 任何被 engine/queryLoop/fallback catch 的异常都应落盘于此
   *
   * 脱敏（2026-08-07 补漏）：本方法此前是 6 个落盘路径里**唯一没过脱敏的**，
   * 而文件头注释却写着「本文件的 5 个写入方法是全部落盘路径的收口点」——数错了一个，
   * 于是它被漏掉。错误对象最容易带凭证（异常消息常把请求头/URL 原样拼进去）。
   */
  appendErrorsJsonl(line: string): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "errors.jsonl");
      const safe = maskJsonSafe(line, 0, "errors.jsonl");
      appendFileSync(filePath, safe.endsWith("\n") ? safe : safe + "\n");
    } catch (err) {
      getLogger().warn("TRACE", `追加 errors.jsonl 失败: ${err}`);
    }
  }

  /**
   * 序列化并追加一行到 errors.jsonl
   * @param entry - 错误事件数据
   */
  appendError(entry: object): void {
    const line = JSON.stringify(entry);
    this.appendErrorsJsonl(line);
  }

  /**
   * 写入/覆盖 messages.json — D3-1 崩溃验尸快照。
   *
   * 落实 CLAUDE.md 评测纪律不变量第 1 条「transcript 必落盘」到真实交互退出路径。
   * 此前崩溃 session 只有 metadata.json，无完整消息历史，无法验尸（如孤儿 tool_use 现场）。
   *
   * @param snapshot 完整消息历史快照对象（含 messages + 退出归因）
   */
  writeMessagesSnapshot(snapshot: object): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "messages.json");
      writeFileSync(filePath, maskJsonSafe(JSON.stringify(snapshot, null, 2), 2, "messages.json"));
    } catch (err) {
      getLogger().warn("TRACE", `写入 messages.json 失败: ${err}`);
    }
  }

  /**
   * 写入/覆盖 session-summary.json — 优化 2：批量分诊入口。
   *
   * 固化的是 digest（唯一事实源）在 SessionEnd 时算好的瘦身结论，而非在 collector
   * 里另起一套摘要逻辑（否则会与 digest 的 20+ 条异常规则漂移出两套结果）。
   * 用途：用 jq 过滤 sessions 下所有 session-summary.json（如 errors>0）一键批量筛问题会话。
   *
   * @param summary 瘦身后的会话摘要对象
   */
  writeSessionSummary(summary: object): void {
    if (!this.ensureDir()) return;
    try {
      const filePath = join(this.sessionDir, "session-summary.json");
      writeFileSync(
        filePath,
        maskJsonSafe(JSON.stringify(summary, null, 2), 2, "session-summary.json"),
      );
    } catch (err) {
      getLogger().warn("TRACE", `写入 session-summary.json 失败: ${err}`);
    }
  }
}
