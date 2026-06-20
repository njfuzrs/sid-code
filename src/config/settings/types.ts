/**
 * Settings Schema（Zod 驱动）与类型
 *
 * 从手写验证迁移到 Zod Schema，实现类型安全和验证的统一。
 * 使用 zod@3.25（已作为 @anthropic-ai/sdk 的依赖安装）。
 *
 * 关键设计点（见 Spec 15 §3.2）：
 * 1. lazySchema() 延迟求值——避免模块加载阶段的 CPU 开销
 * 2. .passthrough() 保留未知字段——向前兼容（旧版本不认识的新字段不被删除）
 * 3. 类型从 Schema 推导——消除手动维护接口与验证逻辑不同步的风险
 */

import { z } from "zod";

/** 延迟求值包装器——避免模块加载阶段的 CPU 开销 */
export function lazySchema<T extends z.ZodType>(factory: () => T): () => T {
  let cached: T | null = null;
  return () => {
    if (!cached) cached = factory();
    return cached;
  };
}

/** 权限规则 Schema */
const PermissionsSchema = lazySchema(() =>
  z.object({
    defaultMode: z.string().optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
  }),
);

/** Hook 配置 Schema */
const HookEntrySchema = lazySchema(() =>
  z.object({
    type: z.enum(["command", "url"]).optional(),
    event: z.string().optional(),
    command: z.string().optional(),
    url: z.string().optional(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
    timeout: z.number().positive().optional(),
    blocking: z.boolean().optional(),
    matcher: z.string().optional(),
  }),
);

/** MCP 服务器 Schema */
const MCPServerSchema = lazySchema(() =>
  z.object({
    transport: z.enum(["stdio", "http", "sse", "ws"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string()).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().positive().optional(),
    retries: z.number().nonnegative().optional(),
    includeTools: z.array(z.string()).optional(),
    excludeTools: z.array(z.string()).optional(),
  }),
);

/** 模型定价（每百万 token，USD） */
const ModelPricingSchema = lazySchema(() =>
  z.object({
    input: z.number().positive(),
    output: z.number().positive(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
  }),
);

/** 模型配置 Schema */
const ModelConfigSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1),
    provider: z.string().optional(),
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
    contextWindow: z.number().positive().optional(),
    maxOutputTokens: z.number().positive().optional(),
    supportsThinking: z.boolean().optional(),
    /** 可选：用户自配价格。配了则优先使用，未配则回退内置定价表兜底 */
    pricing: ModelPricingSchema().optional(),
  }),
);

/** 预算规则 Schema */
const BudgetRuleSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    period: z.enum(["session", "hourly", "daily", "weekly", "monthly"]),
    limit_usd: z.number().positive(),
    scope: z.object({ model: z.string().optional() }).optional(),
    thresholds: z
      .object({
        warning: z.number().optional(),
        critical: z.number().optional(),
        exceeded: z.number().optional(),
      })
      .optional(),
    action: z.enum(["alert", "downgrade", "block"]).optional(),
  }),
);

/** 配额 Schema */
const QuotaSchema = lazySchema(() =>
  z.object({
    costLimit: z.number().positive().optional(),
    requestsPerMinute: z.number().positive().optional(),
    tokensPerMinute: z.number().positive().optional(),
    budgetRules: z.array(BudgetRuleSchema()).optional(),
  }),
);

/** 搜索配置 Schema */
const SearchSchema = lazySchema(() =>
  z.object({
    backend: z.enum(["searxng", "brave", "tavily", "duckduckgo"]).optional(),
    searxngUrl: z.string().optional(),
    braveApiKey: z.string().optional(),
    tavilyApiKey: z.string().optional(),
  }),
);

/** 完整 Settings Schema */
export const SettingsSchema = lazySchema(() =>
  z
    .object({
      // LLM 配置
      provider: z.string().optional(),
      model: z.string().optional(),
      fallbackModel: z.string().optional(),
      anthropicKey: z.string().optional(),
      openaiKey: z.string().optional(),
      baseURL: z.string().optional(),
      maxTokens: z.number().min(1000).optional(),
      availableModels: z.array(ModelConfigSchema()).optional(),

      // 输出语言偏好（对标 Claude Code language 配置）
      language: z.enum(["zh", "en"]).optional(),

      // 权限配置
      permissions: PermissionsSchema().optional(),
      permissionMode: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
      disallowedTools: z.array(z.string()).optional(),

      // 环境变量
      env: z.record(z.string()).optional(),

      // Hooks（按事件分组）
      hooks: z.record(z.array(HookEntrySchema())).optional(),

      // MCP 服务器
      mcpServers: z.record(MCPServerSchema()).optional(),

      // 子代理模型映射
      subAgentModels: z.record(z.string()).optional(),

      // 配额
      quota: QuotaSchema().optional(),
      costLimit: z.number().positive().optional(),

      // 搜索
      search: SearchSchema().optional(),

      // Skills
      disabledSkills: z.array(z.string()).optional(),

      // 安全/行为
      sanitizeEnv: z.boolean().optional(),
      trustProjectExtensions: z.boolean().optional(),
      jitContext: z.boolean().optional(),
      // LLM 命令风险分类器（P0-3 迭代 II）
      enableLLMClassifier: z.boolean().optional(),
      classifierModel: z.string().optional(),

      // 推理强度 / 思考开关旋钮（/effort、/think 持久化端；缺省 = auto 跟随模型默认）
      effortLevel: z.enum(["low", "medium", "high", "max"]).optional(),
      thinkingEnabled: z.boolean().optional(),

      // 目录控制
      allowedDirectories: z.array(z.string()).optional(),
      blockedDirectories: z.array(z.string()).optional(),
    })
    .passthrough(), // 保留未知字段（向前兼容）
);

/** 从 Schema 推导 TypeScript 类型 */
export type SettingsJson = z.infer<ReturnType<typeof SettingsSchema>>;
