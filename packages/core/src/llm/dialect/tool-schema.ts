/**
 * 工具 schema 方言 —— 「同一份 JSON Schema，各家认的子集不同」这一层差异。
 *
 * 出处与逐条实测记录见随行文档 `tool-schema.md`——**结论写在这里，依据写在那里**
 * （与 `deepseek.ts` / `glm.ts` 同一分工）。
 *
 * ## 与 `WireDialect` 的分界：这是第三种差异形态
 *
 * | 层 | 管什么 | 形态 |
 * | --- | --- | --- |
 * | `model-compat.ts` | 这条**渠道**认不认某个字段 | 布尔位（用户声明） |
 * | `WireDialect` | 这一**族**的请求体顶层字段发不发、发什么形状 | 声明式描述符 |
 * | **本模块** | 这一族的**工具 schema 里哪些 JSON Schema 关键字合法** | **描述符 + 递归改写** |
 *
 * 前两层都是「一个字段发或不发」，本层是「一棵树逐节点重写」——`additionalProperties`
 * 可能出现在任意深度，一个布尔位表达不了「把整棵树里所有 object 节点的 required 补全」。
 *
 * ## 为什么必须有这一层：三条实测证据
 *
 * 1. **`$schema` 每轮白烧 ~570 token。** zod v4 的 `z.toJSONSchema()` 给**每份** schema
 *    顶层加 `"$schema":"https://json-schema.org/draft/2020-12/schema"`（57 字节）。
 *    实测 40 份内置工具 schema **无一例外**，合计 2280 字节 ≈ 570 token，
 *    **每一轮请求都发**，且位于 prompt cache 的工具区前缀里常驻。
 *    五家厂商**没有任何一家的文档承认接受这个键**（见 `tool-schema.md` §未验证项）——
 *    它是 zod 的产物，不是协议的一部分。
 *
 * 2. **三次真实生产事故全压在一条路径上。** OpenAI Responses 的 strict 改造
 *    （2026-07-13 `required` 缺失 / 07-14 `z.unknown()` 空 schema / 08-01 `propertyNames`
 *    整请求 400 复发 8 次）此前**内联在 `openai-responses-request.ts` 一个文件里**，
 *    另外两条线（Chat Completions 的 `openai.ts`、原生 Anthropic 的 `anthropic.ts`）
 *    共 4 处 `input_schema` **裸透传**。同一类缺陷在另外两条线上无人接。
 *
 * 3. **原生 Anthropic 的 strict 路径正在下发它自己文档拒绝的关键字。** 实测 7 个内置工具
 *    带 `minimum`/`maximum`/`exclusiveMinimum`/`maxItems`/`propertyNames`
 *    （`grep` / `lsp` / `enter_worktree` / `tool_search` / `ask_user_question` /
 *    `task_create` / `task_update`），而 Anthropic strict 子集**明确不含全部数值约束与
 *    字符串长度约束**、`minItems` 只认 0/1。这 7 个工具都被 `registry.ts:79` 打了
 *    `strict: true`，`anthropic.ts:197` 三重门控通过后原样发出。
 *
 * ⚠ **第 3 条是文档依据，不是轨迹证据**——本仓 51 个会话的轨迹里**查不到**任何
 * schema 类 400。也就是说 Anthropic 实际上**容忍**了这些关键字（另有旁证：我们一次发
 * 40 个 strict 工具，也超过它文档写的「每请求 20 个」上限而未报错）。
 * 故本层对 Anthropic 的处置刻意是**保守化下发**而非「修一个正在炸的 bug」：
 * 按文档子集裁剪，把裁掉的约束**转写进 `description`**（这正是官方 SDK 的做法），
 * 语义不丢、token 略减、与文档一致。**不要在 PR 里把它说成修复线上事故。**
 *
 * ## 刻意不做的三件事（每条都有理由，不是漏了）
 *
 * 1. **不给 Chat Completions 线打开 `strict`。** `openai.ts` 全文零 `strict` 命中——
 *    `registry.ts` 打的 40 个 `strict: true` 在这条线上被完全忽略。DeepSeek 确实
 *    文档支持 strict，但它要求 **`base_url` 换到 `/beta`**（见 `tool-schema.md`），
 *    那是改渠道行为，且 DeepSeek 官方仓有 strict 模式吐畸形 JSON 的未闭 issue。
 *    本层把「这一族的 strict 子集是什么」声明清楚，**但不替任何人按下开关**——
 *    开关是独立一件事，混进本 PR 就同时改了「schema 形状」和「发不发 strict」两个变量，
 *    出问题分不清是谁。
 *
 * 2. **不无条件剥 `default`。** 这是本层最容易犯的错：Anthropic strict **明确支持**
 *    `default`，而 OpenAI strict 的支持属性表里**没有**它（多个三方错误库与 LangChain
 *    文档指向「strict 下 default 会被拒」，但 OpenAI 官方**没有**把它列进不支持清单）。
 *    一个「共用 sanitizer 顺手剥掉 default」的实现会在 Anthropic 上白丢语义。
 *    实测只有 `notebook_edit` / `tool_search` 两个工具带 `default`，且 Responses 线
 *    一直这么发、从未报错 —— **证据不足就不动**，只在 `tool-schema.md` 记为未验证项。
 *
 * 3. **不改 `oneOf`。** OpenAI strict 硬拒 `oneOf`（有确切 400 文案），但 zod v4 的
 *    union 一律 emit `anyOf`，实测 40 份 schema 里 `oneOf` **零命中**。
 *    唯一可能带 `oneOf` 的是 MCP 工具的外部 schema，而 MCP 工具**不打 strict**
 *    （`registry.ts:79` 显式排除）。为一条走不到的路径写改写逻辑，就是新的死代码。
 *    改写函数留了口子（`rewriteOneOfToAnyOf` 的位置在 `tool-schema.md` 记明），
 *    真出现时再接。
 */

