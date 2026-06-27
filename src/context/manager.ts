/**
 * 上下文管理器
 * 管理对话消息历史、token 估算、自动压缩、持久化输出管理
 */

import type { Message } from "../llm/types.ts";
import { MessageValidator } from "./validator.ts";
import { estimateTextTokens } from "./token.ts";
import { ToolOutputMaskingService, TOOL_RESULT_CLEARED_MESSAGE } from "./tool-output-masking.ts";
import { persistLargeOutput, isPersistedReference } from "./tool-result-storage.ts";
import { getLogger, getSessionMetrics } from "../debug/index.ts";
import {
  checkMessageHistoryIntegrity,
  describeIntegrityViolation,
} from "../agent/message-invariants.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSidTempDir } from "../utils/temp-dir.ts";
import { REATTACH_PLAN_PREFIX, REATTACH_ORIGIN } from "../query/compact/reattach-markers.ts";

/** 持久化输出阈值（对标 Claude Code 30000 字符，可通过 SID_OUTPUT_THRESHOLD 环境变量覆盖） */
const OUTPUT_THRESHOLD = parseInt(process.env.SID_OUTPUT_THRESHOLD ?? "30000", 10);
// 保留最近 N 个大输出，旧的清理掉。
// P1-3（缓解信息蒸发）：由 3 提到 6——根因 4 实证单文件被读 18 次、窗口越读越碎（200→50→30→20→15）。
// 旧值 3 过于激进，模型读过的文件几轮后即被清成占位符，被迫"读→蒸发→重读"。
const KEEP_RECENT_OUTPUTS = parseInt(process.env.SID_KEEP_RECENT_OUTPUTS ?? "6", 10);
// CLEARED_MARKER 已迁移到 tool-output-masking.ts 的 TOOL_RESULT_CLEARED_MESSAGE 统一导出

/** 压缩前的工具输出预算（token） */
const COMPRESSION_TOOL_OUTPUT_BUDGET = 50_000;
/** 保留最近对话的比例 */
const COMPRESSION_PRESERVE_RATIO = 0.3;

/** 截断结果 */
export interface TruncationResult {
  /** 截断后的文本（用于上下文） */
  truncated: string;
  /** 完整输出保存的文件路径（null 表示未截断） */
  savedPath: string | null;
}

/**
 * 9.3：把 tool_use.input 概括为一行摘要，用于被清理占位符的"重读指引"。
 * 优先取关键字段（file_path / path / command / pattern / url / query），
 * 否则回退到 JSON 序列化前 100 字符。空 input 返回空串。
 */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const keyFields = ["file_path", "path", "command", "pattern", "url", "query", "prompt"];
  for (const k of keyFields) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 100 ? `${k}=${v.slice(0, 100)}…` : `${k}=${v}`;
    }
  }
  try {
    const json = JSON.stringify(obj);
    return json.length > 100 ? `${json.slice(0, 100)}…` : json;
  } catch {
    return "";
  }
}

/**
 * 已调用的 Skill 记录（Task 3：压缩时保留 Skill 上下文）
 * 对齐 Claude Code addInvokedSkill：Skill prompt 是模型正确执行任务的关键上下文，
 * 压缩时必须重新注入，否则模型会"忘记"应遵循的工作流。
 */
export interface InvokedSkill {
  /** Skill 名称 */
  name: string;
  /** Skill prompt 内容 */
  content: string;
  /** 调用时的消息索引 */
  invokedAt: number;
}

/** 压缩级别 */
export type CompactionLevel =
  | "none"       // 不需要压缩
  | "soft"       // 建议压缩（工具输出遮罩即可）
  | "hard"       // 需要摘要压缩
  | "emergency"; // 紧急：强制截断，防止 API 报错

/**
 * 压缩阈值配置（绝对 buffer，单位 tokens）
 *
 * 对齐 claude-code 的绝对 buffer 策略（13K/20K/20K），适配 sid-code 多模型（32K~200K 窗口）：
 * - 对 ≥ 80K 窗口模型：三层渐进压缩全部生效
 * - 对 60-80K 窗口模型：仅 L3 紧急截断生效
 * - 对 ≤ 60K 小窗口模型：仅 L3 剩 10% 时触发轻量截断，前两层不触发（防治信息过早丢失）
 *
 * 旧值（百分比，已废弃）：soft=0.50 / hard=0.70 / emergency=0.94
 * 百分比在不同窗口模型下行为不可预测（32K 窗口 50%=16K 过早，200K 窗口 50%=100K 过晚）
 */
const BUFFER_THRESHOLDS = {
  /** 剩余 ≤ 80K tokens → 触发工具输出遮罩（仅 ≥ 80K 窗口模型生效） */
  masking: 80_000,
  /** 剩余 ≤ 60K tokens → 触发 LLM 摘要压缩（仅 ≥ 80K 窗口模型生效） */
  compression: 60_000,
  /** 剩余 ≤ 40K tokens → 紧急截断（保证最后 40K 内容不丢） */
  emergency: 40_000,
};
/** 小窗口模型阈值（window ≤ 60K tokens 时仅 emergency 截断生效，比例触发） */
const SMALL_WINDOW_EMERGENCY_RATIO = 0.90;

/** 上下文管理器配置 */
export interface ManagerOptions {
  maxTokens: number;        // 上下文窗口最大 token 数
  compactThreshold?: number; // 触发压缩的阈值比例（默认 0.7）
  /** 项目临时目录（用于工具输出落盘） */
  tempDir?: string;
}

