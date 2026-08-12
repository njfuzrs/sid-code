/**
 * strict 契约回填：把「optional 字段收到的 null」归一成 undefined
 *
 * ## 为什么需要这一层
 *
 * OpenAI strict 模式（Constrained Decoding）不允许「可选 key」——所有字段必须进
 * `required`，可选语义只能靠**类型可空**表达。因此 `openai-responses-request.ts` 的
 * `toStrictJsonSchema()` 会把 zod `.optional()` 字段改造成 `type: ["string","null"]`
 * 并塞进 required。发给模型的契约因此变成：
 *
 *   > pages 必填，不想提供就传 null
 *
 * 模型照做，传了 `pages: null`。但工具层校验用的是**原始 zod schema**
 * （`z.string().optional()`），而 zod 的 `.optional()` 只接受 `undefined`、**不接受
 * `null`** → `validateToolInput` 报「期望 string，实际收到 null」。
 *
 * 也就是说：**sid-code 让模型传 null，又拒绝模型传的 null**。模型没有任何办法自救——
 * 它遵守 wire 契约就被拒，不遵守（省略字段）则违反 strict 的 required。实测 40 个带
 * zodSchema 的内置工具里 **23 个**中招（read/edit/bash/grep/glob/ls/web_search 等
 * 全部高频工具），是 2026-08-01 gpt-5.6-luna 会话里刷屏的「参数校验失败」的唯一根因。
 *
 * ## 为什么修在这里，而不是把工具的 zod 改成 .nullish()
 *
 * 改 zod 要动 23 个工具的几十个字段，漏一个就复发，且**后续任何人新增 `.optional()`
 * 字段都会再次踩坑**——把一个协议层的形态差异摊派给每个工具作者，是治标。
 *
 * 本模块把它收敛成协议边界上的一次归一：既然 wire 契约里的 null 语义就是
 * 「未提供」（`makeNullable` 的注释原话），那就在校验前把它翻译回 zod 的
 * 「未提供」表示法 `undefined`。工具作者继续正常写 `.optional()`，无需知道
 * OpenAI strict 的存在。
 *
 * ## 为什么不能简单地"把所有 null 都删掉"
 *
 * 两个必须区分的场景：
 *
 * 1. **作者显式声明可空**（`.nullable()` / `.nullish()`）——null 是有意义的业务值，
 *    不能吞掉。本模块只处理「optional 且未显式 nullable」的字段。
 *
 * 2. **`z.coerce.*` 字段**——这类 schema 会把 null **静默强制转换**掉：
 *    `z.coerce.number().optional().safeParse(null)` 不报错，而是返回 `0`。
 *    这比报错更危险：`grep` 的 `head_limit` 语义是「0 表示无限制」
 *    （见 `grep.ts:34`），模型传 null 会被悄悄解释成「不限制输出条数」，
 *    `context`/`max_matches_per_file` 同理被污染成 0。**无任何报错、无日志**，
 *    只是行为不对。实测 `grep` 一次调用 4 个 coerce 字段全被污染成 0。
 *
 *    正因为 coerce 会吞 null，用「safeParse(null) 是否成功」来判断字段能否接受 null
 *    是错的——必须走 schema 结构内省（见 `acceptsNullExplicitly`）。
 *
 * ## 递归深度必须与 toStrictJsonSchema 对齐
 *
 * `toStrictJsonSchema` 是**递归**改造的（嵌套 object 的 optional 字段同样被转
 * nullable），所以本模块也必须递归，否则嵌套一层的 optional 字段（如
 * `hypothesis_register.supporting_evidence[].source`）仍会复发同样的错误。
 * 两者的递归范围保持一一对应：object 的 properties、array 的 items、tuple 的 items。
 *
 * union / record 分支刻意不下钻：union 无法确定模型意图走哪个分支，record 的
 * value 是无约束任意值——这两类在 strict 模式下本就会被
 * `hasStrictIncompatibleNode` 判定为不兼容并整体降级为非 strict（不改造 schema、
 * 不产生"传 null"的契约），因此不存在需要归一的 null。
 */

/** zod v4 内部 `_zod.def` 的鸭子类型视图，只取本模块需要的字段 */
interface ZodDefLike {
  type?: string;
  innerType?: ZodSchemaLike;
  element?: ZodSchemaLike;
  items?: ZodSchemaLike[];
  shape?: Record<string, ZodSchemaLike>;
  getter?: () => ZodSchemaLike;
}

/** zod schema 的鸭子类型视图（不绑定具体 zod 版本导出，避免 v3/v4 类型不兼容） */
interface ZodSchemaLike {
  def?: ZodDefLike;
  _zod?: { def?: ZodDefLike };
}

/** 取 schema 的 def（兼容 `.def` 与 `._zod.def` 两种访问路径） */
function getDef(schema: unknown): ZodDefLike | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  const s = schema as ZodSchemaLike;
  return s.def ?? s._zod?.def;
}

/** 递归展开上限——防御 `z.lazy` 自引用导致的无限下钻 */
const MAX_UNWRAP_DEPTH = 32;

