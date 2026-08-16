/**
 * model-compat —— 「这条渠道支持哪些协议能力」的用户显式声明层（数据，不是代码分支）。
 *
 * ## 为什么需要这一层
 *
 * 族差异当前是**代码**：`effort.ts` 813 行的 8 族矩阵、`openai.ts` 里 16 处族分支，
 * 全仓 199 处族关键字散在 15 个文件（2026-08-15 实测，命令见 PR 正文）。后果是
 * **上一家新厂商就得改一次代码**——而判据往往只是「这家认不认 `thinking` 字段」这种
 * 一个布尔位就能表达的事实。
 *
 * 本模块把其中**能用布尔位表达的那部分**从代码搬到配置：用户在 `availableModels[].compat`
 * 里声明，三处族判定读它。行为差异（如 DeepSeek 的 `thinking:{type}` vs Anthropic 的
 * `{budget_tokens}` 结构转换）**不在本模块范围内**——那需要 dialect 模块，是下一步的事。
 *
 * ## 字段从「我们真正踩过的差异」挑，不照抄
 *
 * 参照实现（openclaw）有 24 位。这里只有 6 位，每一位都能指到本仓已有的一处族分支
 * 与一份厂商文档依据（见各字段注释）。**没踩过的差异不预先加位**：一个没人配、
 * 没人读的布尔位是死字段，而死字段会让人误以为这层已经覆盖了它其实没覆盖的事。
 *
 * ## 与内置注册表、与 400 自愈的关系（三层，谁也不替代谁）
 *
 * | 层 | 来源 | 权威度 | 覆盖面 |
 * | --- | --- | --- | --- |
 * | `compat`（本模块） | 用户显式声明**这条渠道** | **最高** | 只覆盖用户配了的 |
 * | `model-registry.ts` | 内置注册表按模型名前缀/家族匹配 | 中 | 只覆盖已登记的模型 |
 * | `withCapabilityHealing` + `model-capabilities.ts` | 真实请求 400 反推 | 兜底 | 全部模型 |
 *
 * ⚠ **`compat` 不替代自愈，`withCapabilityHealing`（`openai.ts:650`）不能因为有了它就删。**
 * 恰恰相反，两者互补且叠加后比任何单独一层都强：`compat` 给先验（企业自建网关上的私有
 * 模型名，注册表按名匹配必然 miss，只有用户自己知道它认什么），自愈修正先验（用户也会
 * 配错，配错了仍然自愈到能跑）。参照实现有 compat 无自愈——新模型 compat 猜错就是错；
 * 我们此前有自愈无 compat——每家差异都要写代码分支。
 *
 * ## 为什么按**别名**（`name`）建键，而不是按真名（`modelId`）
 *
 * `compat` 表达的是「**这条渠道**认什么」，不是「这个模型认什么」——同一个真名接两个渠道
 * （官方端点 + 公司网关），网关那条可能因为自己做了参数透传过滤而不认 `thinking`。
 * 这与 `supportsThinking` 的既有口径一致（见 `query/loop.ts:1821` 的注释：
 * 「那是用户对**这条渠道**的显式声明，权威度高于按名推导」）。
 *
 * 注意这与 `wire-model.ts:27` 的「能力判定必须吃真名」**不矛盾**：那条说的是
 * `lookupRegistry` / `resolveEffortCapability` 的**按名匹配**必须喂真名（喂别名会静默
 * miss 退化到兜底值）；本模块不做任何按名匹配，它是精确查表。
 *
 * ## 为什么要进程级表，而不是逐个调用点传参
 *
 * 与 `wire-model.ts` 的 `_aliasMap` 同一个理由（那里写得更细）：`applyDeepSeekThinking` /
 * `applyToolChoice` 在 `OpenAIProvider` 内部，手上只有 `SendParams`，拿不到 `Config`。
 * 逐个调用点补参数有两个已知会犯的错——漏一处就是那条路径静默不生效（且只在用户真配了
 * `compat` 时才现形，单测全绿放过），以及以后新增调用点的人不知道要补。
 *
 * 空表（绝对多数用户的常态）时所有查询立即短路返回 `undefined`，零开销、零行为变化。
 */

/** 解析所需的最小结构（避免为一个字段反向依赖 config.ts，防 import 环，同 WireModelEntry） */
export interface ModelCompatEntry {
  name?: string;
  compat?: ModelCompat;
}

/**
 * 单条渠道的协议能力声明。**全部可选**——缺省即「不声明」，回落内置判定，
 * 不是「声明为 false」。这个区分是本模块的核心语义：`undefined` ≠ `false`。
 */
