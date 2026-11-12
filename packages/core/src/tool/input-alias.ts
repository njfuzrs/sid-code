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
  // sub_agent：模型按 CC 命名写 subagent_type，schema 字段是 type。不在这里改名的话，
  // zod 会把未声明的 subagent_type 静默剥离，execute 拿不到类型就兜底成 general-purpose，
  // 而分区读的是原始入参、判成可并发——结果是写类子代理被并行执行（2026-11-03 端到端实测）。
  { from: "subagent_type", to: "type" },
  // grep：CC Grep 的协议参数名就是短参数 -i / -n / -B / -A / -C（CC 报告附录 A、
  // Agent SDK 类型定义），模型按 CC 习惯传这些键时会被 zod 静默剥离。30 天实测
  // 47 次真正丢意图（-C 28、-i 10、-A 9）：`-C:3` 被吞之后模型拿到的是没有上下文行、
  // 区分大小写的结果，且 `is_error=false`——失败被藏在「成功」里。这与 activeForm 不同：
  // 它是跨产品协议先验（CC 的字段名就是这个），不是猜测的命名风格漂移，所以直接登记。
  // `-n`（105 次）故意不登记：sid 没有对应字段，output_mode=content 时恒带
  // --line-number（grep.ts），它属于「已知无影响的键」，走 D1/T2 的静默接受 + 事件。
  { from: "-C", to: "context" },
  { from: "-i", to: "case_insensitive" },
  { from: "-A", to: "after_context" },
  { from: "-B", to: "before_context" },
];

/**
 * 「已知无影响键」名单：能确定「丢了不改变结果」的未声明顶层键。
 *
 * ## 为什么需要这张表
 *
 * `validateToolInput` 会把未声明的顶层键做成一条**模型可见**的提示
 * （「参数 X 不是本工具的参数，已被忽略」）。但有一类键丢了**对结果没有任何影响**，
 * 给提示反而是负收益：
 *
 * - `grep` 的 `-n` 是 CC 的「输出行号」，sid 没有对应字段，而 `output_mode=content`
 *   时 grep 恒带 `--line-number`（见 grep.ts 的 ripgrep 参数）。提示里写「已被忽略」
 *   会让模型以为结果里没有行号——它读到的是**错误信息**，不只是噪音。
 * - 30 天轨迹里 `-n` 是未知键里最高频的一个（105/170）；每次都在结果开头加一段，
 *   会把「同一会话里同一个键的复发率」这个验收指标整个带偏。
 *
 * ## 登记口径（与 ALIASES 一致，只认证据）
 *
 * - 按「工具名 + 键名」登记，**不允许按模型名**——模型会换、能力会漂移，按模型名
 *   硬编码是本仓明令禁止的做法。
 * - 每条必须写清「为什么丢了不影响结果」。写不出这个理由的，不该进这张表。
 *
 * 名单里的键仍然发 `ToolInputUnknownKeys` 事件（进 `silenced` 字段），只是不进提示。
 * 静默行为必须在轨迹上有存在形式——这是 input-validator 与本模块的共同前提。
 */
export const IGNORABLE_UNKNOWN_KEYS: ReadonlyArray<{
  tool: string;
  key: string;
  reason: string;
}> = [
  {
    tool: "grep",
    key: "-n",
    reason:
      "CC 的 -n 是「输出行号」；sid 没有对应字段，output_mode=content 时恒带 --line-number，丢了不改变结果",
  },
];

/** 「工具 + 键」是否属于已知无影响键（丢了不改结果：只发事件，不提示） */
export function isIgnorableUnknownKey(tool: string, key: string): boolean {
  return IGNORABLE_UNKNOWN_KEYS.some((e) => e.tool === tool && e.key === key);
}

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
