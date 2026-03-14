/**
 * Extended Thinking 预算控制
 * 根据任务复杂度分配思考预算，避免浪费 token
 */

import { getLogger } from "../debug/logger.ts";

/** 任务复杂度 */
export type Complexity = "simple" | "medium" | "complex";

/** Thinking 预算配置 */
const BUDGET_MAP: Record<Complexity, number> = {
  simple: 2000,    // 简单问题：2K tokens
  medium: 10000,   // 中等复杂度：10K tokens
  complex: 50000,  // 复杂架构设计：50K tokens
};

/** 复杂度关键词匹配 */
const COMPLEXITY_PATTERNS: { complexity: Complexity; patterns: RegExp[] }[] = [
  {
    complexity: "complex",
    patterns: [
      /重构|refactor/i,
      /架构|architecture/i,
      /设计模式|design pattern/i,
      /性能优化|performance/i,
      /安全审计|security audit/i,
      /迁移|migration/i,
      /全面分析|comprehensive/i,
    ],
  },
  {
    complexity: "medium",
    patterns: [
      /实现|implement/i,
      /修复|fix|bug/i,
      /添加功能|add feature/i,
      /测试|test/i,
      /调试|debug/i,
      /解释|explain/i,
    ],
  },
];

export class ThinkingManager {
  private enabled: boolean;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;
  }

  /** 是否启用 Extended Thinking */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** 设置启用状态 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** 根据用户输入推断复杂度 */
  inferComplexity(input: string): Complexity {
    for (const { complexity, patterns } of COMPLEXITY_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(input)) {
          return complexity;
        }
      }
    }
    return "simple";
  }

  /** 根据任务复杂度推荐预算 */
  recommendBudget(complexity: Complexity): number {
    return BUDGET_MAP[complexity];
  }

  /** 根据用户输入自动推荐 thinking 配置 */
  getThinkingConfig(userInput: string): { enabled: boolean; budgetTokens: number } | undefined {
    if (!this.enabled) {
      return undefined;
    }

    const complexity = this.inferComplexity(userInput);
    const budget = this.recommendBudget(complexity);

    const log = getLogger();
    log.debug("THINKING", `复杂度: ${complexity}, 预算: ${budget} tokens`);

    return {
      enabled: true,
      budgetTokens: budget,
    };
  }

  /**
   * 支持用户通过关键词手动控制思考深度
   * "think" → medium, "think hard" → complex, "ultrathink" → complex (最大预算)
   */
  parseThinkingHint(input: string): { cleaned: string; config?: { enabled: boolean; budgetTokens: number } } {
    if (!this.enabled) {
      return { cleaned: input };
    }

    // ultrathink: 最大预算
    if (/\bultrathink\b/i.test(input)) {
      return {
        cleaned: input.replace(/\bultrathink\b/i, "").trim(),
        config: { enabled: true, budgetTokens: BUDGET_MAP.complex },
      };
    }

    // think hard: 复杂预算
    if (/\bthink\s+hard\b/i.test(input)) {
      return {
        cleaned: input.replace(/\bthink\s+hard\b/i, "").trim(),
        config: { enabled: true, budgetTokens: BUDGET_MAP.complex },
      };
    }

    // think: 中等预算
    if (/\bthink\b/i.test(input)) {
      return {
        cleaned: input.replace(/\bthink\b/i, "").trim(),
        config: { enabled: true, budgetTokens: BUDGET_MAP.medium },
      };
    }

    return { cleaned: input };
  }
}