export interface ModelCompat {
  /**
   * 是否接受 `reasoning_effort` 顶层字段。
   * `false` → 任何档位都不下发（等价于该模型无推理强度概念）。
   *
   * 对应既有代码分支：`effort.ts` 的 `CAPABILITY_FLAGS.unknown`（不下发 effort），
   * 以及 `openai.ts applyDeepSeekThinking` 里四族各自的 `params.reasoningEffort &&` 守卫。
   */
  supportsReasoningEffort?: boolean;
  /**
   * 是否接受 `thinking:{type:enabled/disabled}` 思考开关（DeepSeek / GLM 形态）。
   * `false` → 只下发 `reasoning_effort`，不下发 `thinking`。
   *
   * 依据：Grok（`grok-api.md:30,157,277`）与 OpenAI o-series 无思考开关；
   * 未知族也刻意不下发（`openai.ts:348` 的 `isUnknownFamily` 注释——thinking 结构各家
   * 不同，瞎猜结构的 400 风险远高于一个标量字段，且无法从错误文本反推正确结构，自愈救不回来）。
   */
  supportsThinkingToggle?: boolean;
  /**
   * 是否接受 `max` 这一档 effort。`false` → `max` 钳到 `high`。
   *
   * 依据：Grok 只有 none/low/medium/high（`grok-api.md:30`）、o-series 只有 low/medium/high，
   * 两处既有代码都写着 `params.reasoningEffort !== "max"` 的硬守卫（`openai.ts:386,392`）；
   * GLM 的 max 仅 GLM-5.2 生效（`glm-api.md:189`）。
   */
  supportsMaxEffort?: boolean;
  /**
   * 是否接受 `tool_choice` 字段。`false` → 不下发（保留模型自主调用）。
   *
   * 依据：DeepSeek V4 思考模式实测 400（`openai.ts:412` 的 §2.4 注释，
   * OMP 官方配置亦标注 `supportsToolChoice: false`）。
   */
  supportsToolChoice?: boolean;
  /**
   * `tool_choice` 是否**仅**支持 `auto`。`true` → 其余取值（none/required/指定函数）
   * 降级为不下发（等价服务端默认 auto），而不是冒 400。
   *
   * 依据：GLM（`glm-api.md:147,276,431`）。与 `supportsToolChoice: false` 的区别是
   * 它仍允许显式 auto 通过。
   */
  toolChoiceAutoOnly?: boolean;
  /**
   * 多轮工具调用时是否要求回传 `reasoning_content`。
   *
   * 与 `model-registry.ts` 同名字段同义，本字段是**用户对这条渠道的覆盖**：
   * 注册表按模型名匹配，私有网关上的私有模型名匹配不到（DeepSeek V4 thinking 系为
   * `true`，回传缺失会 400 + 思维链断裂；旧 `deepseek-reasoner` 为 `false`，回传反而 400）。
   * 两个方向都会错，且都不是自愈能救的——故必须给用户一个显式出口。
   */
  requiresReasoningContentForToolCalls?: boolean;
}

/** compat 的全部合法键。归一化与校验共用，避免两处手写清单漂移（本仓「手写字段列表」有多次前科） */
export const MODEL_COMPAT_KEYS: readonly (keyof ModelCompat)[] = [
  "supportsReasoningEffort",
  "supportsThinkingToggle",
  "supportsMaxEffort",
  "supportsToolChoice",
  "toolChoiceAutoOnly",
  "requiresReasoningContentForToolCalls",
];

/** `MODEL_COMPAT_KEYS` 的 Set 形态（校验侧只需要 O(1) 判存在，不重复手写清单） */
export const COMPAT_KEY_SET: ReadonlySet<string> = new Set(MODEL_COMPAT_KEYS);

/**
 * snake_case → camelCase 别名表（settings.json 两种风格都要认）。
 *
 * 与 `config.ts` 的 `availableModels` 归一化同一个理由：漏一个键等于用户配了却被静默丢弃。
 * 这里显式登记而不是跑通用下划线转换，是为了让「合法键集合」保持封闭——
 * 未登记的键会被 `normalizeModelCompat` 丢掉并由 schema 出告警，而不是静默带进对象。
 */
export const COMPAT_KEY_ALIASES: Record<string, keyof ModelCompat> = {
  supports_reasoning_effort: "supportsReasoningEffort",
  supports_thinking_toggle: "supportsThinkingToggle",
  supports_max_effort: "supportsMaxEffort",
  supports_tool_choice: "supportsToolChoice",
  tool_choice_auto_only: "toolChoiceAutoOnly",
  requires_reasoning_content_for_tool_calls: "requiresReasoningContentForToolCalls",
};

/**
 * 把用户手写的 compat 对象归一化成 `ModelCompat`，非法内容一律丢弃（不抛）。
 *
 * **必须容错到不抛**：本函数在 `loadConfig` 链上，抛出即整个进程起不来
 * （`cli.ts` 只 console.error + exit(1)），用户配错一个类型就完全无法启动——
 * 比「该字段不生效」严重得多。与 `wire-model.ts normalizeWire` 同一口径：
 * 就地容错，由 `config/schema.ts` 出可读告警。
 *
 * 返回 `undefined` 表示「没有任何有效声明」，便于直接塞进可选字段
 * （空对象 `{}` 会让下游的 `compat ? ... : ...` 判断误以为有声明）。
 */