import type { ProtocolFamily } from "./types.ts";

/**
 * zod v4 无条件注入的 JSON Schema 元信息键。
 *
 * 单独列成常量而不是内联字符串：它同时被剥离逻辑与测试断言引用，
 * 两处手写同一个字面量是本仓有前科的漂移形态。
 */
export const JSON_SCHEMA_META_KEYS: readonly string[] = ["$schema"];

/**
 * 「这一族的工具 schema 认什么」的声明式描述符。
 *
 * 全部字段都是**该族在 strict 语境下**的约束——非 strict 语境各家一致地「忽略不认识的
 * 关键字」（Anthropic / DeepSeek / GLM 均有文档或实测旁证），故非 strict 只做元信息剥离。
 */
export interface ToolSchemaDialect {
  kind: ProtocolFamily;
  /**
   * strict 语境下必须剥掉的关键字。
   *
   * 剥掉不等于丢语义：{@link sanitizeToolSchema} 会把有信息量的约束转写进
   * 同节点的 `description`（官方 SDK 的做法）。
   */
  strictRejectedKeywords: readonly string[];
  /**
   * `minItems` 的合法取值白名单；`null` = 不限制。
   *
   * 单独开一个字段而不是塞进 `strictRejectedKeywords`，因为 Anthropic 的约束是
   * **值级**的（只认 0 和 1）而非关键字级——关键字白名单表达不了「这个键可以有，
   * 但只能取这两个值」。研究里五家只有它这一例，故不做成通用机制。
   */
  minItemsAllowedValues: readonly number[] | null;
  /**
   * strict 语境是否要求「每个 object 节点的 required 覆盖 properties 全集
   * + `additionalProperties: false`」。
   *
   * OpenAI 与 DeepSeek 的 strict 都硬性要求（两家文档措辞几乎一致），
   * Anthropic 的 strict 不要求 required 全覆盖（它保留了可选参数的概念，
   * 只是限量 24 个）——这一条差异如果搞反，一边是 400，另一边是把所有可选参数
   * 变成必填、模型被迫给每个字段编一个值。
   */
  strictRequiresTotalRequired: boolean;
}

