/**
 * 协议边界回填：把 number 字段收到的「数字形态字符串」归一成 number
 *
 * ## 为什么需要这一层
 *
 * 工具入参走的是 JSON，而模型是**逐 token 生成 JSON 文本**的——`"offset": 117` 与
 * `"offset": "117"` 在它眼里差一对引号。schema 已经明确写了 `type: "number"`
 * （实测 raw.jsonl 里发给模型的 read schema 是 `"offset":{"type":"number"}`），
 * 模型仍会偶发多打一对引号，被 zod 的 `z.number()` 拒掉。
 *
 * 实测证据（`~/.sid-code/trajectories/sessions`，50 个会话）：
 *
 *   20260907-163824-da9094a7  read offset:"117, 130"  ×2 轮
 *   20260907-163824-da9094a7  read offset:"334, 360"  ×2 轮
 *   20260903-152752-56491335  read offset:"1,1"       ×2 轮
 *
 * 三处全部命中 `read.offset`，模型均为 claude-sonnet-5。每次都触发
 * 「参数校验失败（工具 read）: - offset: 期望 number，实际收到 ...」，
 * 模型下一轮自己改对（`offset:117, limit:30`）——**所以损失不是任务失败，
 * 而是每次白烧一轮往返**（一次完整的 request/response + 全量上下文重发）。
 *
 * ## 为什么不是「模型的锅，不该修」
 *
 * 是模型先违约，但**能不能自救是 harness 的责任**。`"117"` 到 117 是无损、
 * 无歧义的转换，把它判成硬失败纯属自伤：我们既能明确知道模型想要什么，
 * 又拒绝执行。同一个仓库里 `grep.offset` 用的是 `z.coerce.number()`
 * （见 `grep.ts:84`）——**同名同语义的字段，两个工具行为相反**：
 * grep 收到 `"5"` 正常工作，read 收到 `"5"` 报错。这个不一致本身就是缺陷。
 *
 * ## 为什么不直接把工具的 zod 改成 `z.coerce.number()`
 *
 * 三条理由，其中第 1 条是硬伤：
 *
 * 1. **`z.coerce.number()` 修不了实际发生的这一例**。真实入参是 `"117, 130"`
 *    （带逗号的区间形态），`Number("117, 130")` = NaN，coerce 照样 FAIL。
 *    实测：`z.coerce.number().safeParse("117, 130").success === false`。
 * 2. **coerce 会静默吞掉危险值**：`safeParse(null)` → 0、`safeParse([])` → 0、
 *    `safeParse("")` → 0、`safeParse(true)` → 1。这正是
 *    `nullish-normalize.ts` 顶部注释记录过的污染（grep 一次调用 4 个 coerce
 *    字段全被 null 污染成 0）。给 read.offset 加 coerce = 再开一个同样的洞。
 * 3. 逐个工具改 zod 会**漏**，且后续新增 number 字段的人不会知道有这回事——
 *    与 `nullish-normalize.ts` 拒绝「改 23 个工具」是同一个理由：协议层的
 *    形态差异不该摊派给每个工具作者。
 *
 * 所以本模块的做法是：在校验前**显式解析**，只接受能无损还原意图的形态，
 * 其余一律原样放回交给 zod 报错。工具作者继续正常写 `z.number()`。
 *
 * ## 接受与拒绝的边界（这是本模块的全部风险面）
 *
 * 只有「**明确是一个十进制数字**」才转换：
 *
 *   接受: "117" → 117 | " 117 " → 117 | "-3" → -3 | "1.5" → 1.5 | "1e3" → 1000
 *   接受: "117, 130" → 117   ← 区间形态取首个数（见下）
 *   拒绝: "" | "abc" | "1,,2" | "0x1f" | "Infinity" | "NaN" | null | true | [] | {}
 *
 * **为什么拒绝 `""` / `null` / `true` / `[]`**：它们不含「模型想表达哪个数字」
 * 的信息，转换等于替模型编一个值——那就变成了 coerce 的静默污染。让 zod 报错，
 * 模型下一轮自己补对的值。（`null` 另有 `nullish-normalize.ts` 按 optional
 * 语义单独处理，本模块不碰。）
 *
 * **为什么 `"117, 130"` 取首个数 117 而不是拒绝**：这是实测里真实发生的形态，
 * 语义是模型想读「117 到 130 行」。offset 的语义就是起点，取 117 与模型意图
 * 一致；而余下的 130 是 limit 的信息，**本模块刻意不去猜 limit**（猜错会静默
 * 读错范围，比报错更糟）——只把 offset 修对，让读取从正确的行开始。
 * 兜底仍在：read 未给 limit 时按 DEFAULT_MAX_LINES 读，模型看到内容自己判断。
 *
 * ⚠️ 这条规则是有损的（丢掉了 130），所以**它只在字段被声明为 number 时生效**：
 * 一个真正需要字符串的字段（如 read 的 `pages: "2,4,7"`）走的是 string 分支，
 * 本模块碰不到它。这也是为什么必须做 schema 结构内省、不能无脑扫 input。
 *
 * ## 为什么必须内省 schema，而不是「看到数字串就转」
 *
 * 反例就在 read 自己的 schema 里：`pages` 是 `z.string()`，合法值形如
 * `"1-5"`、`"2,4,7"`。无脑转换会把 `pages:"3"` 变成 `pages:3`，
 * 于是一个**本来合法**的调用被我们改成了非法的——修 A 造出 B。
 * 所以只对「解包后确实是 number 类型」的字段动手。
 */

