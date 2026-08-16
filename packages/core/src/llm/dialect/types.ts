/**
 * dialect —— 「一个协议族的差异，集中在一个模块里」。
 *
 * ## 为什么在 compat 布尔位之外还要这一层
 *
 * `model-compat.ts` 解决的是「**这条渠道**认不认某个字段」，能用布尔位表达。
 * 但族差异里有一部分**结构上就不同**，布尔位表达不了：
 *
 * | 差异 | 形态 | 布尔位能表达吗 |
 * | --- | --- | --- |
 * | 这家认不认 `reasoning_effort` | 一个标量字段的有无 | ✅ 能（compat 已覆盖） |
 * | DeepSeek 的 `thinking:{type:"enabled"}` vs Anthropic 的 `thinking:{budget_tokens:N}` | **请求体结构不同** | ❌ 不能 |
 * | GLM 的 `tool_choice` 只认 `auto`，其余降级而非报错 | **降级策略** | ⚠️ 勉强（PR-2 用了两位表达，见下） |
 * | Anthropic adaptive 模型按 effort 反查 budget 再钳制 | **算法** | ❌ 不能 |
 *
 * 本层收的就是后三类。`compat` 仍在它上面——**用户显式声明 > 族默认行为**，
 * 优先级链没变（见 `model-compat.ts` 的三层表）。
 *
 * ## 与「照抄参照实现」的差别（刻意不抄的两点）
 *
 * 参照实现（oh-my-pi 的 `dialect/`）是 24 个模块 5838 行，每族 240–609 行。
 * 我们**只有 7 族且其中 3 族的差异是纯声明式的**，照抄那个体量等于为 3 个布尔位
 * 建一个模块——那是把「收敛」做成了另一种散落。故本层分两种表达：
 *
 * 1. **声明式描述符**（{@link WireDialect}）——线格式上「发不发某字段、发什么形状」这类
 *    可枚举的差异。GLM 与 DeepSeek 在这一层**完全同构**，于是它们共享一份描述符，
 *    而不是各写一个模块。
 * 2. **函数钩子**（{@link Dialect.applyToSendParams}）——真正需要算法的部分
 *    （Anthropic 的 budget 映射与上限钳制）。
 *
 * 判据是「这条差异能不能被枚举完」：能就进描述符，不能才写函数。
 * 一律写函数会让 7 族出现 7 份高度重复的 if；一律写描述符则表达不了 Anthropic。
 *
 * ## 为什么分类逻辑必须只有一份（本层存在的**第一**理由）
 *
 * 重构前「这个模型属于哪一族」被实现了**三次**，判据是同一套正则：
 * `effort.ts classifyCapability`、`openai.ts applyDeepSeekThinking`、
 * `openai.ts applyToolChoice`。三份各自维护，且后两份已经不一致
 * （前者判 4 族、后者只判 2 族）。
 *
 * 这类重复的危害不是「代码多」，而是**新增一族时改一处、漏两处，且测试全绿**——
 * 漏掉的那处会静默走兜底分支：能力算出来了却从不进请求体（本仓 2026-08-01
 * 真实发生过一次，见 `classify.ts` 的 `classifyProtocolFamily` 注释）。
 * 故 {@link classifyProtocolFamily} 是**唯一**的分类入口。
 */

import type { SendParams } from "../types.ts";

/**
 * 协议族标识。与 `model-registry.ts` / `model-params-catalog.ts` 的 `protocolKind`
 * **同一套取值**——那是用户/注册表侧的声明，本类型是运行时的解析结果，两者必须同名同义，
 * 否则注册表声明了一个本层不认的族就会静默落到 `unknown`。
 */
export type ProtocolFamily =
  | "deepseek-openai"
  | "deepseek-anthropic"
  | "anthropic-native"
  | "o-series"
  | "glm-openai"
  | "grok-openai"
  | "openai-responses"
  | "unknown";

/** 统一推理强度档位（与 `effort.ts` 的 `EffortLevel` 同源，此处仅为避免反向 import 环） */
export type DialectEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 该族对 `tool_choice` 的约束。
 *
 * 三档而不是布尔，因为「不能发」与「只能发 auto」的**降级动作不同**：
 * 后者仍允许显式 auto 通过，前者连 auto 也不发。PR-2 的 compat 用两个布尔位
 * （`supportsToolChoice` / `toolChoiceAutoOnly`）表达同一件事，这里收成一个枚举，
 * 语义更封闭（两个布尔有 4 种组合，其中「不支持但仅限 auto」是无意义状态）。
 */
