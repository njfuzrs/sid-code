/**
 * D4 / T5：常驻工具超过 strict 上限时，谁被降级必须由**显式优先级**决定，
 * 且绝不能是「漏字段会静默出错」和「结果驱动 harness 状态机」的那几个。
 *
 * ## 修前是什么样
 *
 * 常驻（`deferred=false`）的 strict 工具 24 个 > 端点上限 20，而工具列表按名字码点序排。
 * `applyStrictToolBudget()` 对同优先级（未声明 = 0）的工具按列表顺序保留前 N 个，于是
 * 每轮被降级的固定是**字典序最靠后的那几个** —— 2026-11-12 实测是
 * `todo_write` / `tool_search` / `web_fetch` / `web_search` —— 而且这条路径**不发任何事件**。
 * 新增一个字典序靠前的常驻工具，就会把别的工具静默挤出 strict，没有任何提示。
 *
 * ## 为什么数据源必须是 `--dump-tool-meta`
 *
 * 手写一份工具清单来测，新增工具时清单不会跟着变，断言就恒绿了 —— 这正是 T6 那条
 * 前缀碰撞门禁失效的方式（只注册 4 个工具，`deferredToolNames()` 恒为空）。所以这里
 * 走 T0 的真实注册表出口，常驻集与 `strictPriority` 都从那里取。
 *
 * ## 为什么名单硬编码
 *
 * `DEMOTED_BASELINE` 是 2026-11-12 的实测结果。它变红**不代表代码坏了**，而是提醒
 * 「常驻集或优先级动过了」—— 应当有人停下来确认被挤出去的不是关键工具。这与
 * `builtin-tool-meta.test.ts` 硬编码 42 / 18 / 24 是同一条约定。
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STRICT_TOOL_LIMIT,
  applyStrictToolBudget,
} from "@sid-code/core/llm/strict-tool-budget.ts";
import { builtinToolMeta } from "../helpers/builtin-tool-meta.ts";

/** 2026-11-12 实测：配了 MCP（最坏情况）、默认上限 20 时的降级名单 */
const DEMOTED_BASELINE = ["sub_agent", "think", "web_fetch", "web_search"];

/**
 * 漏字段会静默产出错误结果的工具 + 结果驱动 harness 状态机的工具 + 编辑类工具。
 * 前三项是 `types.ts` 里 `strictPriority` 的三档声明标准，最后两项是本次 T5 加的。
 */
const MUST_KEEP_STRICT = ["ask_user_question", "tool_search", "edit", "write", "todo_write"];

/** 常驻工具 → 线格式（本模块只读 name 与 strict）。 */
function residentTools(): { name: string; strict: boolean }[] {
  return builtinToolMeta()
    .filter((t) => !t.deferred)
    .map((t) => ({ name: t.name, strict: t.strict }));
}

/** 与 `anthropic.ts` 的 `strictPriorityLookup` 同口径：未声明按 0。 */
function priorityOf(): (name: string) => number {
  const map = new Map(builtinToolMeta().map((t) => [t.name, t.strictPriority]));
  return (name) => map.get(name) ?? 0;
}

describe("常驻工具的 strict 降级名单（D4）", () => {
  const result = () =>
    applyStrictToolBudget(residentTools(), DEFAULT_STRICT_TOOL_LIMIT, priorityOf());

  test("关键工具不在降级名单里", () => {
    const { demoted } = result();
    for (const name of MUST_KEEP_STRICT) {
      expect(
        demoted,
        `${name} 被挤出了 strict —— 请检查它的 strictPriority / 常驻分层`,
      ).not.toContain(name);
    }
  });

  test("降级数正好等于「常驻数 − 上限」：没有多降，也没有漏降", () => {
    const resident = residentTools();
    const strictCount = resident.filter((t) => t.strict).length;
    const { demoted } = result();
    expect(demoted.length).toBe(Math.max(0, strictCount - DEFAULT_STRICT_TOOL_LIMIT));
  });

  test("降级名单与 2026-11-12 基线一致（变化时请确认是有意的）", () => {
    // 这是 `--dump-tool-meta` 真实注册表上的实测结果，不是手推的：它对应的正是
    // 「常驻 24 个、上限 20」这一最坏情况（PR-C 之前两个 MCP 资源工具仍常驻）。
    expect(result().demoted).toEqual(DEMOTED_BASELINE);
  });

  test("上限被压到 5 时仍先保关键工具：优先级真的在起作用，不是碰巧数量够", () => {
    // limit=5 时刚好只留优先级最高的 5 个（100 / 60 / 50 / 50 / 40），其余 19 个全降。
    // 这条断的是排序方向与「同优先级按原顺序」的稳定语义；只测 limit=20 的话，
    // 关键工具不被降级也可能只是常驻数刚好没超太多。
    const { demoted } = applyStrictToolBudget(residentTools(), 5, priorityOf());
    for (const name of MUST_KEEP_STRICT) {
      expect(demoted, `limit=5 时 ${name} 仍应保住 strict`).not.toContain(name);
    }
    expect(demoted.length).toBe(residentTools().length - 5);
  });
});