export class Manager {
  private messages: Message[] = [];
  private systemPrompt: string = "";
  private maxTokens: number;
  private compactThreshold: number;
  private tempDir?: string;
  private sessionId?: string;
  private maskingService?: ToolOutputMaskingService;
  /**
   * 完整会话转录文件路径（Layer 2）：压缩后摘要里告知模型"压缩前的细节可在此查阅"。
   * 由上层（App）在会话持久化就绪后通过 setTranscriptPath 注入；未注入时为 undefined，
   * 转录路径提示自动省略，不影响其余压缩逻辑。
   */
  private transcriptPath?: string;
  /** 已调用的 Skill 记录（压缩时保留其 prompt 上下文） */
  private invokedSkills: InvokedSkill[] = [];
  /**
   * 估算校准因子（P1-7）：= 真实 inputTokens / 当时纯启发式估算值。
   * 每次 API 返回真实 usage 后用 recordActualTokens 平滑更新；
   * estimateTokens 输出 ×factor 收敛到真实口径。初值 1（未校准前不偏移）。
   */
  private calibrationFactor: number = 1;
  /** 是否已收到过至少一次真实 usage 校准（false 时 estimateTokens 不乘 factor） */
  private calibrated: boolean = false;
  /** 上一次 API 返回的真实输入 token 数（P1-6：compact 决策优先用它作锚点，而非纯字符估算） */
  private lastActualInputTokens: number = 0;
  /**
   * 工具定义的真实 token 数（EST-4）：由上层在工具就绪后通过 setToolSchemaTokens 注入。
   * 估算时优先用它，回退到 toolCount×80 粗估（schema 大/工具多时粗估明显偏低）。
   * null 表示尚未注入真实值。
   */
  private toolSchemaTokens: number | null = null;

  /**
   * 压缩互斥锁（§6 并发守卫）。true 表示有一个压缩流程正在执行。
   * 子代理并发压缩、Context Collapse 与 autoCompact 同时触发、手动 /compact 与自动压缩
   * 同时发生等场景下，acquireCompactLock 让只有第一个进入者执行，其余直接跳过，避免
   * 同一份消息历史被两条压缩路径竞态改写（产生孤儿配对 / 重复摘要）。
   */
  private isCompacting = false;

  /**
   * 可选 Plan 提供方（§3.3 压缩后 Plan 重注入）。
   * 由上层注入；提供时 compactWithSummary 会把活跃 Plan 正文重注入为消息，
   * 避免压缩后模型只剩 reminder 提示却看不到 Plan 具体步骤而偏离计划。
   */
  private planContentProvider: (() => string | null) | null = null;

  constructor(opts: ManagerOptions) {
    this.maxTokens = opts.maxTokens;
    this.compactThreshold = opts.compactThreshold ?? 0.7;
    this.tempDir = opts.tempDir;
  }

  /**
   * §6：尝试获取压缩锁。返回 true 表示成功（调用方可执行压缩），
   * 返回 false 表示已有压缩在进行中（调用方应跳过本次压缩）。
   * 配对使用：成功后必须在 try/finally 的 finally 中调用 releaseCompactLock。
   */
  acquireCompactLock(): boolean {
    if (this.isCompacting) return false;
    this.isCompacting = true;
    return true;
  }

  /** §6：释放压缩锁。 */
  releaseCompactLock(): void {
    this.isCompacting = false;
  }

  /** §6：当前是否有压缩流程正在执行。 */
  isCompactionInProgress(): boolean {
    return this.isCompacting;
  }

  /**
   * §3.3：注入 Plan 正文提供方。返回当前活跃 Plan 的正文（无活跃 Plan 返回 null）。
   * 由 App 接线（读 planManager 状态 + plan 文件）。压缩时用于把 Plan 正文重注入消息历史。
   */
  setPlanContentProvider(provider: (() => string | null) | null): void {
    this.planContentProvider = provider;
  }

  /**
   * 注入工具定义的真实 token 数（EST-4）。
   *
   * 上层在工具池就绪后（含 MCP 异步连接）序列化全部工具定义并估算其 token，
   * 调用此方法注入。此后 rawEstimateTokens 用真实值替代 toolCount×80 粗估，
   * 避免 schema 大/工具多时低估上下文占用、导致 compact 触发过晚。
   *
   * @param tokens 全部工具定义序列化后的估算 token 数；传 0 或负数视为未知，回退粗估。
   */
  setToolSchemaTokens(tokens: number): void {
    this.toolSchemaTokens =
      Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : null;
  }

  /**
   * 更新上下文窗口大小（运行中 /model 切换模型时调用）。
   *
   * maxTokens 此前仅构造时按初始模型窗口设定、之后只读。运行中切换到不同窗口的模型后，
   * shouldCompact / getCompactionLevel / Footer 上下文百分比仍用旧窗口作分母：
   * 1M→200k 方向会让百分比虚低 → 误判余量充足、放任上下文溢出（危险方向）；
   * 200k→1M 方向虚高 → 过早 compact。切模型时同步窗口可消除该失真。
   *
   * @param maxTokens 新模型的上下文窗口 token 数；非正值忽略（防御非法输入）。
   */
  setMaxTokens(maxTokens: number): void {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return;
    this.maxTokens = maxTokens;
  }

  /**
   * 用一次 API 调用返回的真实输入 token 数校准估算器（P1-6 + P1-7）。
   *
   * - **P1-7 校准回路**：记录"真实值 / 当时纯启发式估算值"的比值，用指数平滑（EMA, α=0.3）
   *   更新 calibrationFactor，使后续 estimateTokens 收敛到真实口径，偏差不再永久存在。
   * - **P1-6 锚点**：把真实 inputTokens 存为 lastActualInputTokens，供 estimateTokens 在
   *   "真实锚点 + 锚定后新增量估算"模式下计算，避免纯字符启发式低估导致 compact 触发过晚。
   *
   * @param actualInputTokens 上一次 API 返回的真实输入 token（已归一化为完整 prompt，即 promptTotal）。
   *   传 0 或负数（如本地模型无 usage）时跳过校准。
   * @param toolCount 当时的工具数量（与 estimateTokens 的入参一致，保证基线可比）
   */
  recordActualTokens(actualInputTokens: number, toolCount: number = 0): void {
    if (!Number.isFinite(actualInputTokens) || actualInputTokens <= 0) return;
    this.lastActualInputTokens = actualInputTokens;

    // 用未校准的纯启发式估算作分母（rawEstimateTokens），否则 factor 会自我反馈漂移
    const rawEstimate = this.rawEstimateTokens(toolCount);
    if (rawEstimate <= 0) return;

    const ratio = actualInputTokens / rawEstimate;
    // 防御异常比值（极端短会话 / 估算为 0 边界）：钳到合理区间 [0.3, 5]
    const clamped = Math.min(5, Math.max(0.3, ratio));
    if (!this.calibrated) {
      this.calibrationFactor = clamped;
      this.calibrated = true;
    } else {
      // EMA 平滑，α=0.3，兼顾收敛速度与抗抖动
      this.calibrationFactor = this.calibrationFactor * 0.7 + clamped * 0.3;
    }
  }

