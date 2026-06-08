/**
 * 上下文管理器
 * 管理对话消息历史、token 估算、自动压缩、持久化输出管理
 */

import type { Message } from "../llm/types.ts";
import { MessageValidator } from "./validator.ts";
import { estimateTextTokens } from "./token.ts";
import { ToolOutputMaskingService } from "./tool-output-masking.ts";
import { getLogger, getSessionMetrics } from "../debug/index.ts";
import * as fs from "node:fs";
import * as path from "node:path";

/** 持久化输出阈值（对标 Claude Code 30000 字符，可通过 SID_OUTPUT_THRESHOLD 环境变量覆盖） */
const OUTPUT_THRESHOLD = parseInt(process.env.SID_OUTPUT_THRESHOLD ?? "30000", 10);
const KEEP_RECENT_OUTPUTS = 3;   // 保留最近 N 个大输出，旧的清理掉
const CLEARED_MARKER = "[旧的工具输出已清理]";

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
  private maskingService?: ToolOutputMaskingService;
  /** 已调用的 Skill 记录（压缩时保留其 prompt 上下文） */
  private invokedSkills: InvokedSkill[] = [];

  constructor(opts: ManagerOptions) {
    this.maxTokens = opts.maxTokens;
    this.compactThreshold = opts.compactThreshold ?? 0.7;
    this.tempDir = opts.tempDir;
  }

  /** 设置会话 ID（用于工具输出遮罩） */
  setSessionId(sessionId: string): void {
    this.maskingService = new ToolOutputMaskingService(sessionId);
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

    // 检查角色交替
    if (this.messages.length > 0) {
      const lastMsg = this.messages[this.messages.length - 1];
      if (lastMsg.role === msg.role) {
        log.warn("CONTEXT", `角色未交替: 上一条=${lastMsg.role}, 当前=${msg.role}，自动修复`);
        // 插入占位消息以保持交替
        const placeholderRole = msg.role === "user" ? "assistant" : "user";
        this.messages.push({
          role: placeholderRole,
          content: [{ type: "text", text: "[系统] 自动插入占位消息以保持角色交替" }],
        });
      }
    }

    // 增量压缩：tool_result 内容在添加时即截断，防止上下文膨胀
    const compressed: Message = {
      ...msg,
      content: msg.content.map(block => {
        if (block.type === "tool_result" && block.content.length > OUTPUT_THRESHOLD) {
          log.debug("CONTEXT", `增量压缩 tool_result: ${block.content.length} → 截断`);
          const truncated = Manager.truncateToolOutput(block.content);
          return { ...block, content: truncated };
        }
        return block;
      }),
    };

    this.messages.push(compressed);
  }

  /** 获取所有消息（发送给 LLM 前调用，会自动清理旧的大输出） */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * 获取清理后的消息列表（发送给 LLM 前调用）
   * 1. 应用工具输出遮罩（soft 级别压缩）
   * 2. 清理旧的大输出，只保留最近 N 个
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

    // 找到所有大输出的位置（从后往前扫描）
    const largeOutputPositions: { msgIdx: number; blockIdx: number }[] = [];

    for (let i = 0; i < cleaned.length; i++) {
      const msg = cleaned[i];
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type === "tool_result" && block.content.length > OUTPUT_THRESHOLD) {
          largeOutputPositions.push({ msgIdx: i, blockIdx: j });
        }
      }
    }

    // 如果大输出数量不超过保留数，直接返回
    if (largeOutputPositions.length <= KEEP_RECENT_OUTPUTS) {
      // 验证消息格式（仅警告，不阻塞）
      const errors = MessageValidator.validate(cleaned);
      if (errors.length > 0) {
        log.warn("CONTEXT", `消息验证发现 ${errors.length} 个问题:`, {
          errors: errors.map(e => `[${e.code}] ${e.message}`),
        });
      }
      return cleaned;
    }

    // 需要清理的旧输出（保留最近 N 个）
    const toClean = largeOutputPositions.slice(0, -KEEP_RECENT_OUTPUTS);
    const cleanSet = new Set(toClean.map(p => `${p.msgIdx}:${p.blockIdx}`));

    // 深拷贝并清理
    const result = cleaned.map((msg, msgIdx) => ({
      role: msg.role,
      content: msg.content.map((block, blockIdx) => {
        if (cleanSet.has(`${msgIdx}:${blockIdx}`) && block.type === "tool_result") {
          return {
            ...block,
            content: CLEARED_MARKER,
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

  /** 设置消息列表（用于恢复会话） */
  setMessages(msgs: Message[]): void {
    this.messages = [...msgs];
  }

  /** 清空消息 */
  clear(): void {
    this.messages = [];
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
    tempDir: string,
    maxChars: number = OUTPUT_THRESHOLD,
  ): TruncationResult {
    if (content.length <= maxChars) {
      return { truncated: content, savedPath: null };
    }

    // 保存完整输出到临时文件
    let savedPath: string | null = null;
    try {
      const dir = path.join(tempDir, "tool-outputs");
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
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
   */
  estimateTokens(toolCount: number = 0): number {
    // 系统提示词
    let total = estimateTextTokens(this.systemPrompt);

    // 工具定义开销（每个工具约 80 token）
    total += toolCount * 80;

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

    // 标准窗口模型：三层渐进压缩（绝对 buffer）
    // 按剩余空间从紧到松检查：剩余越少 → 响应越激进
    if (remaining <= BUFFER_THRESHOLDS.emergency) return "emergency";    // ≤ 40K → 紧急截断
    if (remaining <= BUFFER_THRESHOLDS.compression) return "hard";       // ≤ 60K → LLM 摘要压缩
    if (remaining <= BUFFER_THRESHOLDS.masking) return "soft";           // ≤ 80K → 工具输出遮罩
    return "none";                                                        // > 80K → 不需要压缩
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
      const truncatedSummary = `[紧急压缩] 前 ${splitPoint} 条消息已被截断以防止上下文溢出`;
      this.messages = [
        { role: "user", content: [{ type: "text", text: truncatedSummary }] },
        { role: "assistant", content: [{ type: "text", text: "了解，继续。" }] },
        ...this.messages.slice(splitPoint),
      ];
      // Bug #3 修复：记录截断次数到 SessionMetrics
      getSessionMetrics().recordTruncation();
    }

    log.warn("CONTEXT", `紧急压缩: ${before} → ${this.messages.length} 条消息`);
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
   */
  compactWithSummary(summary: string): void {
    const splitPoint = this.findCompressSplitPoint();
    if (splitPoint <= 0) return; // 没有安全分割点

    const tokensBefore = this.estimateTokens();
    const kept = this.messages.slice(splitPoint);

    const summaryMsg: Message = {
      role: "user",
      content: [{ type: "text", text: `[对话摘要]\n${summary}` }],
    };
    const ackMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "好的，我已了解之前的对话内容。请继续。" }],
    };

    // 保留已调用的 Skill 上下文（压缩会丢弃旧消息，Skill 工作流指令必须重新注入）
    const skillMsgs = this.buildInvokedSkillMessages();

    this.messages = [summaryMsg, ackMsg, ...skillMsgs, ...kept];

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
    };
    const skillAckMsg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "好的，我已重新加载之前调用的 Skill 上下文，会继续遵循。" },
      ],
    };
    return [skillUserMsg, skillAckMsg];
  }

  /**
   * 压缩前清理旧的大型工具输出（函数响应预算）
   * 从最新消息向前遍历，优先保留最近的工具输出
   * @param budgetChars 工具输出总字符预算（默认 200000）
   */
  applyFunctionResponseBudget(budgetChars: number = 200000): void {
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
            content: "[旧的工具输出已清理，超出函数响应预算]",
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
  static cleanupToolOutputs(tempDir: string, maxAgeMs: number = 3600_000): void {
    const log = getLogger();
    const dir = path.join(tempDir, "tool-outputs");

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
