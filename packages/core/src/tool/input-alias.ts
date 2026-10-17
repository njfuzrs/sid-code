/**
 * 工具入参的别名归一：在 zod 校验**之前**把命名风格漂移的键改回协议字段名
 *
 * ## 为什么需要
 *
 * 协议层是 snake_case（`active_form`），而被 Claude Code TodoWrite 训练过的模型
 * 习惯写 camelCase `activeForm`。两类后果（20261016 方案 S2）：
 *
 * 1. `todo_write` 的 `active_form` 必填 → 被打回。`findNearMissKey` 的文案已经点名
 *    正确字段，全库 12/251 会话出现、11 个下一次就重试成功；但事故会话
 *    `20261016-124310-ebff882b` 读到精确报错仍**零重试**，清单从未建成，
 *    todo gate 整道哑火。修法重心因此是「让首次调用就成功」，不是再改文案。
 * 2. `structured-task-create/update` 的 `active_form` 是 optional → zod 对未识别键
 *    **静默剥离**，`activeForm` 被吞掉、不报任何错，spinner 文案永远丢失。
 *
 * ## 为什么不用 zod preprocess
 *
 * preprocess 会把 schema 的 `def.type` 变成 `pipe`，而 strict 模式的 null 回填
 * （`nullish-normalize.ts`）与数字回填（`numeric-coerce.ts`）的拆包只认
 * optional / nullable，不认 pipe —— 实测 `active_form:null` 由「剥成缺省」
 * 退化为「校验失败」。所以归一做在 `validateToolInput` 里、按 schema 结构内省，
 * 对模型暴露的 JSON schema 不变（契约单一，容错在边界）。
 *
 * ## 范围刻意收窄
 *
 * 只认显式登记的别名对（`ALIASES`），不做「命名风格归一化后相等即改名」的通用匹配：
 * 通用匹配会让任何工具的任意键都可能被悄悄改写，而我们目前只有 `activeForm`
 * 这一对的证据。别的漂移先靠 `ToolInputAliasApplied` 事件度量，再决定要不要泛化。
 */

import { getDef, unwrap } from "./nullish-normalize.ts";

/** 别名 → 协议字段名。只在 schema shape 确实声明了目标键、且未声明别名键时生效。 */
const ALIASES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "activeForm", to: "active_form" },
];

/** 一次归一里每个别名对的命中统计 */
export interface AliasHit {
  from: string;
  to: string;
  /** 改名次数 */
  count: number;
  /** 两键同时出现、丢弃别名键的次数 */
  dropped: number;
}

/** 递归深度上限——与 nullish-normalize 同理，防御异常嵌套 */
const MAX_DEPTH = 16;

/**
 * 按 schema 结构把 input 里的别名键改成协议字段名。
 *
 * 纯函数：不修改传入的 input；有改动时返回新对象，无改动返回同一引用。
 * 任何非预期结构一律原样返回，保证这一层永不成为新的失败源。
 */
export function normalizeInputAliases(
  schema: unknown,
  input: unknown,
): { value: unknown; hits: AliasHit[] } {
  const stats = new Map<string, AliasHit>();
  const value = walk(schema, input, 0, stats);
  return { value, hits: [...stats.values()] };
}

function bump(stats: Map<string, AliasHit>, from: string, to: string, kind: "count" | "dropped") {
  let h = stats.get(from);
  if (!h) {
    h = { from, to, count: 0, dropped: 0 };
    stats.set(from, h);
  }
  h[kind] += 1;
}

function walk(
  schema: unknown,
  value: unknown,
  depth: number,
  stats: Map<string, AliasHit>,
): unknown {
  if (depth > MAX_DEPTH) return value;
  const { inner } = unwrap(schema);
  const def = getDef(inner);
  if (!def) return value;

  if (def.type === "object" && def.shape && typeof def.shape === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const shape = def.shape;
    let obj = value as Record<string, unknown>;
    let changed = false;

    for (const { from, to } of ALIASES) {
      // 只在「shape 声明了 to、没声明 from、入参里出现了 from」时改名——
      // shape 若真有 from 字段，那它就不是别名，绝不能动。
      if (!(to in shape) || from in shape || !Object.hasOwn(obj, from)) continue;
      const next: Record<string, unknown> = { ...obj };
      if (Object.hasOwn(obj, to)) {
        // 两键同时出现：保留协议字段，丢弃别名（不猜哪个"更对"）
        bump(stats, from, to, "dropped");
      } else {
        next[to] = obj[from];
        bump(stats, from, to, "count");
      }
      delete next[from];
      obj = next;
      changed = true;
    }

    // 再逐字段下钻（todos[] 这类嵌套才是 activeForm 的主战场）
    let result: Record<string, unknown> | undefined;
    for (const [key, raw] of Object.entries(obj)) {
      const fieldSchema = shape[key];
      if (fieldSchema === undefined) continue;
      const normalized = walk(fieldSchema, raw, depth + 1, stats);
      if (normalized !== raw) {
        result ??= { ...obj };
        result[key] = normalized;
      }
    }
    if (result) return result;
    return changed ? obj : value;
  }

  if (def.type === "array" && def.element !== undefined) {
    if (!Array.isArray(value)) return value;
    let changed = false;
    const result = value.map((item) => {
      const n = walk(def.element, item, depth + 1, stats);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? result : value;
  }

  return value;
}
