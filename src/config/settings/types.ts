/**
 * Settings Schema（Zod 驱动）与类型
 *
 * 从手写验证迁移到 Zod Schema，实现类型安全和验证的统一。
 * 使用 zod@3.25（已作为 @anthropic-ai/sdk 的依赖安装）。
 *
 * 关键设计点（见 Spec 15 §3.2）：
 * 1. lazySchema() 延迟求值——避免模块加载阶段的 CPU 开销
 * 2. .passthrough() 保留未知字段——向前兼容（旧版本不认识的新字段不被删除）
 *    ⚠ 所有嵌套 schema 也必须加 .passthrough()，否则 safeParse 后写回时会
 *    strip 掉用户在嵌套对象中的自定义字段（如 api_key/base_url snake_case 写法）。
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
  }).passthrough(),
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
  }).passthrough(),
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
  }).passthrough(),
);

/** 模型定价（每百万 token，USD） */
const ModelPricingSchema = lazySchema(() =>
  z.object({
    input: z.number().positive(),
    output: z.number().positive(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
  }).passthrough(),
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
  }).passthrough(),
);

/** 预算规则 Schema */
const BudgetRuleSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    period: z.enum(["session", "hourly", "daily", "weekly", "monthly"]),
    limit_usd: z.number().positive(),
    scope: z.object({ model: z.string().optional() }).passthrough().optional(),
    thresholds: z
      .object({
        warning: z.number().optional(),
        critical: z.number().optional(),
        exceeded: z.number().optional(),
      })
      .passthrough()
      .optional(),
    action: z.enum(["alert", "downgrade", "block"]).optional(),
  }).passthrough(),
);

/** 配额 Schema */
const QuotaSchema = lazySchema(() =>
  z.object({
    costLimit: z.number().positive().optional(),
    requestsPerMinute: z.number().positive().optional(),
    tokensPerMinute: z.number().positive().optional(),
    budgetRules: z.array(BudgetRuleSchema()).optional(),
  }).passthrough(),
);

/** 搜索配置 Schema */
const SearchSchema = lazySchema(() =>
  z.object({
    backend: z.enum(["searxng", "brave", "tavily", "duckduckgo"]).optional(),
    searxngUrl: z.string().optional(),
    braveApiKey: z.string().optional(),
    tavilyApiKey: z.string().optional(),
  }).passthrough(),
);

/**
 * 网络超时/重试配置 Schema（统一单套值，不分 direct/gateway，见 network-profile.ts）。
 * 各字段可对统一默认值做具体覆盖，同名环境变量（SID_CODE_*）优先级更高
 * （供运维/测试注入，向后兼容）。全部留空则用 DEFAULTS 的保活优先默认值。
 */
const NetworkTimeoutsSchema = lazySchema(() =>
  z.object({
    headerTimeoutMs: z.number().positive().optional(),
    watchdogNoProgressMs: z.number().positive().optional(),
    watchdogCheckIntervalMs: z.number().positive().optional(),
    watchdogHeaderGraceMs: z.number().nonnegative().optional(),
    maxTurnDurationMs: z.number().positive().optional(),
    maxSessionDurationMs: z.number().positive().optional(),
    maxTimeoutRetries: z.number().nonnegative().optional(),
    maxRetriesPerCall: z.number().nonnegative().optional(),
    retryBackoffBaseMs: z.number().nonnegative().optional(),
    retryBackoffMaxMs: z.number().positive().optional(),
  }).passthrough(),
);

/** Worktree 配置 Schema（Git Worktree 隔离系统） */
const WorktreeSettingsSchema = lazySchema(() =>
  z.object({
    /** 创建 worktree 时额外 symlink 的目录（默认 ["node_modules"]） */
    symlinkDirectories: z.array(z.string()).optional(),
    /** sparse-checkout 路径（monorepo 大仓只检出指定子树） */
    sparsePaths: z.array(z.string()).optional(),
    /** 基准 ref：fresh=origin/<default-branch>，head=当前 HEAD（默认 fresh） */
    baseRef: z.enum(["fresh", "head"]).optional(),
    /** 是否在 worktree 内安装 commit 归因 hook */
    commitAttribution: z.boolean().optional(),
    /** 自动复制到 worktree 的本地配置文件相对路径（默认 settings.local.json） */
    copyLocalSettings: z.boolean().optional(),
  }).passthrough(),
);