export function normalizeModelCompat(raw: unknown): ModelCompat | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: ModelCompat = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    // 先查 snake_case 别名表，再看是否本就是合法 camelCase 键；两者都不是 → 丢弃。
    const key: keyof ModelCompat | undefined =
      COMPAT_KEY_ALIASES[rawKey] ??
      ((MODEL_COMPAT_KEYS as readonly string[]).includes(rawKey)
        ? (rawKey as keyof ModelCompat)
        : undefined);
    if (!key) continue;
    // 只认真布尔。`"false"` 这种字符串**刻意不做真值转换**——把字符串 "false" 当成 true
    // 或当成 false 都是猜，而两个方向猜错的后果相反（多发字段 400 / 该发的没发静默失效）。
    // 丢弃 + 告警让用户自己改对，是唯一不会静默失真的处理。
    if (typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 进程级 compat 表（别名 → 声明）。只收录**真正配了 compat** 的条目，
 * 空表时置 `null` 让查询立即短路（绝大多数用户的常态）。
 */
let _compatMap: Map<string, ModelCompat> | null = null;

/**
 * 注册 compat 表。由 `resolveCurrentModelConfig` 调用（启动解析与 `/model` 运行时切换的
 * 共同咽喉），幂等、可重复调。
 *
 * 传 `undefined` 或空列表即**清空**——与 `setWireModelAliases` 同一条硬要求：
 * 切到「没有任何 compat 配置」的状态时必须真清掉，否则上一份配置的声明残留，
 * 会让新配置按旧声明发字段且不报错。
 */
export function setModelCompat(models?: readonly ModelCompatEntry[]): void {
  const map = new Map<string, ModelCompat>();
  for (const m of models ?? []) {
    // name 同样可能是用户手写的脏值（数字 / null），直接 .trim() 会抛 TypeError。
    const alias = typeof m?.name === "string" ? m.name.trim() : "";
    if (!alias) continue;
    const compat = normalizeModelCompat(m?.compat);
    // 同名多条时保留**第一条**，与选择侧 find-first（`resolveCurrentModelConfig` /
    // `/model <name>`）严格同语义——否则「选的是第一条、按第二条的声明发字段」。
    if (compat && !map.has(alias)) map.set(alias, compat);
  }
  _compatMap = map.size > 0 ? map : null;
}

/**
 * 查这条渠道的 compat 声明。
 *
 * @param alias 本地别名（`params.model` / `config.model` / fallback 名 / 子代理模型名）
 *
 * 未配置返回 `undefined`——调用方必须把 `undefined` 当「不声明、回落内置判定」处理，
 * **不能**当 false。
 */
export function lookupModelCompat(alias?: string): ModelCompat | undefined {
  if (!_compatMap || !alias) return undefined;
  return _compatMap.get(alias);
}

/**
 * 直接从模型列表构造 compat 表，**不读也不写**进程级全局表。
 *
 * 与 `exportModelCompat` 的分工（同 `wire-model.ts` 那对函数）：后者导出当前全局表，
 * 依赖 `resolveCurrentModelConfig` 已跑过；本函数从配置现算，**不依赖任何调用时序**，
 * 适合 registry 这类可能在任何时机被调的地方。两者口径一致（同一套过滤 + 容错）。
 *
 * 空表返回 `undefined`，便于直接塞进可选协议字段。
 */
export function buildModelCompatMap(
  models?: readonly ModelCompatEntry[],
): Record<string, ModelCompat> | undefined {
  if (!models?.length) return undefined;
  const out: Record<string, ModelCompat> = {};
  for (const m of models) {
    const alias = typeof m?.name === "string" ? m.name.trim() : "";
    if (!alias) continue;
    const compat = normalizeModelCompat(m?.compat);
    // 同名多条保留第一条，与选择侧 find-first 严格同语义。
    if (compat && !(alias in out)) out[alias] = compat;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 导出整张表用于**跨进程**播种（spawn 子代理），与 `setModelCompatFromMap` 对偶。
 *
 * 为什么子进程需要整张表而不是单条：子进程里存在**换模型**的路径（`ModelFallback` 降级），
 * 只播种主模型那一条的话，降级目标查不到 compat → 按内置判定发字段 → 用户声明失效，
 * 而降级恰恰是主模型已出问题时的最后一道防线。与 `exportWireModelAliases` 同一理由。
 *
 * 空表返回 `undefined`，让调用方能直接塞进可选协议字段（没配 compat 的用户零多余字节）。
 */
export function exportModelCompat(): Record<string, ModelCompat> | undefined {
  if (!_compatMap || _compatMap.size === 0) return undefined;
  return Object.fromEntries(_compatMap);
}

/**
 * 用普通对象播种 compat 表（跨进程解码侧）。
 *
 * 子进程收到的是 JSON 反序列化结果，键值都可能是脏的（老版本父进程、手工构造的 init
 * 消息），故每条都重新过 `normalizeModelCompat`，与编码侧同一套容错口径。
 */
export function setModelCompatFromMap(map?: Record<string, unknown>): void {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    setModelCompat();
    return;
  }
  setModelCompat(Object.entries(map).map(([name, compat]) => ({ name, compat: compat as never })));
}

/** 仅供测试：清空 compat 表，避免跨用例串味 */
export function resetModelCompat(): void {
  _compatMap = null;
}
