/**
 * 会话状态管理 — 单一真相源
 * 对标 Claude Code 的 SessionState，集中管理：
 * - 按模型分开的 token 用量统计
 * - 成本计算（区分缓存 token 计价）
 * - API 耗时 vs 工具耗时分开追踪
 */

import type { Usage } from "../llm/types.ts";

/** 单个模型的用量统计 */
export interface ModelUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  requests: number;
  costUSD: number;
}

/** 模型定价（每百万 token） */
interface ModelPricing {
  input: number;   // 输入价格 $/M tokens
  output: number;  // 输出价格 $/M tokens
}

/** 内置模型定价表 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude 系列
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-4-20250514": { input: 0.25, output: 1.25 },
  // 旧版兼容
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
};

/** 会话状态 */
export class SessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly startTime: number;

  /** 总花费（美元） */
  totalCostUSD: number = 0;
  /** API 调用总耗时（毫秒） */
  totalAPIDuration: number = 0;
  /** 工具执行总耗时（毫秒） */
  totalToolDuration: number = 0;
  /** 按模型分开的用量统计 */
  modelUsage: Record<string, ModelUsageStats> = {};

  constructor(sessionId: string, cwd?: string) {
    this.sessionId = sessionId;
    this.cwd = cwd ?? process.cwd();
    this.startTime = Date.now();
  }

  /** 更新 API 调用的用量统计 */
  updateUsage(model: string, usage: Usage, durationMs: number): void {
    // 初始化模型统计
    if (!this.modelUsage[model]) {
      this.modelUsage[model] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        requests: 0,
        costUSD: 0,
      };
    }

    const stats = this.modelUsage[model];

    // 累加 token
    stats.inputTokens += usage.inputTokens;
    stats.outputTokens += usage.outputTokens;
    stats.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    stats.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    stats.requests += 1;

    // 计算本次成本
    const cost = this.calculateCost(model, usage);
    stats.costUSD += cost;

    // 更新全局统计
    this.totalCostUSD += cost;
    this.totalAPIDuration += durationMs;
  }

  /** 累加工具执行耗时 */
  addToolDuration(durationMs: number): void {
    this.totalToolDuration += durationMs;
  }

  /**
   * 计算单次 API 调用的成本
   * 缓存读取: input 价格 × 0.1（90% 折扣）
   * 缓存写入: input 价格 × 1.25（25% 加价）
   */
  calculateCost(model: string, usage: Usage): number {
    const pricing = this.getPricing(model);
    if (!pricing) return 0;

    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const cacheCreation = usage.cacheCreationInputTokens ?? 0;
    const regularInput = Math.max(0, usage.inputTokens - cacheRead - cacheCreation);

    let cost = 0;
    // 正常输入
    cost += (regularInput / 1_000_000) * pricing.input;
    // 缓存读取（90% 折扣）
    cost += (cacheRead / 1_000_000) * pricing.input * 0.1;
    // 缓存写入（25% 加价）
    cost += (cacheCreation / 1_000_000) * pricing.input * 1.25;
    // 输出
    cost += (usage.outputTokens / 1_000_000) * pricing.output;

    return cost;
  }

  /** 获取模型定价，未知模型返回 null */
  private getPricing(model: string): ModelPricing | null {
    // 精确匹配
    if (MODEL_PRICING[model]) return MODEL_PRICING[model];

    // 模糊匹配（模型名可能带版本后缀）
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
      if (model.startsWith(key) || key.startsWith(model)) {
        return pricing;
      }
    }

    return null;
  }

  /** 获取汇总的 Usage（兼容旧接口） */
  getTotalUsage(): Usage {
    const total: Usage = { inputTokens: 0, outputTokens: 0 };
    for (const stats of Object.values(this.modelUsage)) {
      total.inputTokens += stats.inputTokens;
      total.outputTokens += stats.outputTokens;
      total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + stats.cacheCreationInputTokens;
      total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + stats.cacheReadInputTokens;
    }
    return total;
  }

  /** 获取会话运行时长（毫秒） */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /** 格式化耗时为可读字符串 */
  static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    return `${minutes}m${remainSeconds}s`;
  }
}