/** 可自定义状态栏 Schema（对标 claude-code statusLine）
 *  type=command：spawn 用户脚本，会话数据经 stdin 传 JSON，脚本 stdout 即状态栏内容。 */
const StatusLineSchema = lazySchema(() =>
  z.object({
    /** 目前仅支持 command 类型（跑外部脚本） */
    type: z.enum(["command"]).optional(),
    /** 要执行的 shell 命令/脚本路径。空则回退内置状态栏。 */
    command: z.string().optional(),
    /** 左侧留白列数（默认 0） */
    padding: z.number().min(0).optional(),
  }).passthrough(),
);

/** 完整 Settings Schema */
export const SettingsSchema = lazySchema(() =>
  z
    .object({
      // LLM 配置
      provider: z.string().optional(),
      model: z.string().optional(),
      fallbackModel: z.string().optional(),
      // 主模型重试耗尽后的降级模式：ask 询问用户 / auto 自动切默认 / off 不降级直接报错。
      // 缺省（未设）时消费点按 "ask" 兜底（生产默认询问）。
      fallbackSwitchMode: z.enum(["ask", "auto", "off"]).optional(),
      anthropicKey: z.string().optional(),
      openaiKey: z.string().optional(),
      baseURL: z.string().optional(),
      maxTokens: z.number().min(1000).optional(),
      availableModels: z.array(ModelConfigSchema()).optional(),

      // 输出语言偏好（对标 Claude Code language 配置）
      language: z.enum(["zh", "en"]).optional(),

      // UI 主题偏好（/theme 持久化端；缺省 = 内置默认暗色主题）
      theme: z.string().optional(),

      // Vim 输入模式开关（/vim 持久化端；缺省 = false）
      vimMode: z.boolean().optional(),

      // 全屏 Alternate Buffer 模式开关（/tui 持久化端；缺省 = false = 主屏 Static 模式，见 ADR-040）
      alternateBuffer: z.boolean().optional(),

      // UI 强调色/品牌色覆盖（/color 持久化端；缺省 = 跟随主题的 ui.active）。存 hex，如 "#89b4fa"
      accentColor: z.string().optional(),

      // Fast Mode 开关（/fast 持久化端；缺省 = false）。当前网关未提供对等 fast 能力，此开关为预留
      fastMode: z.boolean().optional(),

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
      // 禁用的 Hook 名列表（/hooks disable -p 持久化端；按 hook name/command/url 匹配）
      disabledHooks: z.array(z.string()).optional(),

      // 安全/行为
      sanitizeEnv: z.boolean().optional(),
      trustProjectExtensions: z.boolean().optional(),
      jitContext: z.boolean().optional(),
      // AskUserQuestion 交互态空闲超时（"60s"/"5m"/"never"，默认 never 对齐 CC 保守语义）。
      // 交互式 TUI 下单次提问级 idle 超时，到期按 cancelled resolve（模型收到"用户未响应，选默认继续"）。
      askUserQuestionTimeout: z.string().optional(),
      // LLM 命令风险分类器（P0-3 迭代 II）
      enableLLMClassifier: z.boolean().optional(),
      classifierModel: z.string().optional(),

      // 推理强度 / 思考开关旋钮（/effort、/think 持久化端；缺省 = auto 跟随模型默认）
      effortLevel: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      thinkingEnabled: z.boolean().optional(),

      // 目录控制
      allowedDirectories: z.array(z.string()).optional(),
      blockedDirectories: z.array(z.string()).optional(),

      // Worktree 隔离配置
      worktree: WorktreeSettingsSchema().optional(),

      // 可自定义状态栏（/statusline 持久化端；缺省 = 内置聚合状态栏）
      statusLine: StatusLineSchema().optional(),

      // 网络超时/重试配置（direct/gateway 场景适配）
      network: NetworkTimeoutsSchema().optional(),
    })
    .passthrough(), // 保留未知字段（向前兼容）
);

/** 从 Schema 推导 TypeScript 类型 */
export type SettingsJson = z.infer<ReturnType<typeof SettingsSchema>>;
