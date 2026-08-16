/**
 * 协议族分类 —— **唯一**入口。
 *
 * ## 为什么这件事必须只有一份实现
 *
 * 重构前「这个模型属于哪一族」被写了三次，判据是同一套正则：
 *
 * | 位置 | 判几族 | 兜底正则 |
 * | --- | --- | --- |
 * | `effort.ts classifyCapability` | 6 族（含 anthropic-native / deepseek 双端点） | 全套 |
 * | `openai.ts applyDeepSeekThinking` | 4 族（deepseek/glm/grok/o-series） | 同一套的子集 |
 * | `openai.ts applyToolChoice` | 2 族（deepseek/glm） | 同一套的子集 |
 *
 * 三份**已经不一致**，且不一致本身是合理的（后两者只关心 OpenAI 兼容线上的族）。
 * 危害不在「代码重复」，而在**新增一族时改一处、漏两处，而测试全绿**——漏掉的那处
 * 静默走兜底分支。这不是假想：2026-08-01 实测 `kimi-k3` / `qwen3-coder-plus` 等未知族
 * 模型，`effort.ts` 乐观放行算出了 `reasoningEffort="high"`，但 `openai.ts` 的分派只认
 * 四族、未知族没有任何分支接它 —— 字段算出来却**从不进 requestBody**。连带后果是
 * 400 自愈闭环在它唯一的目标人群上整链空转（不发字段 ⇒ 服务端不报错 ⇒ 自愈永不触发）。
 *
 * 故本模块导出**一个**分类函数，三处共用；「只关心哪几族」由调用方自己判断
 * 返回值，而不是各自重写一遍分类。
 *
 * ## 判据优先级（与重构前逐字一致，刻意不趁机改行为）
 *
 * 1. **注册表声明的 `protocolKind`**（精确、可预测）
 * 2. **模型名/端点正则兜底**（未注册模型）
 * 3. `unknown`
 *
 * ⚠ 本次重构是**纯搬迁**：判据、顺序、正则全部照抄原实现，一个字符都没改。
 * 行为等价由 `tests/llm/dialect-classify-parity.test.ts` 的对照断言锁住——
 * 那份测试对同一批模型名同时跑新旧两条路径并逐一比对。**重构与改行为不能混在一个
 * PR 里**：混了以后回归红了分不清是搬错了还是改对了。
 */

import { lookupCatalog } from "../model-params-catalog.ts";
import type { ProtocolFamily } from "./types.ts";

/**
 * 分类所需的输入。
 *
 * `model` **必须是真名**（`wireModel`/registry 里的那个），不是本地别名——本函数按模型名
 * 做前缀/家族匹配，喂别名会静默 miss 退到 `unknown`。这与 `wire-model.ts:27` 的
 * 「能力判定必须吃真名」是同一条约束。
 *
 * 渠道级的用户声明（`compat`）**不在这里读**：分类回答「这是哪一族」，compat 回答
 * 「这条渠道认什么」，后者叠在前者之上（见 `model-compat.ts` 的三层表）。混进来会让
 * 「族」这个概念随渠道漂移。
 */
export interface ClassifyInput {
  /** 模型真名 */
  model: string;
  /** provider 名（`"anthropic"` / `"openai"` / …）。缺省时只按模型名判 */
  provider?: string;
  /** 端点 URL，用于区分 DeepSeek 的 OpenAI 兼容端点与 Anthropic 兼容端点 */
  baseURL?: string;
}

/**
 * 判定模型属于哪个协议族。
 *
 * @returns 精确族名，或 `"unknown"`（未注册且不匹配任何兜底正则）
 */
export function classifyProtocolFamily(input: ClassifyInput): ProtocolFamily {
  const { model, provider, baseURL } = input;

  // 优先级 1：注册表声明（精确）。
  const declared = lookupCatalog(model)?.protocolKind;
  if (declared) return declared;

  // 优先级 2：模型名/端点正则兜底（处理未注册模型）。
  const isDeepSeek = /deepseek/i.test(model);
  if (isDeepSeek) {
    // DeepSeek 同时提供 OpenAI 兼容与 Anthropic 兼容两个端点，线格式不同
    // （前者 `reasoning_effort` 顶层字段，后者 `output_config.effort`），
    // 故必须看 baseURL 才能定族。
    const isAnthropicEndpoint = !!baseURL && /\/anthropic/i.test(baseURL);
    return isAnthropicEndpoint ? "deepseek-anthropic" : "deepseek-openai";
  }
  // 原生 Claude：provider 为 anthropic 且非 deepseek（deepseek 已在上面短路）。
  if (provider === "anthropic" || /^claude/i.test(model)) return "anthropic-native";
  // OpenAI o-series（o1 / o3 / o4 …）。
  if (/^o[0-9]/i.test(model)) return "o-series";
  // 智谱 GLM（OpenAI 兼容端点）。
  if (/^glm/i.test(model)) return "glm-openai";
  // xAI Grok（OpenAI 兼容端点）。
  if (/grok/i.test(model)) return "grok-openai";

  // ⚠ 刻意**没有** `/^gpt-5\./i` 这条兜底。
  //
  // Responses API 族的判据是「该端点/模型是否走 /v1/responses」这一**协议事实**，
  // 由 `openai.ts shouldUseResponsesAPI` 统一裁决（它还要看 env 开关与是否官方端点），
  // 不在这里复制模型名正则。曾经这里写过 `/^gpt-5\./i`——那正是「出一个新模型改一次代码」
  // 的老路，且违反「不按模型名硬编码分档」这条既有约定。
  //
  // 未注册模型的 effort 能力改由 `model-capabilities.ts` 的动态采集
  //（外部目录 + 服务端自报探针 + 400 自愈）数据驱动，见 `effort.ts` 的优先级 2.5。
  return "unknown";
}

/**
 * 该族是否走 **OpenAI 兼容 Chat Completions** 线格式（即会经过 `openai.ts` 的顶层字段透传）。
 *
 * 用途：`openai.ts` 里那两处原本只判「是不是 deepseek/glm/grok/o-series」的地方，改为先拿族
 * 再问这个谓词，于是「未知族」不再需要各处手写
 * `!isDeepSeek && !isGLM && !isGrok && !isOSeries` 这种**每加一族就要改一次**的排除式。
 *
 * ⚠ `anthropic-native` / `deepseek-anthropic` / `openai-responses` 返回 false：它们各有独立
 * 请求构造器（`anthropic.ts` / `openai-responses-request.ts`），根本不经过这条线。
 * 把它们算进来会让 Responses 专属的 `xhigh`/`max` 档位被当普通 `reasoning_effort`
 * 发到 Chat Completions 线上（2026-08-08 前的真实缺陷形态）。
 */
export function isChatCompletionsFamily(kind: ProtocolFamily): boolean {
  return (
    kind === "deepseek-openai" ||
    kind === "glm-openai" ||
    kind === "grok-openai" ||
    kind === "o-series" ||
    kind === "unknown"
  );
}