/** 数值与长度约束：Anthropic strict 子集**整类**不含（见 `tool-schema.md`） */
const NUMERIC_AND_LENGTH_CONSTRAINTS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
] as const;

/**
 * 各族的工具 schema 方言表。
 *
 * 与 `catalog.ts` 的 `WIRE_DIALECTS` 同构：`Record<ProtocolFamily, …>` 而非
 * `Partial<…>`，**类型层强制每一族都有声明**。新增族忘了登记是编译期错误，
 * 不是运行时静默落到兜底——这是 PR-1 学到的那条经验的同类应用。
 */
const TOOL_SCHEMA_DIALECTS: Record<ProtocolFamily, ToolSchemaDialect> = {
  /**
   * OpenAI Responses API（GPT-5.x）。
   *
   * strict 子集**支持**数值/长度约束与 `pattern`/`format`，故不剥任何约束——
   * 剥掉反而丢掉服务端真会执行的约束解码能力。它要的是 required 全覆盖。
   */
  "openai-responses": {
    kind: "openai-responses",
    strictRejectedKeywords: [],
    minItemsAllowedValues: null,
    strictRequiresTotalRequired: true,
  },
  /**
   * OpenAI o-series（Chat Completions）。子集与 Responses 同源（官方是同一页文档），
   * 但**当前这条线不下发 strict**（见本文件顶部「刻意不做」第 1 条），
   * 故 `strictRequiresTotalRequired` 声明为 true 只在将来接线时生效，现在走不到。
   */
  "o-series": {
    kind: "o-series",
    strictRejectedKeywords: [],
    minItemsAllowedValues: null,
    strictRequiresTotalRequired: true,
  },
  /**
   * 原生 Anthropic Messages API。
   *
   * strict 子集**不含**全部数值约束与字符串长度约束；`minItems` 只认 0/1；
   * `propertyNames`/`patternProperties`（字典语义）不在子集内。
   * 但它**支持** `default`（与 OpenAI 相反，见顶部「刻意不做」第 2 条）。
   */
  "anthropic-native": {
    kind: "anthropic-native",
    strictRejectedKeywords: NUMERIC_AND_LENGTH_CONSTRAINTS,
    minItemsAllowedValues: [0, 1],
    // Anthropic strict 保留可选参数概念（限量 24 个），不要求 required 全覆盖。
    strictRequiresTotalRequired: false,
  },
  /** DeepSeek · Anthropic 兼容端点：走 `anthropic.ts` 构造器，但 schema 校验是 DeepSeek 侧的。 */
  "deepseek-anthropic": {
    kind: "deepseek-anthropic",
    strictRejectedKeywords: [],
    minItemsAllowedValues: null,
    strictRequiresTotalRequired: true,
  },
  /**
   * DeepSeek · OpenAI 兼容端点。strict 支持的类型与 OpenAI 几乎一致
   * （object/string/number/integer/boolean/array/enum/anyOf + `$ref`），
   * 且**官方示例自己就用了 `format`/`pattern`**，故不剥约束。
   */
  "deepseek-openai": {
    kind: "deepseek-openai",
    strictRejectedKeywords: [],
    minItemsAllowedValues: null,
    strictRequiresTotalRequired: true,
  },
  /**
   * 智谱 GLM。**官方两份文档均未发布任何 JSON Schema 子集或 strict 开关**
   * （见 `tool-schema.md` §GLM）。按「无文档即按最宽松处理」——只剥元信息键。
   * 刻意不猜：猜错的两个方向代价不对称（多剥 = 白丢语义且无从发现；少剥 = 400 当场可见）。
   */
  "glm-openai": {
    kind: "glm-openai",
    strictRejectedKeywords: [],
    minItemsAllowedValues: null,
    strictRequiresTotalRequired: true,
  },
  /**
   * xAI Grok。五家里文档最全，且**明确接受** `oneOf`/`allOf`(单支)/`default`
   * 与各类约束（超过上限时降级为「接受但不保证执行」，不报错）。故不剥。
   */
  "grok-openai": {
    kind: "grok-openai",
    strictRejectedKeywords: [],
    minItemsAllowedValues: null,
    strictRequiresTotalRequired: true,
  },
  /**
   * 未知族兜底：**只剥元信息键，不做任何裁剪**。
   *
   * 方向与 `unknownDialect` 对 `reasoning_effort` 的「乐观下发」一致：
   * 发多了会 400（响亮失败、当场可见、能自愈），发少了是静默丢能力（无从发现）。
   */
  unknown: {
    kind: "unknown",
    strictRejectedKeywords: [],
    minItemsAllowedValues: null,
    strictRequiresTotalRequired: true,
  },
};

