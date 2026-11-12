/**
 * D2：每个内置工具都必须挂 `zodSchema`。
 *
 * `zodSchema` 是运行时校验链的唯一入口（`validateToolInput()`）：没有它，
 * `!schema` 早退会把别名归一、strict null 回填、数字归一、`safeParse` 全部跳过，
 * 畸形参数直接进 `execute()`，只能靠工具内部的事后手工检查兜底——没有结构化中文错误，
 * 也没有轨迹上的归一事件。42 个内置工具里曾经只有 `notebook_edit` 是这种状态，
 * 而且没有任何门禁能发现（T3 之前）。
 *
 * 取数走 T0 的隐藏出口 `--dump-tool-meta`（真实注册表，含 `hasZodSchema`），
 * 而不是在各测试里逐个 `new` 工具：新增工具时不需要有人记得回来补一行，
 * 漏挂 `zodSchema` 会在这里直接变红。
 */

import { describe, expect, test } from "bun:test";
import { builtinToolMeta } from "../helpers/builtin-tool-meta.ts";

/**
 * 允许不挂 `zodSchema` 的内置工具：名字 → 理由。
 *
 * 当前为空。豁免只在一种情况下成立：工具的入参结构**不由本仓库静态声明**
 * （例如按会话动态生成），挂一份静态 `zodSchema` 会与真实入参脱节。
 * `StructuredOutput` 属于这一类，但它按会话动态注册、不在 `--dump-tool-meta`
 * 的 dump 里，因此不需要写进这张表。
 *
 * 新增条目必须在理由里写清「为什么这份 schema 不能静态声明」，否则它迟早会变成
 * 「某个工具漏挂了，顺手豁免掉」的垃圾桶——那等于把这条门禁的覆盖面逐条还回去。
 */
const EXEMPT: Record<string, string> = {};

describe("zodSchema 全量覆盖：没有内置工具能绕过运行时校验链", () => {
  const meta = builtinToolMeta();

  test("除豁免名单外，每个内置工具都挂了 zodSchema", () => {
    const missing = meta
      .filter((t) => !EXEMPT[t.name])
      .filter((t) => !t.hasZodSchema)
      .map((t) => t.name);
    // 断言失败时把名字拼进消息：红了要能一眼看出补哪个工具，而不是只看到 `[] != [...]`
    expect(
      missing,
      `以下工具没挂 zodSchema，会跳过别名/null 回填/数字归一/safeParse：${missing.join("、")}`,
    ).toEqual([]);
  });

  test("豁免名单里的每个名字都真实存在（防止拼错变成永久失效的豁免）", () => {
    const names = new Set(meta.map((t) => t.name));
    for (const name of Object.keys(EXEMPT)) {
      expect(names.has(name), `豁免名单里的 ${name} 不在真实注册表里——拼错了？`).toBe(true);
    }
  });

  test("豁免名单每条都带理由（防止豁免沦为「漏挂就登记」的垃圾桶）", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim().length, `${name} 的豁免没写理由`).toBeGreaterThan(0);
    }
  });
});