/**
 * 剥掉 optional / default / lazy 等包装层，返回：
 * - `inner`: 最内层的实际 schema（用于继续递归 object/array）
 * - `isOptional`: 是否存在 optional 包装（即 wire 层会被 makeNullable 处理）
 * - `explicitlyNullable`: 是否存在 nullable 包装（作者有意允许 null，必须保留）
 */
function unwrap(schema: unknown): {
  inner: unknown;
  isOptional: boolean;
  explicitlyNullable: boolean;
} {
  let current: unknown = schema;
  let isOptional = false;
  let explicitlyNullable = false;

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const def = getDef(current);
    if (!def) break;

    switch (def.type) {
      case "optional":
        isOptional = true;
        current = def.innerType;
        continue;
      case "nullable":
        // 作者显式 `.nullable()`：null 是合法业务值，绝不归一
        explicitlyNullable = true;
        current = def.innerType;
        continue;
      case "default":
      case "prefault":
      case "catch":
      case "readonly":
      case "nonoptional":
        // 透明包装层：不改变可选/可空性，继续下钻找真实类型
        current = def.innerType;
        continue;
      case "lazy": {
        // z.lazy：调 getter 拿真实 schema（失败则停在当前层，按不可归一处理）
        if (typeof def.getter !== "function")
          return { inner: current, isOptional, explicitlyNullable };
        try {
          current = def.getter();
        } catch {
          return { inner: current, isOptional, explicitlyNullable };
        }
        continue;
      }
      default:
        return { inner: current, isOptional, explicitlyNullable };
    }
  }

  return { inner: current, isOptional, explicitlyNullable };
}

/**
 * 该字段是否「显式接受 null」。
 *
 * 只认 schema 结构上的 `.nullable()` 包装，**不用 `safeParse(null)` 试探**——
 * `z.coerce.*` 会把 null 静默转成 0/""/false，试探法会把这类字段误判为
 * "能接受 null"，从而放过一个会污染业务语义的值（见模块顶部注释场景 2）。
 */
function acceptsNullExplicitly(schema: unknown): boolean {
  return unwrap(schema).explicitlyNullable;
}

/**
 * 把 input 里「optional 且未显式 nullable」字段上的 null 归一成 undefined。
 *
 * 纯函数：不修改传入的 input，有改动时返回浅拷贝（无改动则原样返回同一引用，
 * 便于调用方判断是否发生归一）。任何非预期结构一律原样返回，保证这一层
 * 永不成为新的失败源。
 *
 * @param schema 工具的原始 zod schema（`tool.zodSchema`）
 * @param input 模型给出的原始入参
 */
export function normalizeStrictNulls(schema: unknown, input: unknown): unknown {
  return normalizeValue(schema, input, 0);
}

/** 递归深度上限——与 unwrap 同理，防御异常嵌套 */
const MAX_RECURSE_DEPTH = 16;

function normalizeValue(schema: unknown, value: unknown, depth: number): unknown {
  if (depth > MAX_RECURSE_DEPTH) return value;

  const { inner } = unwrap(schema);
  const def = getDef(inner);
  if (!def) return value;

  // ── object：逐字段归一 ──
  if (def.type === "object" && def.shape && typeof def.shape === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const obj = value as Record<string, unknown>;
    const shape = def.shape;
    let changed = false;
    const result: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(obj)) {
      const fieldSchema = shape[key];
      // schema 里没有这个 key（未识别字段）→ 原样保留，交给 zod 自己报
      // unrecognized_keys，本层不代替它做裁剪。
      if (fieldSchema === undefined) {
        result[key] = raw;
        continue;
      }

      if (raw === null) {
        const { isOptional } = unwrap(fieldSchema);
        // 仅当「字段可选」且「作者未显式允许 null」时，才把 null 当作
        // wire 契约里的"未提供"翻译回 undefined。
        if (isOptional && !acceptsNullExplicitly(fieldSchema)) {
          // 直接跳过该 key（而非写 undefined）：语义等价于"未提供"，
          // 且避免 `hasOwnProperty` 为 true 干扰下游对"字段是否出现"的判断。
          changed = true;
          continue;
        }
        result[key] = raw;
        continue;
      }

      const normalized = normalizeValue(fieldSchema, raw, depth + 1);
      if (normalized !== raw) changed = true;
      result[key] = normalized;
    }

    return changed ? result : value;
  }

  // ── array：对每个元素递归（元素 schema 统一） ──
  if (def.type === "array" && def.element !== undefined) {
    if (!Array.isArray(value)) return value;
    let changed = false;
    const result = value.map((item) => {
      const normalized = normalizeValue(def.element, item, depth + 1);
      if (normalized !== item) changed = true;
      return normalized;
    });
    return changed ? result : value;
  }

  // ── tuple：按位置对应各自的 schema ──
  if (def.type === "tuple" && Array.isArray(def.items)) {
    if (!Array.isArray(value)) return value;
    let changed = false;
    const result = value.map((item, i) => {
      const itemSchema = def.items?.[i];
      if (itemSchema === undefined) return item;
      const normalized = normalizeValue(itemSchema, item, depth + 1);
      if (normalized !== item) changed = true;
      return normalized;
    });
    return changed ? result : value;
  }

  // union / record / 标量：不下钻（见模块顶部「递归深度必须与 toStrictJsonSchema 对齐」）
  return value;
}