/** zod v4 内部 def 的鸭子类型视图（与 nullish-normalize.ts 保持同一套访问路径） */
interface ZodDefLike {
  type?: string;
  innerType?: unknown;
  element?: unknown;
  items?: unknown[];
  shape?: Record<string, unknown>;
  getter?: () => unknown;
}

/** 取 schema 的 def（兼容 `.def` 与 `._zod.def` 两种访问路径） */
function getDef(schema: unknown): ZodDefLike | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  const s = schema as { def?: ZodDefLike; _zod?: { def?: ZodDefLike } };
  return s.def ?? s._zod?.def;
}

/** 递归展开上限——防御 `z.lazy` 自引用导致的无限下钻 */
const MAX_UNWRAP_DEPTH = 32;

/**
 * 剥掉 optional / default / nullable / lazy 等包装层，返回最内层实际 schema。
 *
 * 与 `nullish-normalize.ts` 的 `unwrap` 是同一套包装层清单，但本模块只关心
 * 「最内层是不是 number」，不需要区分 optional/nullable，故不返回那两个标志。
 */
function unwrapToInner(schema: unknown): unknown {
  let current: unknown = schema;

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const def = getDef(current);
    if (!def) break;

    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "catch":
      case "readonly":
      case "nonoptional":
        current = def.innerType;
        continue;
      case "lazy": {
        if (typeof def.getter !== "function") return current;
        try {
          current = def.getter();
        } catch {
          return current;
        }
        continue;
      }
      default:
        return current;
    }
  }

  return current;
}

const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 从字符串解析出模型意图的数字，拿不到则返回 undefined（表示不归一）。
 *
 * 两条规则，顺序固定：
 * 1. 整串就是一个数 → 直接取它（主路径）
 * 2. 逗号/连字符分隔的区间（`"117, 130"` / `"117-130"`）→ 取**首个**数字
 *    （offset/limit 语义下首个数就是起点；余下的刻意不猜，见模块顶部注释）
 */
function parseIntendedNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  if (DECIMAL_NUMBER_RE.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }

  // 区间形态：按逗号或连字符切，要求**每一段**都是干净的数字才认。
  // 要求全段合法（而非只看第一段）是为了拒掉 "117, abc" 这类半截垃圾——
  // 那种输入说明模型在写别的东西，不该被我们当区间解释。
  // 连字符切分前先剥掉可能的前导负号，避免 "-3-5" 被切出空段。
  const parts = trimmed.split(/\s*[,，]\s*|\s*-\s*/).filter((p) => p.length > 0);
  if (parts.length < 2) return undefined;
  if (!parts.every((p) => DECIMAL_NUMBER_RE.test(p))) return undefined;

  const first = Number(parts[0]);
  return Number.isFinite(first) ? first : undefined;
}

/** 递归深度上限——与 nullish-normalize.ts 同理，防御异常嵌套 */
const MAX_RECURSE_DEPTH = 16;

/**
 * 把 input 里「schema 声明为 number 而模型传了数字形态字符串」的字段归一成 number。
 *
 * 纯函数：不修改传入的 input，有改动时返回浅拷贝（无改动则原样返回同一引用）。
 * 任何非预期结构一律原样返回，保证这一层永不成为新的失败源。
 *
 * 递归范围与 `nullish-normalize.ts` 一致（object.properties / array.items /
 * tuple.items），union / record 不下钻——union 无法确定模型走哪个分支，
 * record 的 value 无类型约束，两者都没有「声明为 number」这个前提。
 *
 * @param schema 工具的原始 zod schema（`tool.zodSchema`）
 * @param input 模型给出的原始入参（通常已过 normalizeStrictNulls）
 */
export function normalizeNumericStrings(schema: unknown, input: unknown): unknown {
  return normalizeValue(schema, input, 0);
}

function normalizeValue(schema: unknown, value: unknown, depth: number): unknown {
  if (depth > MAX_RECURSE_DEPTH) return value;

  const inner = unwrapToInner(schema);
  const def = getDef(inner);
  if (!def) return value;

  // ── 标量：只有「声明 number + 实际收到 string」这一格才动手 ──
  //
  // 判据只认 schema 结构（`def.type === "number"`），**不用 `safeParse(123)` 试探**：
  // 试探法会把 `z.union([z.number(), z.string()])`、`z.any()` 一并判成 number，
  // 而这类字段模型传字符串可能本就合法，我们没有资格替它改。判据保守 =
  // 本层永不制造新的失败。
  //
  // 注：`z.coerce.number()` 的 def.type 也是 "number"（额外带 `coerce: true`），
  // 会被这一格认出来——这没有坏处：coerce 字段收到 `"117, 130"` 本来会 FAIL，
  // 经归一成 117 后正常工作，与非 coerce 字段行为一致（如 grep.offset）。
  if (def.type === "number") {
    if (typeof value !== "string") return value;
    const parsed = parseIntendedNumber(value);
    return parsed === undefined ? value : parsed;
  }

  // ── object：逐字段递归 ──
  if (def.type === "object" && def.shape && typeof def.shape === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const obj = value as Record<string, unknown>;
    const shape = def.shape;
    let changed = false;
    const result: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(obj)) {
      const fieldSchema = shape[key];
      // schema 里没有这个 key（未识别字段）→ 原样保留，交给 zod 自己处理
      if (fieldSchema === undefined) {
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

  // union / record / 其他标量：不下钻（无「声明为 number」前提）
  return value;
}