  /** 设置会话 ID（用于工具输出遮罩和持久化） */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.maskingService = new ToolOutputMaskingService(sessionId);
  }

  /**
   * 设置完整会话转录文件路径（Layer 2）。
   * 由 App 在 SessionStore 启动后注入（jsonl 落盘路径），供压缩摘要提示模型查阅压缩前细节。
   */
  setTranscriptPath(transcriptPath: string | undefined): void {
    this.transcriptPath = transcriptPath || undefined;
  }

  /** 获取完整会话转录文件路径（未注入返回 undefined）。 */
  getTranscriptPath(): string | undefined {
    return this.transcriptPath;
  }

  /**
   * 使真实 token 锚点失效（P1-6 锚点重置）。
   *
   * estimateTokens 取 max(校准估算, lastActualInputTokens) 作 compact 决策下界。
   * 压缩/截断后真实 prompt 骤降，但锚点仍停在压缩前的高值——若不重置，下一轮
   * compact 决策会被旧锚点钉死（刚压缩完又判定需压缩），导致重复压缩、误丢上下文。
   * 压缩消息的方法（emergencyTruncate / compactWithSummary / setMessages / clear）
   * 调用此方法清零锚点，让估算回落到校准后的纯启发式值，直到下次 recordActualTokens 重新锚定。
   */
  invalidateActualTokenAnchor(): void {
    this.lastActualInputTokens = 0;
  }

  /** 设置系统提示词 */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** 获取系统提示词 */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * 记录 Skill 调用（Skill 被 inline 执行后调用）
   * 压缩时这些 Skill 的 prompt 内容会被重新注入，避免模型遗忘工作流。
   * 同名 Skill 重复调用时更新为最新内容。
   */
  addInvokedSkill(name: string, content: string): void {
    const existing = this.invokedSkills.find((s) => s.name === name);
    if (existing) {
      existing.content = content;
      existing.invokedAt = this.messages.length;
      return;
    }
    this.invokedSkills.push({
      name,
      content,
      invokedAt: this.messages.length,
    });
  }

  /** 获取已调用的 Skill 列表 */
  getInvokedSkills(): InvokedSkill[] {
    return [...this.invokedSkills];
  }

  /** 添加消息（带验证） */
  addMessage(msg: Message): void {
    const log = getLogger();

    // 验证单条消息的基本格式
    if (!msg.content || msg.content.length === 0) {
      log.warn("CONTEXT", "尝试添加空内容消息，已忽略");
      return;
    }

    // 增量压缩：tool_result 内容在添加时即持久化到磁盘，防止上下文膨胀
    const sessionId = this.sessionId ?? "default";
    const compressed: Message = {
      ...msg,
      content: msg.content.map(block => {
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > OUTPUT_THRESHOLD) {
          log.debug("CONTEXT", `增量持久化 tool_result: ${block.content.length} → 磁盘`);
          const { reference } = persistLargeOutput(
            block.content,
            block.tool_use_id,
            "unknown", // tool_name 在 addMessage 时不可知，后续可从工具执行处注入
            sessionId,
            OUTPUT_THRESHOLD,
          );
          return { ...block, content: reference };
        }
        return block;
      }),
    };

    // 角色交替处理（P2-1 占位消息治理，对应根因 5.1）：
    // 旧实现遇到连续同角色时**插入** "[系统] 自动插入占位消息以保持角色交替" —— 实测 130 个会话被这条
    // 空洞占位污染上下文、稀释真实任务信息。新实现改为**合并**：把新消息的 content 追加到上一条同角色
    // 消息里，既维持 user/assistant 严格交替，又不丢任何真实内容（text / tool_use / tool_result），
    // 且天然保持 tool_use→tool_result 配对顺序，零污染。
    if (this.messages.length > 0) {
      const lastMsg = this.messages[this.messages.length - 1];
      if (lastMsg.role === compressed.role) {
        log.debug("CONTEXT", `角色未交替: 连续 ${compressed.role}，合并到上一条消息（不再插占位）`);
        this.messages[this.messages.length - 1] = {
          ...lastMsg,
          content: [...lastMsg.content, ...compressed.content],
          // 保留上一条的 _meta，新消息若带 _meta 则浅合并（reasoning_content 等以新值为准）
          _meta: compressed._meta || lastMsg._meta
            ? { ...lastMsg._meta, ...compressed._meta }
            : undefined,
        };
        return;
      }
    }

    this.messages.push(compressed);
  }

  /** 获取所有消息（发送给 LLM 前调用，会自动清理旧的大输出） */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * P1-3：从消息历史构建 tool_use_id → {toolName, filePath, inputSummary} 映射。
   * 用于（a）识别哪些大 tool_result 对应"正在编辑的文件"应豁免清理；
   *      （b）为被清理的占位符附带"重读指引"（9.3：含工具名 + input 摘要，精准而非通用文案）。
   */
  private buildToolUseIndex(messages: Message[]): Map<string, { toolName: string; filePath?: string; inputSummary?: string }> {
    const index = new Map<string, { toolName: string; filePath?: string; inputSummary?: string }>();
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          const input = (block.input ?? {}) as { file_path?: string; path?: string; command?: string };
          const filePath = input.file_path ?? input.path;
          index.set(block.id, { toolName: block.name, filePath, inputSummary: summarizeToolInput(block.input) });
        }
      }
    }
    return index;
  }

  /**
   * P1-3：判断某文件是否为"本任务正在编辑的活跃文件"。
   * 规则：历史中出现过对该文件的 write 或 edit（成功与否不区分，意图即视为活跃）。
   * 活跃文件的 read 大输出不清理——避免"改代码 → 输出被蒸发 → 被迫重读"的循环。
   */
  private collectActiveFiles(toolIndex: Map<string, { toolName: string; filePath?: string }>): Set<string> {
    const active = new Set<string>();
    for (const { toolName, filePath } of toolIndex.values()) {
      if (!filePath) continue;
      if (toolName === "write" || toolName === "edit") {
        active.add(filePath);
      }
    }
    return active;
  }

  /**
   * 获取清理后的消息列表（发送给 LLM 前调用）
   * 1. 应用工具输出遮罩（soft 级别压缩）
   * 2. 清理旧的大输出，只保留最近 N 个（P1-3：豁免活跃文件 + 占位符附重读指引）
   * 3. 验证消息格式
   * 4. 返回深拷贝，不影响原始消息
   */
  getCleanedMessages(): Message[] {
    const log = getLogger();

    // 先应用工具输出遮罩（如果启用）
    let cleaned = [...this.messages];
    if (this.maskingService) {
      const compactionLevel = this.getCompactionLevel();
      if (compactionLevel === "soft" || compactionLevel === "hard" || compactionLevel === "emergency") {
        cleaned = this.maskingService.mask(cleaned);
      }
    }

    // P1-3：构建 tool_use 索引 + 活跃文件集合（正在编辑的文件 read 输出豁免清理）
    const toolIndex = this.buildToolUseIndex(cleaned);
    const activeFiles = this.collectActiveFiles(toolIndex);

    // 找到所有大输出的位置（从后往前扫描），并标注是否豁免（活跃文件）+ 重读指引元信息
    const largeOutputPositions: {
      msgIdx: number;
      blockIdx: number;
      exempt: boolean;
      filePath?: string;
      toolName?: string;
      inputSummary?: string;
    }[] = [];

    for (let i = 0; i < cleaned.length; i++) {
      const msg = cleaned[i];
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type === "tool_result" && block.content.length > OUTPUT_THRESHOLD) {
          const meta = toolIndex.get(block.tool_use_id);
          const filePath = meta?.filePath;
          // P1-3：read 了活跃（被 write/edit 过）文件的大输出 → 豁免清理
          const exempt = !!(filePath && meta?.toolName === "read" && activeFiles.has(filePath));
          largeOutputPositions.push({
            msgIdx: i,
            blockIdx: j,
            exempt,
            filePath,
            toolName: meta?.toolName,
            inputSummary: meta?.inputSummary,
          });
        }
      }
    }

    // 仅对"非豁免"的大输出做保留数判定（活跃文件输出不计入清理候选）
    const cleanable = largeOutputPositions.filter(p => !p.exempt);

    // 如果可清理的大输出数量不超过保留数，直接返回
    if (cleanable.length <= KEEP_RECENT_OUTPUTS) {
      // 验证消息格式（仅警告，不阻塞）
      const errors = MessageValidator.validate(cleaned);
      if (errors.length > 0) {
        log.warn("CONTEXT", `消息验证发现 ${errors.length} 个问题:`, {
          errors: errors.map(e => `[${e.code}] ${e.message}`),
        });
      }
      return cleaned;
    }

    // 需要清理的旧输出（保留最近 N 个），活跃文件已被排除在 cleanable 之外
    const toClean = cleanable.slice(0, -KEEP_RECENT_OUTPUTS);
    // key → {filePath, toolName, inputSummary}，用于占位符精准重读指引（9.3）
    const cleanMap = new Map<string, { filePath?: string; toolName?: string; inputSummary?: string }>(
      toClean.map(p => [
        `${p.msgIdx}:${p.blockIdx}`,
        { filePath: p.filePath, toolName: p.toolName, inputSummary: p.inputSummary },
      ]),
    );

    // 深拷贝并清理（P1-3 + 9.3：占位符附带精准重读指引——含工具名 + input 摘要）
    const result = cleaned.map((msg, msgIdx) => ({
      role: msg.role,
      content: msg.content.map((block, blockIdx) => {
        const key = `${msgIdx}:${blockIdx}`;
        const meta = cleanMap.get(key);
        if (meta && block.type === "tool_result") {
          const { filePath, toolName, inputSummary } = meta;
          let guidance: string;
          if (filePath) {
            // 已知文件路径：提示精准重读，而不是盲目从头整文件重读
            guidance = `[已清理: ${toolName ?? "tool"}(${filePath}), 原始 ${block.content.length} 字符。已清理以节省上下文。如需该内容，请用 read("${filePath}", offset=...) 精准重读你需要的行段，不要从头整文件重读。]`;
          } else if (toolName) {
            // 无文件路径但有工具名/参数：告知用什么调用产生的，便于按需重新执行
            const summary = inputSummary ? `(${inputSummary})` : "";
            guidance = `[已清理: ${toolName}${summary}, 原始 ${block.content.length} 字符。已清理以节省上下文。如需该内容，重新执行该工具调用即可恢复。]`;
          } else {
            guidance = TOOL_RESULT_CLEARED_MESSAGE;
          }
          return {
            ...block,
            content: guidance,
          };
        }
        return block;
      }),
    }));

    // 验证消息格式（仅警告，不阻塞）
    const errors = MessageValidator.validate(result);
    if (errors.length > 0) {
      log.warn("CONTEXT", `消息验证发现 ${errors.length} 个问题:`, {
        errors: errors.map(e => `[${e.code}] ${e.message}`),
      });
    }

    return result;
  }

  // ─── compact_boundary 支持 ───

  /**
   * 插入 compact_boundary 标记
   *
   * 在消息列表中插入一条特殊消息，标记该点之前的内容已被压缩。
   * 使用 Message._meta 字段而非新增 ContentBlock 类型，保持向后兼容。
   *
   * @param summary 压缩摘要
   * @param messageCountBefore 压缩前的消息数
   */
  addCompactBoundary(summary: string, messageCountBefore: number): void {
    const boundaryMsg: Message = {
      role: "user",
      content: [{ type: "text", text: `[压缩边界] ${summary}` }],
      _meta: {
        compact_boundary: {
          summary,
          messageCountBefore,
          timestamp: Date.now(),
        },
        compact_source: "compact",
      },
    };

    this.messages.push(boundaryMsg);
    const log = getLogger();
    log.debug("CONTEXT", `插入 compact_boundary: messageCountBefore=${messageCountBefore}`);
  }

  /**
   * 释放 compact_boundary 之前的消息内容供 GC 回收
   *
   * 找到最近的 compact_boundary，将其之前的所有消息的 content
   * 替换为轻量引用，让 V8 GC 可以回收大对象。
   * 保留消息骨架（role）和 compact_boundary 摘要。
   */
  releaseBeforeBoundary(): number {
    // 从后向前找到最近的 compact_boundary
    let boundaryIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const meta = this.messages[i]._meta;
      if (meta?.compact_boundary) {
        boundaryIdx = i;
        break;
      }
    }

    if (boundaryIdx <= 0) return 0; // 没有边界或边界在开头

    let releasedCount = 0;
    for (let i = 0; i < boundaryIdx; i++) {
      const msg = this.messages[i];
      // 替换内容为空引用，让 GC 回收
      // 使用小对象替换大 content 数组
      const hadContent = msg.content.length > 0 && msg.content.some(b => {
        if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > 100) return true;
        if (b.type === "text" && b.text.length > 100) return true;
        return false;
      });

      if (hadContent) {
        this.messages[i] = {
          role: msg.role,
          content: [{ type: "text", text: `[已释放] ${msg.role} 消息内容已被 GC 回收，详情见 compact_boundary` }],
          _meta: { gc_released: true },
        };
        releasedCount++;
      }
    }

    if (releasedCount > 0) {
      const log = getLogger();
      log.info("CONTEXT", `GC 释放: compact_boundary 前 ${releasedCount} 条消息内容已替换`);
    }

    return releasedCount;
  }

  /** 设置消息列表（用于恢复会话） */
  setMessages(msgs: Message[]): void {
    this.messages = [...msgs];
    // 消息集整体替换 → 真实 token 锚点失效，避免沿用旧值误判 compact
    this.invalidateActualTokenAnchor();
    // 诊断：静默检测配对完整性（不修数据、不阻断主流程）。
    // setMessages 是 restoreSession / 压缩管线等的整体替换入口，脏数据（游离/孤儿）
    // 从这里进入历史后，由发送前 backfillOrphanToolResults 关卡兜底修复。
    // 此处只记录告警，让"脏数据从哪个调用方进来"显形，便于定位产生端。
    const integrity = checkMessageHistoryIntegrity(this.messages);
    if (!integrity.intact) {
      getLogger().warn(
        "CONTEXT",
        `setMessages 接收到不完整消息历史（将由发送前关卡兜底）：${describeIntegrityViolation(integrity)}`,
      );
    }
  }

  /** 清空消息 */
  clear(): void {
    this.messages = [];
    this.invalidateActualTokenAnchor();
  }

  /**
   * 智能截断超大工具输出（三层策略，对标 Claude Code）
   * 1. 代码块：保留 60% 头 + 40% 尾（行级别）
   * 2. 文件内容（行号特征）：保留前 20 行 + 后 10 行
   * 3. 普通文本：70% 头 + 30% 尾（字符级别）
   */
  static truncateToolOutput(content: string, maxChars: number = OUTPUT_THRESHOLD): string {
    if (content.length <= maxChars) {
      return content;
    }

    // 1. 检测并压缩代码块（``` 包裹的代码）
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let result = content;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const code = match[2];
      if (code.length > 2000) {
        const lines = code.split('\n');
        const keepHead = Math.ceil(lines.length * 0.6);
        const keepTail = Math.floor(lines.length * 0.4);
        const omitted = lines.length - keepHead - keepTail;
        if (omitted > 0) {
          const compressed = [
            ...lines.slice(0, keepHead),
            `\n... [省略 ${omitted} 行] ...\n`,
            ...lines.slice(-keepTail),
          ].join('\n');
          result = result.replace(match[0], `\`\`\`${match[1]}\n${compressed}\`\`\``);
        }
      }
    }
    if (result.length <= maxChars) return result;

    // 2. 检测文件内容（行号特征：→ 或 数字│）
    if (content.includes('→') || /^\s*\d+\s*[│|]/m.test(content)) {
      const lines = content.split('\n');
      if (lines.length > 30) {
        const head = lines.slice(0, 20).join('\n');
        const tail = lines.slice(-10).join('\n');
        return `${head}\n\n... [省略 ${lines.length - 30} 行，共 ${lines.length} 行] ...\n\n${tail}`;
      }
    }

    // 3. 默认：70% 头 + 30% 尾（字符级别）
    const keepHead = Math.floor(maxChars * 0.7);
    const keepTail = Math.floor(maxChars * 0.3);
    return `${result.slice(0, keepHead)}\n\n... [省略约 ${content.length - maxChars} 字符，共 ${content.length} 字符] ...\n\n${result.slice(-keepTail)}`;
  }

  /**
   * 增强版截断：支持工具输出落盘到临时文件
   * 超大输出保存完整内容到文件，返回截断摘要 + 文件路径
   */
  static truncateToolOutputWithSave(
    content: string,
    toolName: string,
    tempDir?: string,
    maxChars: number = OUTPUT_THRESHOLD,
  ): TruncationResult {
    if (content.length <= maxChars) {
      return { truncated: content, savedPath: null };
    }

    // 保存完整输出到临时文件（未指定 tempDir 时用 UID 隔离的 sid-code 临时根，0o700）
    let savedPath: string | null = null;
    try {
      const base = tempDir ?? ensureSidTempDir();
      const dir = path.join(base, "tool-outputs");
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const filename = `${toolName}-${Date.now()}.txt`;
      savedPath = path.join(dir, filename);
      fs.writeFileSync(savedPath, content, "utf-8");
    } catch (err: any) {
      const log = getLogger();
      log.warn("CONTEXT", `工具输出落盘失败: ${err.message}`);
      savedPath = null;
    }

    // 智能截断：前 20% + 后 80%（参考 gemini-cli 的比例，尾部更重要）
    const headChars = Math.floor(maxChars * 0.2);
    const tailChars = maxChars - headChars;
    const head = content.slice(0, headChars);
    const tail = content.slice(-tailChars);
    const omitted = content.length - headChars - tailChars;

    let truncated = `输出过大（${content.length} 字符），显示前 ${headChars} 和后 ${tailChars} 字符。`;
    if (savedPath) {
      truncated += `\n完整输出已保存到: ${savedPath}`;
    }
    truncated += `\n\n${head}\n\n... [省略 ${omitted} 字符] ...\n\n${tail}`;

    return { truncated, savedPath };
  }

  /**
   * 估算当前 token 数（区分 ASCII/非 ASCII 字符）
   * 包含：系统提示词 + 消息内容 + 消息结构开销 + 工具定义开销
   *
   * P1-6/P1-7：输出经 calibrationFactor 校准（已收到真实 usage 后），收敛到真实口径，
   * 避免纯字符启发式对代码/JSON 低估导致 compact 触发过晚、上下文溢出。
   * 未校准前（calibrated=false）等同纯启发式估算。
   */
  estimateTokens(toolCount: number = 0): number {
    const raw = this.rawEstimateTokens(toolCount);
    if (!this.calibrated) return raw;
    const calibrated = Math.ceil(raw * this.calibrationFactor);
    // P1-6 锚定：compact 决策依赖此估算。真实 inputTokens 是已知下界——
    // 上一次 API 实际就发了这么多 prompt，之后只会增不会减（除非中途压缩）。
    // 取「校准估算」与「真实锚点」的较大值，确保不会因启发式低估而把 compact 推迟到溢出。
    return Math.max(calibrated, this.lastActualInputTokens);
  }

  /**
   * 纯启发式 token 估算（未经校准）。calibrationFactor 的分母、estimateTokens 的基线。
   * 单独抽出避免校准自我反馈漂移（用已校准值反推 factor 会发散）。
   */
  private rawEstimateTokens(toolCount: number = 0): number {
    // 系统提示词
    let total = estimateTextTokens(this.systemPrompt);

    // 工具定义开销：EST-4 优先用注入的真实 schema token 数；
    // 未注入时回退每工具 80 token 粗估（schema 大/工具多时偏低）。
    total += this.toolSchemaTokens ?? toolCount * 80;

    // 消息内容 + 结构开销
    for (const msg of this.messages) {
      // 消息结构开销（每条消息约 4 token）
      total += 4;

      for (const block of msg.content) {
        if (block.type === "text") {
          total += estimateTextTokens(block.text);
        } else if (block.type === "tool_use") {
          // tool_use 块：JSON 内容 + 结构开销（约 20 token）
          total += estimateTextTokens(JSON.stringify(block.input)) + 20;
        } else if (block.type === "tool_result") {
          // tool_result 块：内容 + 结构开销（约 10 token）
          total += estimateTextTokens(block.content) + 10;
        }
      }
    }

    return total;
  }

  /** 获取上下文窗口最大 token 数 */
  getMaxTokens(): number {
    return this.maxTokens;
  }

  /** 是否需要压缩 */
  needsCompaction(toolCount: number = 0): boolean {
    return this.estimateTokens(toolCount) > this.maxTokens * this.compactThreshold;
  }

  /**
   * 获取压缩级别
   *
   * 基于绝对 token buffer 而非百分比，使行为在不同窗口模型间可预测：
   * - 小窗口模型（≤ 60K）：仅剩 10% 时触发 emergency 截断
   * - 标准窗口模型（≥ 80K）：三层渐进压缩按 buffer 阈值触发
   */
  getCompactionLevel(toolCount: number = 0): CompactionLevel {
    const used = this.estimateTokens(toolCount);
    const remaining = this.maxTokens - used;

    // 小窗口模型（≤ 60K tokens）：仅 emergency 截断（比例触发）
    if (this.maxTokens <= 60_000) {
      if (remaining <= (1 - SMALL_WINDOW_EMERGENCY_RATIO) * this.maxTokens) {
        return "emergency";
      }
      return "none";
    }

    // 标准/大窗口模型：三层渐进压缩。
    // §12.6 阈值相对化：纯绝对 buffer 对超大窗口（如 1M）触发过晚——
    //   1M 窗口剩 80K 才开始 masking = 已用 92%，留给压缩的腾挪空间过小。
    // 故每层取「绝对 buffer」与「窗口百分比」中更早触发（更大）的那个作为剩余阈值。
    //   masking: max(80K, 18% window)、compression: max(60K, 12% window)、emergency: max(40K, 7% window)
    //   对 200K 窗口：18%=36K < 80K → 仍用绝对值（行为不变，兼容老模型）。
    //   对 1M 窗口：18%=180K > 80K → 用相对值（剩 180K≈82% 用量即开始 masking，留足腾挪空间）。
    const maskingThreshold = Math.max(BUFFER_THRESHOLDS.masking, this.maxTokens * 0.18);
    const compressionThreshold = Math.max(BUFFER_THRESHOLDS.compression, this.maxTokens * 0.12);
    const emergencyThreshold = Math.max(BUFFER_THRESHOLDS.emergency, this.maxTokens * 0.07);

    // 按剩余空间从紧到松检查：剩余越少 → 响应越激进
    if (remaining <= emergencyThreshold) return "emergency";    // 紧急截断
    if (remaining <= compressionThreshold) return "hard";       // LLM 摘要压缩
    if (remaining <= maskingThreshold) return "soft";           // 工具输出遮罩
    return "none";                                              // 充裕 → 不需要压缩
  }

  /**
   * 紧急截断：强制删除旧消息，防止上下文溢出
   * 保留最近 30% 的消息
   */
  emergencyTruncate(): void {
    const log = getLogger();
    const before = this.messages.length;
    const splitPoint = this.findCompressSplitPoint(0.3);

    if (splitPoint > 0) {
      // §12.4：紧急截断也保留一份"极简摘要"——纯本地提取，不调 LLM（紧急路径不能再花一次 API 往返）。
      // 提取被截断段的：消息条数 / 涉及文件 / 最后工作方向，让模型截断后不至于完全断片。
      const truncatedSegment = this.messages.slice(0, splitPoint);
      const miniSummary = this.buildEmergencyMiniSummary(truncatedSegment, splitPoint);
      this.messages = [
        {
          role: "user",
          content: [{ type: "text", text: miniSummary }],
          // 紧急截断锚点仅供 LLM 维持角色交替,不在 TUI 渲染(按 _meta.origin 隐藏)。
          _meta: { origin: "compact-summary" },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "了解，继续。" }],
          _meta: { origin: "compact-summary" },
        },
        ...this.messages.slice(splitPoint),
      ];
      // Bug #3 修复：记录截断次数到 SessionMetrics
      getSessionMetrics().recordTruncation();
    }

    // 真实 token 锚点失效：截断后 prompt 骤降，旧锚点会让下一轮 compact 决策误判
    this.invalidateActualTokenAnchor();
    log.warn("CONTEXT", `紧急压缩: ${before} → ${this.messages.length} 条消息`);
  }

  /**
   * §12.4：从被紧急截断的消息段提取极简摘要（纯本地，零 LLM 调用）。
   * 包含：截断条数 + 涉及文件（write/edit/read 的路径）+ 最后一条 user 文本方向。
   */
  private buildEmergencyMiniSummary(segment: Message[], count: number): string {
    const files = new Set<string>();
    let lastUserText = "";
    for (const msg of segment) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const input = (block.input ?? {}) as { file_path?: string; path?: string };
          const fp = input.file_path ?? input.path;
          if (fp) files.add(fp);
        } else if (block.type === "text" && msg.role === "user") {
          const t = block.text.trim();
          // 跳过内部摘要/占位消息，只取真实用户意图
          if (t && !t.startsWith("[") && !msg._meta?.origin) lastUserText = t;
        }
      }
    }
    const parts = [`[紧急压缩] 前 ${count} 条消息已被截断以防止上下文溢出。`];
    if (files.size > 0) {
      const fileList = Array.from(files).slice(0, 10).join(", ");
      parts.push(`涉及文件：${fileList}${files.size > 10 ? ` 等 ${files.size} 个` : ""}。`);
    }
    if (lastUserText) {
      parts.push(`最近的用户意图：${lastUserText.slice(0, 300)}${lastUserText.length > 300 ? "…" : ""}`);
    }
    parts.push("如需被截断的细节，可读取完整转录文件或重新读取上述文件。");
    return parts.join("\n");
  }

  /** 消息数量 */
  messageCount(): number {
    return this.messages.length;
  }

  /**
   * 获取对话轮数（一轮 = 一个 user + 一个 assistant 消息对）
   */
  getTurnCount(): number {
    let turns = 0;
    for (const msg of this.messages) {
      if (msg.role === "user") turns++;
    }
    return turns;
  }

  /**
   * 回退最近 n 轮对话
   * 一轮 = 一次用户输入 + 一次 AI 回复（含工具调用）
   * 返回实际删除的轮数
   */
  rewindTurns(n: number): number {
    let removed = 0;
    while (removed < n && this.messages.length > 0) {
      // 从末尾找到最后一个 user 消息的位置
      let userIdx = -1;
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx === -1) break;
      // 删除从 userIdx 到末尾的所有消息（一轮）
      this.messages.splice(userIdx);
      removed++;
    }
    return removed;
  }

  /**
   * §2.1：压缩完成后向消息历史**末尾**追加重注入消息（文件恢复等）。
   * 与 compactWithSummary 的 extraReattach 不同：那是插在摘要后、保留消息前；
   * 本方法用于"压缩腾出空间后再注入"的场景（文件恢复要先压缩再注入并守预算）。
   * 追加到末尾即"最近"，模型最易看到。这些消息应自带 _meta.origin 以便 TUI 隐藏 + 下次 strip。
   */
  appendReattachMessages(msgs: Message[]): void {
    if (!msgs || msgs.length === 0) return;
    this.messages.push(...msgs);
  }

  /**
   * 找到安全的压缩分割点（只在 user 消息处分割）
   * 确保不会在 tool_use/tool_result 对中间切割
   */
  findCompressSplitPoint(preserveRatio: number = COMPRESSION_PRESERVE_RATIO): number {
    const totalChars = this.messages.reduce((sum, msg) => {
      return sum + msg.content.reduce((s, b) => {
        if (b.type === "text") return s + b.text.length;
        if (b.type === "tool_result") return s + b.content.length;
        if (b.type === "tool_use") return s + JSON.stringify(b.input).length;
        return s;
      }, 0);
    }, 0);

    const targetChars = totalChars * (1 - preserveRatio);
    let cumulative = 0;
    let lastSafePoint = 0;

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      // 只在 user 消息处标记安全分割点（且不包含 tool_result）
      const hasToolResult = msg.content.some(b => b.type === "tool_result");
      if (msg.role === "user" && !hasToolResult) {
        lastSafePoint = i;
      }

      cumulative += msg.content.reduce((s, b) => {
        if (b.type === "text") return s + b.text.length;
        if (b.type === "tool_result") return s + b.content.length;
        if (b.type === "tool_use") return s + JSON.stringify(b.input).length;
        return s;
      }, 0);

      if (cumulative >= targetChars && lastSafePoint > 0) {
        return lastSafePoint;
      }
    }

    return lastSafePoint;
  }

  /**
   * 压缩前预处理：截断待压缩部分的工具输出到预算内
   * 从最新消息向前遍历，优先保留近期工具输出
   */
  truncateForCompression(messages: Message[]): Message[] {
    let tokenBudget = COMPRESSION_TOOL_OUTPUT_BUDGET;

    // 从后向前遍历，优先保留近期输出
    const result = [...messages];
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      result[i] = {
        ...msg,
        content: msg.content.map(block => {
          if (block.type !== "tool_result") return block;
          const tokens = estimateTextTokens(block.content);
          if (tokenBudget >= tokens) {
            tokenBudget -= tokens;
            return block; // 预算充足，保留完整内容
          }
          // 预算不足，截断
          tokenBudget = 0;
          const lines = block.content.split("\n");
          const kept = lines.slice(-30).join("\n"); // 保留最后 30 行
          return { ...block, content: `[输出已截断，保留最后 30 行]\n${kept}` };
        }),
      };
    }

    return result;
  }

  /**
   * 增强版摘要压缩（替代原 compactWithSummary）
   * 1. 找到安全分割点
   * 2. 预处理待压缩部分
   * 3. 用摘要替换
   * 4. 验证压缩效果
   *
   * @param summary 压缩摘要正文
   * @param extraReattach 可选的压缩后重注入消息（文件恢复 / 决策点恢复等，§2.1 / §4.3）。
   *   插入到 Skill 消息之后、保留消息之前。这些消息应自带 _meta.origin 标记以便 TUI 隐藏。
   */
  compactWithSummary(summary: string, extraReattach?: Message[]): void {
    const splitPoint = this.findCompressSplitPoint();
    if (splitPoint <= 0) return; // 没有安全分割点

    const tokensBefore = this.estimateTokens();
    const kept = this.messages.slice(splitPoint);

    const summaryMsg: Message = {
      role: "user",
      content: [{ type: "text", text: `[对话摘要]\n${summary}` }],
      // 标记内部来源:此摘要 user 消息仅供 LLM 续接上下文,不应在 TUI 渲染
      //(history-adapter.isHiddenFromDisplay 按 _meta.origin 隐藏)。
      _meta: { origin: "compact-summary" },
    };
    const ackMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
      _meta: { origin: "compact-summary" },
    };

    // 保留已调用的 Skill 上下文（压缩会丢弃旧消息，Skill 工作流指令必须重新注入）
    const skillMsgs = this.buildInvokedSkillMessages();

    // §3.3：活跃 Plan 正文重注入（Skill 消息之后），让模型压缩后仍能引用 Plan 的具体步骤
    const planMsgs = this.buildPlanReattachMessages();

    // §2.1 / §4.3：外部传入的重注入消息（文件恢复 / 决策点恢复）
    const reattachMsgs = extraReattach ?? [];

    this.messages = [summaryMsg, ackMsg, ...skillMsgs, ...planMsgs, ...reattachMsgs, ...kept];

    // 真实 token 锚点失效：摘要压缩后真实 prompt 骤降，必须在 estimateTokens 验证前重置，
    // 否则 tokensAfter 仍被旧锚点钉在高位（既污染验证日志，也让后续 compact 决策误判）。
    this.invalidateActualTokenAnchor();

    const tokensAfter = this.estimateTokens();
    const log = getLogger();

    // 验证：压缩后 token 数不应增加
    if (tokensAfter >= tokensBefore) {
      log.warn("CONTEXT", `压缩异常：压缩后 token 数 (${tokensAfter}) >= 压缩前 (${tokensBefore})`);
    } else {
      log.info("CONTEXT", `压缩完成: ${tokensBefore} → ${tokensAfter} tokens (节省 ${Math.round((1 - tokensAfter / tokensBefore) * 100)}%)`);
    }

    // 记录压缩到会话指标
    getSessionMetrics().recordCompact();
  }

  /**
   * §3.3：构造活跃 Plan 正文的重注入消息对（无活跃 Plan 返回空数组）。
   * Plan 内容不限制预算（Plan 文件通常几百到几千字）。
   */
  private buildPlanReattachMessages(): Message[] {
    if (!this.planContentProvider) return [];
    let planContent: string | null = null;
    try {
      planContent = this.planContentProvider();
    } catch {
      return [];
    }
    if (!planContent || !planContent.trim()) return [];

    const planUserMsg: Message = {
      role: "user",
      content: [{ type: "text", text: `${REATTACH_PLAN_PREFIX}\n${planContent}` }],
      _meta: { origin: REATTACH_ORIGIN },
    };
    const planAckMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "好的，已重新加载当前 Plan，我会继续按计划执行。" }],
      _meta: { origin: REATTACH_ORIGIN },
    };
    return [planUserMsg, planAckMsg];
  }

  /**
   * 构造已调用 Skill 的保留消息对
   * 压缩会丢弃旧消息，但 Skill 的工作流指令是模型正确执行任务的关键上下文，
   * 必须重新注入（对齐 Claude Code addInvokedSkill 的"必须保留"语义）。
   */
  private buildInvokedSkillMessages(): Message[] {
    const toPreserve = this.invokedSkills;
    if (toPreserve.length === 0) return [];

    const skillUserMsg: Message = {
      role: "user",
      content: toPreserve.map((s) => ({
        type: "text" as const,
        text: `[已调用 Skill: ${s.name}]\n${s.content}`,
      })),
      // 压缩时重注入的 Skill 上下文仅供 LLM,不在 TUI 渲染(按 _meta.origin 隐藏)。
      _meta: { origin: "compact-summary" },
    };
    const skillAckMsg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "好的，我已重新加载之前调用的 Skill 上下文，会继续遵循。" },
      ],
      _meta: { origin: "compact-summary" },
    };
    return [skillUserMsg, skillAckMsg];
  }

  /**
   * 压缩前清理旧的大型工具输出（函数响应预算）
   * 从最新消息向前遍历，优先保留最近的工具输出
   * @param budgetChars 工具输出总字符预算。默认按当前上下文窗口的约 25% 推导
   *   （maxTokens × 4 字符/token × 0.25），而非硬编码 200000 —— 后者对 1M 窗口模型
   *   会把工具输出预算锁死在窗口的 5%，过度截断本可保留的工具结果。
   */
  applyFunctionResponseBudget(budgetChars: number = this.maxTokens * 4 * 0.25): void {
    const log = getLogger();
    let usedChars = 0;
    let cleanedCount = 0;

    // 从最新消息向前遍历，优先保留最近的工具输出
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== "user") continue;

      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type !== "tool_result") continue;

        const chars = block.content.length;
        if (usedChars + chars > budgetChars) {
          // 超出预算，截断这个工具输出
          msg.content[j] = {
            ...block,
            content: `${TOOL_RESULT_CLEARED_MESSAGE}，超出函数响应预算`,
          };
          cleanedCount++;
        }
        usedChars += chars;
      }
    }

    if (cleanedCount > 0) {
      log.info("CONTEXT", `函数响应预算清理: 清理了 ${cleanedCount} 个旧工具输出`);
    }
  }

  /**
   * 清理工具输出临时文件
   * @param maxAgeMs 最大保留时间（毫秒，默认 1 小时）
   */
  static cleanupToolOutputs(tempDir?: string, maxAgeMs: number = 3600_000): void {
    const log = getLogger();
    const dir = path.join(tempDir ?? ensureSidTempDir(), "tool-outputs");

    if (!fs.existsSync(dir)) return;

    try {
      const files = fs.readdirSync(dir);
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        log.info("CONTEXT", `清理了 ${cleaned} 个过期的工具输出临时文件`);
      }

      // 如果目录为空，删除目录
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
      }
    } catch (err: any) {
      log.warn("CONTEXT", `清理工具输出临时文件失败: ${err.message}`);
    }
  }
}
