/**
 * 请求输出预算（request output budget）——「**本次请求**打算预留多少输出」。
 *
 * ## 为什么必须有这个模块
 *
 * 这是两个必须分开的概念，历史上被混成了一个：
 *
 * | 概念 | 含义 | 来源 |
 * |---|---|---|
 * | 物理上限 `maxOutputTokens` | 模型 / 渠道「**最多能**输出多少」 | `availableModels[].maxOutputTokens` > 能力目录 > 内置注册表 |
 * | 请求预算 | 本次请求「**打算**预留多少输出」 | `--max-tokens` / `SID_MAX_OUTPUT_TOKENS` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS` > settings `maxTokens` > 默认常量 |
 *
 * 混用有两个后果，都已在排查报告里核实：
 *  - 发送侧（F1）：注册表里的物理上限（DeepSeek 384k）被原样当作每次请求的 `max_tokens`
 *    发出，而 OpenAI 兼容协议族按「输入 + max_tokens ≤ 窗口」校验，输入超过约 664k
 *    （= 1,048,576 − 384,000）就被 400 拒绝——为一次也没用到的 384k 输出让出 37% 输入空间。
 *  - 压缩侧（F8）：`ContextManager` 的「完成缓冲区」拿同一个物理上限算输出预留，
 *    1M 窗口下把 emergency 门槛抬到 140k（本该 52k），压缩提前触发。
 *
 * ## 本文件的两个消费者
 *
 * 1. **压缩缓冲区（F8）** 用 {@link resolveRequestBudget}：只回答「预算基准」，
 *    **不含任何钳制**。它要的是「本次回复大概要写多少」的预估，不能随真实用量抖动
 *    （否则阈值跟着输入量上下漂，压缩会在边缘反复触发）。
 * 2. **发送请求（F1）** 用 {@link resolveRequestOutputBudget}：在预算基准之上叠加
 *    物理上限钳制 + 窗口剩余钳制 + 窗口不足时拒绝发送 + 思考预算下限。
 *
 * 两者共用 {@link DEFAULT_REQUEST_MAX_TOKENS} 与同一套 floor（与 `fallback.ts` 的
 * 溢出恢复共用），不各写一份 —— 本仓教训：同一口径重实现一遍等于重踩一遍。
 *
 * ## 窗口钳制必须有下界
 *
 * `窗口 − 输入 − 余量` 在输入逼近窗口时会趋近 0 甚至为负（估算值本身也可能大于窗口）。
 * 直接发出去就是非法 `max_tokens`，必然换一个 400。所以这里在窗口剩余低于 floor 时
 * **返回「不发请求」的结构化结果**，由调用方交给压缩 / 报错路径 —— 不要发一个 0 或负数。
 */

/** 默认请求输出预算（所有模型通用，**不按模型名 / 模型族分档**）。
 *
 *  取 2^15 的依据（报告 §5.1 与 §7.2）：
 *  - `defaultConfig()` 的兜底值本来就是 `maxTokens: 32768`（`config/config.ts`），
 *    沿用它可以把「默认预算」与「兜底值」收敛成同一个数，不必再引入新的魔法数。
 *  - 全族实测 p99.9 均低于它（DeepSeek 10,995 / Claude 5,129 / GLM 19,616 /
 *    GPT 14,737 / Kimi 2,100），超过 32k 的请求只占 0.005%（2/41,961）。
 *  - 与 Claude Code 的默认输出上限同量级（CC 默认 32k，可经 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
 *    调整，sid-code 已兼容该环境变量）。 */
export const DEFAULT_REQUEST_MAX_TOKENS = 32_768;

/**
 * 解析「本次请求的输出预算基准」——只回答「打算预留多少」，**不做**物理上限 / 窗口钳制。
 *
 * 优先级：用户显式值（`--max-tokens` / `SID_MAX_OUTPUT_TOKENS` / settings `maxTokens`，
 * 收口在 `config._explicitMaxTokens`）> 默认常量。
 *
 * ⚠️ `availableModels[].maxOutputTokens` 是**物理上限**，不是预算，绝不要传进这里——
 * 用户写了 384k 渠道上限就每次请求发 384k，等于把 F1 原样复发。
 *
 * 非法值（undefined / NaN / ≤0）回退默认常量，绝不返回 0 或负数。
 */