/** 取某族的工具 schema 方言。未知族返回兜底声明，**不返回 undefined**（同 `getDialectWire`）。 */
export function getToolSchemaDialect(kind: ProtocolFamily): ToolSchemaDialect {
  return TOOL_SCHEMA_DIALECTS[kind];
}

/**
 * zod `z.number().int()` 会 emit 的安全整数边界。
 *
 * 这两个值**没有信息量**——它们是「这是个整数」的副产品，不是工具作者想表达的约束。
 * 剥离时不把它们转写进 `description`：写了就是给每个整数参数塞一句
 * 「最大值: 9007199254740991」，纯 token 浪费（实测 `grep` 一个工具就有 7 对）。
 */
const ZOD_SAFE_INTEGER_BOUNDS = new Set<number>([
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
]);

/** 约束键 → 转写进 description 时的中文措辞 */
const CONSTRAINT_PHRASES: Record<string, string> = {
  minimum: "最小值",
  maximum: "最大值",
  exclusiveMinimum: "必须大于",
  exclusiveMaximum: "必须小于",
  multipleOf: "必须是其倍数",
  minLength: "最短长度",
  maxLength: "最长长度",
  maxItems: "最多元素数",
  minItems: "最少元素数",
};

/** 一次清理的产出 */
export interface SanitizeResult {
  /** 清理后的 schema（新对象，**不原地改**入参——入参可能是 registry 的 WeakMap 缓存值） */
  schema: Record<string, unknown>;
  /**
   * strict 是否仍可用。`false` = 该 schema 与该族的 strict 模式**结构上互斥**
   * （含无约束任意值 / 动态 key 字典），调用方应把该工具降级为非 strict 并发原始 schema。
   */
  strictUsable: boolean;
  /** 被剥掉的关键字（去重后），供日志与测试断言用 */
  strippedKeywords: string[];
}

/** 清理选项 */
export interface SanitizeOptions {
  /** 本次是否按 strict 语境处理。false = 只剥元信息键 */
  strict: boolean;
}

/**
 * 按族方言清理一份工具 schema。
 *
 * 三段处理，顺序固定：
 * 1. **剥元信息键**（`$schema`）——所有族、strict 与非 strict 一律执行；
 * 2. **strict 兼容性自检**——发现结构性互斥则整体降级（`strictUsable: false`），
 *    不再做后续改造（改造一个必被拒的 schema 是白费）；
 * 3. **strict 语境的族裁剪 + required 补全**。
 *
 * @returns 见 {@link SanitizeResult}。**永不抛异常**：schema 是用户/MCP 提供的数据，
 *   一个畸形 schema 不该让整轮请求发不出去（原样返回、strictUsable 置 false 即可）。
 */