export type ToolChoiceConstraint =
  /** 无约束，原样下发 */
  | "full"
  /** 仅认 auto：其余取值降级为不下发（等价服务端默认 auto），而非冒 400。GLM 形态 */
  | "auto-only"
  /** 思考开启时整个不下发：DeepSeek V4 思考模式实测 400（`deepseek.md` §tool_choice） */
  | "reject-when-thinking";

/**
 * 线格式描述符 —— 该族在 **OpenAI 兼容 Chat Completions 请求体**上的差异。
 *
 * 只覆盖 Chat Completions 一条线是刻意的：Anthropic 原生与 Responses API 各有独立的
 * 请求构造器（`anthropic.ts buildThinkingParam` / `openai-responses-request.ts`），
 * 它们**不经过**这套顶层字段透传。给它们也编一份描述符，会造出一份没人读的配置
 * ——那正是 PR-2 刻意不加死字段的同一条理由。
 */
export interface WireDialect {
  /**
   * 顶层思考开关的形态。
   * - `"type-enum"`：`thinking:{type:"enabled"|"disabled"}`（DeepSeek / GLM）
   * - `"none"`：该族无显式开关（Grok / o-series：推理内置不可关）
   *
   * ⚠ 未知族刻意也是 `"none"`——thinking 的结构各家不同，瞎猜结构的 400 风险远高于
   * 一个标量字段，且**无法从错误文本反推正确结构，自愈救不回来**。
   */
  thinkingToggle: "type-enum" | "none";
  /** 是否下发顶层 `reasoning_effort` */
  sendsReasoningEffort: boolean;
  /**
   * `reasoning_effort` 是否受思考开关门控（思考显式关闭时不下发，避免与 `disabled` 冲突）。
   *
   * 这个差异对用户是**可见的**：GLM 上 `/think off` 之后 `/effort` 面板仍在切档但没有任何
   * 档位会真的发出去。`effort.ts isEffortGatedByThinking` 靠跑一次真实映射来探测它，
   * 不读本字段——保持「探测实际行为」而非「读声明」，声明与实现不一致时以实现为准。
   */
  effortGatedByThinking: boolean;
  /**
   * 线格式是否接受 `max` 档。`false` → 下发前钳到 `high`。
   *
   * 与 `effort.ts` 的 `supportsMaxEffort` 是**两道同口径的闸门**，不是重复：
   * 那道在能力解析层（主循环路径），这道在请求体装配层（**所有** OpenAI 族请求的唯一咽喉，
   * 含 side-call / headless 等不跑 cap 解析的路径）。两道幂等、不会打架。
   */
  allowsMaxEffort: boolean;
  /** 对 `tool_choice` 的约束 */
  toolChoice: ToolChoiceConstraint;
}

/** 该族的能力位（除 applier 外的描述字段，供状态栏/面板消费） */
export interface DialectFlags {
  /** 支持档位切换；false → 状态栏不显示 effort 列 */
  supportsEffort: boolean;
  /** 支持 max；false 时选 max 自动降 high */
  supportsMaxEffort: boolean;
  /** 支持显式思考开关；false → 不显示 thinking 列 */
  supportsThinkingToggle: boolean;
  /** thinking 默认是否开（影响 auto 态展示与下发） */
  thinkingDefaultOn: boolean;
  /** auto 态下状态栏展示用的默认档位 */
  defaultEffort: DialectEffortLevel;
}

/**
 * 一个协议族的完整差异声明。
 *
 * `applyToSendParams` 是「统一档位 → 该族的 SendParams 形态」的唯一翻译处；
 * `wire` 是「SendParams → Chat Completions 请求体」的差异声明。
 * 两段各管一截，串起来才是一次请求的完整族差异。
 */
export interface Dialect {
  kind: ProtocolFamily;
  flags: DialectFlags;
  wire: WireDialect;
  /**
   * 把统一档位翻译成该族的线格式，原地 patch 进 SendParams。
   *
   * @param params   目标 SendParams（原地修改）
   * @param effort   解析后的最终档位；undefined = auto（不显式下发 effort）
   * @param thinking 解析后的最终开关（已是明确 boolean，无 auto）
   */
  applyToSendParams(
    params: SendParams,
    effort: DialectEffortLevel | undefined,
    thinking: boolean,
  ): void;
}