export function resolveRequestBudget(explicitMaxTokens?: number): number {
  if (
    explicitMaxTokens !== undefined &&
    Number.isFinite(explicitMaxTokens) &&
    explicitMaxTokens > 0
  ) {
    return Math.floor(explicitMaxTokens);
  }
  return DEFAULT_REQUEST_MAX_TOKENS;
}

/** 窗口钳制的安全余量。
 *
 *  与 `fallback.ts` 的溢出恢复同源（原先各自是私有常量 `SAFETY_BUFFER = 1_000`）：
 *  估算与真实 token 之间总有残差，留 1k 让「输入 + max_tokens」不贴着窗口边界。 */
export const OUTPUT_BUDGET_SAFETY_BUFFER = 1_000;

/** 思考预算之外的正文余量。
 *
 *  Anthropic manual 模式（旧模型）下发 `budget_tokens`，API 硬性要求
 *  `budget_tokens < max_tokens`。只把 thinking 预算「一并计入」不够 —— 必须保证
 *  `max_tokens ≥ budget_tokens + 正文余量`，否则全文都花在思考上，正文一个字没写就截断。
 *  取 8,192：structural 常量，与具体模型无关。 */
export const THINKING_BODY_RESERVE = 8_192;

/** Anthropic `budget_tokens` 的最小值（官方下限 1024）。 */
export const MIN_THINKING_BUDGET = 1_024;

/** 溢出恢复 / 窗口下界检查的最小输出 token 数（绝对下限）。
 *  历史固定值 3000 —— 对输出能力 128K 的模型，降到 3K 几乎等于放弃恢复。 */
export const FLOOR_OUTPUT_TOKENS = 3_000;

/** floor 占 contextWindow 的比例（默认 5%）。
 *  对 1M 窗口模型给出 50K floor，对 200K 给 10K，远比固定 3K 更贴合模型能力。 */
export const FLOOR_OUTPUT_RATIO = 0.05;

/**
 * 解析「窗口里至少要能放下的输出量」下限。
 *
 * 优先级：`SID_RECOVERY_FLOOR_TOKENS` 显式值 > `contextWindow × 5%`（与绝对下限取大）
 * > 绝对下限 3000。非法 env 值（NaN/≤0）静默回退，绝不更紧。
 *
 * ⚠️ 发送前的窗口下界检查与 fallback 的溢出恢复**共用本函数**，所以这个 env 会同时
 * 影响两条路径 —— 刻意如此：两处问的是同一个问题（「窗口里还剩不剩得下这么多输出」）。
 */
export function resolveFloorOutputTokens(contextWindow: number): number {
  const raw = process.env.SID_RECOVERY_FLOOR_TOKENS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (contextWindow > 0) {
    return Math.max(FLOOR_OUTPUT_TOKENS, Math.floor(contextWindow * FLOOR_OUTPUT_RATIO));
  }
  return FLOOR_OUTPUT_TOKENS;
}

/** 本次请求的输出预算输入。全部是结构性事实，不含模型名。 */
export interface RequestOutputBudgetInput {
  /** 请求预算（用户显式值或默认常量），**不含**窗口钳制。 */
  requestBudget: number;
  /** 模型 / 渠道的物理输出上限；undefined = 未知（不钳制，交给窗口约束）。 */
  modelMaxOutputTokens?: number;
  /** 上下文窗口（ContextManager 的 maxTokens）。 */
  contextWindow: number;
  /** 本次请求的输入估算（含 system / tools），口径来自 `ctxMgr.estimateTokens()`。 */
  estimatedInputTokens: number;
  /** 思考预算（Anthropic manual 模式的 budget_tokens）。非思考场景传 undefined。 */
  thinkingBudgetTokens?: number;
}

/** 被哪一项钳住：request = 预算本身最小；model = 物理上限；window = 窗口剩余。 */
export type OutputBudgetClampSource = "request" | "model" | "window";

export type RequestOutputBudget =
  | {
      ok: true;
      /** 本次请求实际可发的 max_tokens。 */
      maxTokens: number;
      /** 调整后的思考预算（可能因窗口钳制被同步下调）；undefined = 不下发思考预算。 */
      thinkingBudgetTokens?: number;
      clampedBy: OutputBudgetClampSource;
    }
  | {
      ok: false;
      reason: "window_exhausted";
      /** 诊断用：窗口、输入估算、窗口剩余与 floor 的原始值。 */
      contextWindow: number;
      estimatedInputTokens: number;
      windowLimitTokens: number;
      floorTokens: number;
    };