export function sanitizeToolSchema(
  schema: Record<string, unknown>,
  dialect: ToolSchemaDialect,
  options: SanitizeOptions,
): SanitizeResult {
  const stripped = new Set<string>();

  // ── 第 1 段：剥元信息键（全族、全语境） ──
  let out = stripMetaKeys(schema, stripped) as Record<string, unknown>;

  if (!options.strict) {
    return { schema: out, strictUsable: false, strippedKeywords: [...stripped] };
  }

  // ── 第 2 段：strict 结构性互斥自检 ──
  // 放在族裁剪**之前**：裁剪会改动节点，改完再判会把「本来就不兼容」误判成「裁剪导致的」。
  if (hasStrictIncompatibleNode(out)) {
    return { schema: out, strictUsable: false, strippedKeywords: [...stripped] };
  }

  // ── 第 3 段：族裁剪 + required 补全 ──
  if (dialect.strictRejectedKeywords.length > 0 || dialect.minItemsAllowedValues !== null) {
    out = pruneRejectedKeywords(out, dialect, stripped) as Record<string, unknown>;
  }
  if (dialect.strictRequiresTotalRequired) {
    out = toTotalRequiredSchema(out) as Record<string, unknown>;
  }

  return { schema: out, strictUsable: true, strippedKeywords: [...stripped] };
}

/** 递归剥离 JSON Schema 元信息键（`$schema`）。返回新对象。 */
function stripMetaKeys(node: unknown, stripped: Set<string>): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => stripMetaKeys(n, stripped));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (JSON_SCHEMA_META_KEYS.includes(k)) {
      stripped.add(k);
      continue;
    }
    out[k] = stripMetaKeys(v, stripped);
  }
  return out;
}

/**
 * 递归剥离该族 strict 不接受的约束关键字，并把**有信息量的**约束转写进同节点 `description`。
 *
 * 转写而非静默丢弃的理由：约束本身是给模型看的提示（「offset 不能为负」）。
 * 静默丢掉会让模型开始传非法值，然后被工具层 zod 挡下报错、多花一轮重试——
 * 这正是官方 SDK 采取同一策略的原因（strip + append to description）。
 */
function pruneRejectedKeywords(
  node: unknown,
  dialect: ToolSchemaDialect,
  stripped: Set<string>,
): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => pruneRejectedKeywords(n, dialect, stripped));

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const notes: string[] = [];

  for (const [k, v] of Object.entries(src)) {
    if (dialect.strictRejectedKeywords.includes(k)) {
      stripped.add(k);
      // 安全整数边界是 `.int()` 的副产品，不转写（见 ZOD_SAFE_INTEGER_BOUNDS）。
      if (typeof v === "number" && ZOD_SAFE_INTEGER_BOUNDS.has(v)) continue;
      const phrase = CONSTRAINT_PHRASES[k];
      if (phrase !== undefined) notes.push(`${phrase}: ${JSON.stringify(v)}`);
      continue;
    }
    // minItems 是**值级**限制：键可以留，取值不在白名单才剥。
    if (
      k === "minItems" &&
      dialect.minItemsAllowedValues !== null &&
      typeof v === "number" &&
      !dialect.minItemsAllowedValues.includes(v)
    ) {
      stripped.add(k);
      notes.push(`${CONSTRAINT_PHRASES.minItems}: ${v}`);
      continue;
    }
    out[k] = pruneRejectedKeywords(v, dialect, stripped);
  }

  if (notes.length > 0) {
    const existing = typeof out.description === "string" ? out.description : "";
    // 用括号包起来接在原描述后面：与工具作者自己写的描述有视觉分界，
    // 且不改变原描述内容（有测试断言原描述仍是前缀）。
    out.description = existing ? `${existing}（${notes.join("，")}）` : `（${notes.join("，")}）`;
  }
  return out;
}

