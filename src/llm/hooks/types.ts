/**
 * secret-redact runtime hook 类型定义
 * 来源: ADR-026 §3.2
 */

/** Hook 输入: 待 redact 的文本 + 来源标记 */
export interface RedactInput {
  text: string;
  /** 来源标记, 日志打点用 */
  source: "llm_request" | "llm_response" | "tool_arg" | "memory_value";
}

/** 单类 secret 命中信息 */
export interface SecretHit {
  /** secret 类别, 如 "github_token" / "openai_key" */
  category: string;
  /** 命中次数 */
  count: number;
}

/** Hook 输出: redact 后的文本 + 命中清单 */
export interface RedactResult {
  /** redact 后的文本 (无命中时与 input.text 相同) */
  text: string;
  /** 命中的 secret 类型 (按 category 去重计数) */
  hits: SecretHit[];
  /** 是否有任何 secret 命中 (布尔短路) */
  hasSecrets: boolean;
}

/** detect 模式返回的单条命中 */
export interface DetectMatch {
  category: string;
  /** 原始命中文本 (注意: 不应直接落日志, 测试断言用) */
  match: string;
  /** 命中起止 offset */
  start: number;
  end: number;
}

/** Pattern 注册定义 */
export interface RedactPattern {
  category: string;
  pattern: RegExp;
  /** 替换函数: 输入是 regex match[0], 返回替换文本 */
  replacer: (match: string) => string;
  /** 误报守护: 给定 (match, full_context), 返回 true = 跳过 redact */
  falsePositiveGuard?: (match: string, context: string) => boolean;
}