/** 把任意输入归一成有效预算。与 {@link resolveRequestBudget} 同一事实源，
 *  避免「预算基准」与「发送侧预算」两处各自判断非法值。 */
function normalizeBudget(n: number): number {
  return resolveRequestBudget(Number.isFinite(n) && n > 0 ? n : undefined);
}

/**
 * 计算本次请求的 max_tokens（纯函数，无 IO，不读模型名）。
 *
 * 公式（顺序即优先级，全部满足）：
 *
 * ```text
 * desired    = max(requestBudget, thinkingBudget + THINKING_BODY_RESERVE)
 * desired    = min(desired, modelMaxOutputTokens)          // 物理上限
 * desired    = min(desired, 窗口 − 输入估算 − SAFETY_BUFFER) // 窗口钳制
 * windowLimit < floor → 不发请求
 * 若窗口钳制把 desired 压到 ≤ thinkingBudget → 同步下调 thinkingBudget
 * ```
 *
 * 顺序不能反：思考预算下限必须在物理上限与窗口钳制**之前**生效，否则
 * 「max 档 50K + 默认预算 32K」会在第一步就被预算钳到 32K、随后被当成合法的
 * `budget_tokens(50K) ≥ max_tokens(32K)` 发出去，Anthropic 直接 400。
 */
export function resolveRequestOutputBudget(input: RequestOutputBudgetInput): RequestOutputBudget {
  const contextWindow = Math.max(0, Math.floor(input.contextWindow));
  const estimatedInputTokens = Math.max(0, Math.ceil(input.estimatedInputTokens));
  const floorTokens = resolveFloorOutputTokens(contextWindow);
  const windowLimitTokens = contextWindow - estimatedInputTokens - OUTPUT_BUDGET_SAFETY_BUFFER;

  // 输入本身已经逼近（甚至超过）窗口：无论 max_tokens 写多少都发不出去。
  // 返回结构化结果，由调用方交给压缩 / 报错 —— 不要发一个 0 / 负数换一次必然的 400。
  if (windowLimitTokens < floorTokens) {
    return {
      ok: false,
      reason: "window_exhausted",
      contextWindow,
      estimatedInputTokens,
      windowLimitTokens,
      floorTokens,
    };
  }

  const requestBudget = normalizeBudget(input.requestBudget);
  const thinkingBudget =
    input.thinkingBudgetTokens !== undefined &&
    Number.isFinite(input.thinkingBudgetTokens) &&
    input.thinkingBudgetTokens > 0
      ? Math.floor(input.thinkingBudgetTokens)
      : undefined;

  // 第 1 步：思考预算下限（保证 budget_tokens < max_tokens 且正文有空间）。
  let desired = requestBudget;
  if (thinkingBudget !== undefined) {
    desired = Math.max(desired, thinkingBudget + THINKING_BODY_RESERVE);
  }
  let clampedBy: OutputBudgetClampSource = "request";

  // 第 2 步：物理上限。`availableModels[].maxOutputTokens` 表达的是「这条渠道最多能输出
  // 多少」，只作上限、不作预算 —— 用户想表达「我要更大的输出预算」的入口是
  // settings.maxTokens / --max-tokens，不是它。
  const modelMax = input.modelMaxOutputTokens;
  if (modelMax !== undefined && Number.isFinite(modelMax) && modelMax > 0 && desired > modelMax) {
    desired = Math.floor(modelMax);
    clampedBy = "model";
  }

  // 第 3 步：窗口钳制（保证「输入 + max_tokens ≤ 窗口」）。
  if (desired > windowLimitTokens) {
    desired = windowLimitTokens;
    clampedBy = "window";
  }

  // 第 4 步：窗口钳制可能把 max_tokens 压到 ≤ thinkingBudget，破坏
  // `budget_tokens < max_tokens` 的硬约束。同步下调 budget_tokens 到「max_tokens − 正文余量」；
  // 余量都放不下时关掉思考（返回 undefined），而不是发一个非法组合。
  let adjustedThinking = thinkingBudget;
  if (adjustedThinking !== undefined && adjustedThinking >= desired) {
    const next = desired - THINKING_BODY_RESERVE;
    adjustedThinking = next >= MIN_THINKING_BUDGET ? next : undefined;
  }

  return {
    ok: true,
    maxTokens: desired,
    thinkingBudgetTokens: adjustedThinking,
    clampedBy,
  };
}