/**
 * 递归地把 schema 改造成满足「required 覆盖 properties 全集 + `additionalProperties: false`」
 * 的形态（OpenAI / DeepSeek strict 的硬性要求）。
 *
 * 1. 每个 object 节点的 `required` 补全为该节点全部 `properties` key —— strict 不允许
 *    「可选 key」，可选语义必须改用 nullable 类型表达（官方要求：optional 字段要用
 *    union 带 null，且仍要出现在 required 里，null 表示「未提供」）；
 * 2. 原本不在 `required` 里的字段（zod `.optional()`），其子 schema 包一层「允许 null」；
 * 3. `additionalProperties` 显式设为 `false`（zod 默认已带，这里兜底防未来版本变化）；
 * 4. 递归 `properties` / `items`（含 tuple 数组）/ `anyOf`|`oneOf`|`allOf`，
 *    保证任意深度嵌套都满足——strict 校验是递归的，只修顶层不够
 *    （2026-07-13 事故里报错定位的正是嵌套两层的 `questions[].options[]`）。
 *
 * ## 历史（2026-07-13 生产事故）
 *
 * `registry.ts:79` 默认给内置工具打 `strict: true`（原为 Anthropic Constrained Decoding
 * 设计），`openai-responses-request.ts` 的 `convertTools()` 曾无条件透传给 OpenAI
 * Responses API；但 zod `.optional()` 字段转 JSON Schema 后不出现在 required 里，
 * 完全不满足 OpenAI strict 的硬性要求，导致任何带 optional 字段的工具一旦发给 GPT-5.x
 * 就 400（实测内置工具 30 个里 23 个中招，含 ask_user_question/read/edit/bash/grep）：
 *
 *   `OpenAI Responses API HTTP 400: Invalid schema for function 'ask_user_question':
 *    … 'required' is required to be supplied`
 *
 * ⚠ 本函数是从 `openai-responses-request.ts` **原样搬迁**过来的（逐字），
 * 行为等价由 `tests/llm/openai-responses-strict-schema.test.ts` 的 397 行既有断言锁住。
 * 搬迁与改行为不能混在一次改动里——混了以后回归红了分不清是搬错了还是改对了。
 */
function toTotalRequiredSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toTotalRequiredSchema);

  const node: Record<string, unknown> = { ...(schema as Record<string, unknown>) };

  // 递归处理组合关键字分支（union / 交叉类型内部也可能是 object 节点）
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      node[key] = (node[key] as unknown[]).map(toTotalRequiredSchema);
    }
  }

  // 递归处理数组 items（单 schema 场景；tuple 场景 items 本身是数组，走上面的分支）
  if (node.items !== undefined) {
    node.items = toTotalRequiredSchema(node.items);
  }

  // object 节点：补全 required + 把新纳入 required 的原 optional 字段转 nullable
  if (node.type === "object" && node.properties && typeof node.properties === "object") {
    const properties = node.properties as Record<string, unknown>;
    const originalRequired = new Set(
      Array.isArray(node.required) ? (node.required as string[]) : [],
    );
    const allKeys = Object.keys(properties);
    const newProperties: Record<string, unknown> = {};

    for (const key of allKeys) {
      const propSchema = toTotalRequiredSchema(properties[key]);
      newProperties[key] = originalRequired.has(key) ? propSchema : makeNullable(propSchema);
    }

    node.properties = newProperties;
    node.required = allKeys;
    if (node.additionalProperties === undefined) {
      node.additionalProperties = false;
    }
  }

  return node;
}

/**
 * 把一个 JSON Schema 节点改造成「允许 null」，用于表达 zod `.optional()` 的可选语义
 * （strict 下可选字段仍必须在 required 里，靠类型可空表达「可以不提供」，
 * 模型需要时会显式传 null）。
 */
function makeNullable(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return { anyOf: [schema, { type: "null" }] };
  }
  const node = schema as Record<string, unknown>;
  if (typeof node.type === "string") {
    // 简单 type：type: "string" → type: ["string", "null"]（官方推荐写法）
    return { ...node, type: [node.type, "null"] };
  }
  if (Array.isArray(node.type)) {
    return node.type.includes("null") ? node : { ...node, type: [...node.type, "null"] };
  }
  // 无简单 type（enum-only、$ref、已有 anyOf/oneOf 的复合 schema）：整体包一层 anyOf
  return { anyOf: [node, { type: "null" }] };
}

/**
 * 递归检测：schema 里是否存在「strict 模式**结构上**无法表达」的节点。
 *
 * 两类，都不是「裁剪能救」的——只能把该工具整体降级为非 strict：
 *
 * ## 第一类：无约束任意值
 *
 * strict 要求每个节点都有确定的 `type`（或 enum/const/$ref/组合器之一）来约束取值。
 * zod 的 `z.any()` / `z.unknown()` 转 JSON Schema 后是**空对象 `{}`**（除 `$schema`/
 * `description` 外无任何约束键），既没 type 也没 enum/组合器——这类「无约束任意值」在
 * strict 下根本无法表达（strict 的本质就是约束解码，而任意值意味着无约束），
 * 无论怎么包 nullable 都会 400：`schema must have a 'type' key`。
 *
 * 背景（2026-07-14 复测发现）：修好 ask_user_question 的 optional 字段后，实测 gpt-5.4
 * 仍在 `workflow` 工具上 400——它的 `args` 是 `z.unknown()`（传给脚本的任意入参），
 * 生成空 schema `{}`，`makeNullable` 把它包成 `anyOf:[{}, {type:"null"}]`，那个 `{}`
 * 分支仍无 type key。正确做法是**该工具整体降级为非 strict**（发原始 schema、
 * 不带 strict，让服务端按普通函数调用处理），而不是硬塞一个必被拒的 schema。
 *
 * 用运行时自检而非按工具名硬编码豁免：未来任何新增的 `z.any()`/`z.unknown()` 字段工具
 * 都会被自动识别并降级，不会再次踩坑。
 *
 * ## 第二类：动态 key 字典（record 模式）
 *
 * strict **不接受**描述动态 key 的关键字：`propertyNames`、`patternProperties`，
 * 以及 `additionalProperties` 为 schema 对象（而非 `false`）的写法。原因同样是
 * strict 要求 key 集合是编译期已知的有限集，而字典的 key 运行时才知道。
 *
 * 背景（2026-08-01 生产事故）：`task_create` / `task_update` 的 `metadata` 是
 * `z.record(z.string(), z.unknown())`，转 JSON Schema 后带 `propertyNames`，被 OpenAI 400：
 *
 *   `Invalid schema for function 'task_create': In context=('properties','metadata'),
 *    'propertyNames' is not permitted.`
 *
 * 注意这是**整个请求 400**——该轮所有工具定义（实测 137 个）全部发不出去，
 * 不只是 task_create 不可用。实测一次会话中复发 8 次。
 *
 * ⚠ 本函数同样是从 `openai-responses-request.ts` 原样搬迁（逐字），不趁搬迁改判据。
 */
export function hasStrictIncompatibleNode(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  if (Array.isArray(schema)) return schema.some(hasStrictIncompatibleNode);

  const node = schema as Record<string, unknown>;
  const hasType = node.type !== undefined;
  const hasEnumOrConst = node.enum !== undefined || node.const !== undefined;
  const hasRef = node.$ref !== undefined;
  const combinators = ["anyOf", "oneOf", "allOf"] as const;
  const hasCombinator = combinators.some((k) => Array.isArray(node[k]));
  const isStructural = node.properties !== undefined || node.items !== undefined;

  // 「无约束任意值」叶子：既无 type，也无 enum/const/$ref/组合器，且不是 object/array 结构节点。
  if (!hasType && !hasEnumOrConst && !hasRef && !hasCombinator && !isStructural) {
    return true;
  }

  // 「动态 key 字典」节点：strict 不允许描述运行时 key 的关键字。
  if (node.propertyNames !== undefined || node.patternProperties !== undefined) {
    return true;
  }
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    return true;
  }

  // 递归下钻各类子节点
  for (const key of combinators) {
    if (Array.isArray(node[key]) && (node[key] as unknown[]).some(hasStrictIncompatibleNode)) {
      return true;
    }
  }
  if (node.items !== undefined && hasStrictIncompatibleNode(node.items)) return true;
  if (node.properties && typeof node.properties === "object") {
    for (const v of Object.values(node.properties as Record<string, unknown>)) {
      if (hasStrictIncompatibleNode(v)) return true;
    }
  }
  return false;
}
