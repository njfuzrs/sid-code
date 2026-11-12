/**
 * 前缀碰撞门禁（D8 / T6）：常驻组 × 延迟组不得共享 ≥4 字符前缀。
 *
 * 背景（2026-08-17 事故）：`enter_worktree` 当时声明了 `shouldDefer`，与常驻的
 * `enter_plan_mode` 共享 `enter_`（6 字符）。延迟工具不在本轮 schema 里，模型
 * 「想调」它时会坍缩成当轮唯一共享前缀的真实工具：`enter_worktree` → `enter_plan_mode`
 * 误触 5 次、产出 4 份无用 plan 文件、任务卡死到用户手动打断
 * （轨迹 20260817-141456-065fe328）。这条门禁守的就是同一形态的下一次改动。
 *
 * ⚠️ 历史：2026-11-12 之前，同样的断言写在
 * `packages/core/tests/tool/worktree-tools-not-deferred.test.ts` 里，但它只往一个
 * 空 `Registry` 注册了 4 个工具，`deferredToolNames()` 在该 registry 里恒为空 ——
 * 「live × deferred 组合数为 0」**恒为真，从未红过**。恒绿的门禁比没有门禁更危险：
 * 它让人以为守住了，而 sid 报告 4.4 也因此写出了「新增延迟工具就会红」这句与代码
 * 不符的结论。现在改为从 T0 的 `--dump-tool-meta` 取真实注册表（全部内置工具 +
 * 延迟标记），注册表怎么变，这里就跟着怎么算。
 *
 * 小写化规则（**不放宽**）：名字里混着 snake_case 与 PascalCase
 * （`ListMcpResources` / `ReadMcpResource`），区分大小写会漏掉
 * `read` vs `ReadMcpResource` 这类碰撞。2026-08-17 的事故证明坍缩不看命名约定，
 * 门禁也就不能按命名约定给自己开豁免。代价是 `ReadMcpResource` 一旦延迟就会出现
 * 两对碰撞 —— 那正是 T7 裁决「只加 `isEnabled`、保持常驻」的原因之一。
 */

import { describe, expect, test } from "bun:test";
import { builtinToolMeta } from "../helpers/builtin-tool-meta.ts";

/**
 * 碰撞判据的前缀长度。
 *
 * 取 4 是 2026-08-17 事故复盘时定的下限：3 字符前缀（如 `web` / `task`）之间
 * 有大量正常同名族工具，按它判会天天红；4 字符（`web_` / `read` / `enter`）已经
 * 足以让生成期把名字认错。放宽这个数等于让门禁失明，不要为了让某对工具过而调小。
 */
const COLLISION_PREFIX_LEN = 4;

/** 两个名字的公共前缀长度（逐字符比较） */
function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * 碰撞对的键：两侧都转小写 + 字典序拼接，与先后顺序无关。
 * 报错信息里则用原名，方便直接定位到工具文件。
 */
function pairKey(a: string, b: string): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join(" vs ");
}

/**
 * 按「工具对」登记的豁免：键是 `pairKey()` 的产物。
 *
 * 登记条件是**两条同时成立**，缺一不许进这张表：
 *   1. 这一对确实共享 ≥4 字符前缀（否则是失效豁免，下面的自检会红）；
 *   2. 有证据证明它不会坍缩 —— 例如轨迹里 30 天的误触次数为 0，且两者的
 *      参数形态/调用场景不可能被模型混淆。
 *
 * 当前为空：真实注册表（24 常驻 / 18 延迟）在小写化口径下碰撞面就是 0。
 * 这张表一旦开始有内容，说明有人在为某对工具背书，理由必须写在这里而不是 PR 评论里。
 */
const EXEMPT_PAIRS: Record<string, string> = {};

describe("前缀碰撞面（真实注册表）：常驻 × 延迟不得共享 ≥4 字符前缀", () => {
  const meta = builtinToolMeta();
  const live = meta.filter((t) => !t.deferred).map((t) => t.name);
  const deferred = meta.filter((t) => t.deferred).map((t) => t.name);

  test("两组都非空（防门禁空跑）", () => {
    // 「延迟组为空」正是 2026-11-12 之前那条门禁恒绿的原因。任何一边空了，
    // 下面的笛卡尔积就退化成空集，门禁会重新变成恒绿——必须自己先红。
    expect(live.length, "常驻组为空，门禁已空跑").toBeGreaterThan(0);
    expect(deferred.length, "延迟组为空，门禁已空跑").toBeGreaterThan(0);
  });

  test(`live × deferred 且公共前缀 ≥${COLLISION_PREFIX_LEN}（小写比较）的组合数为 0`, () => {
    const collisions: { key: string; label: string }[] = [];
    for (const l of live) {
      for (const d of deferred) {
        if (commonPrefixLen(l.toLowerCase(), d.toLowerCase()) >= COLLISION_PREFIX_LEN) {
          collisions.push({ key: pairKey(l, d), label: `${l} vs ${d}` });
        }
      }
    }
    const unexempt = collisions.filter((c) => !EXEMPT_PAIRS[c.key]).map((c) => c.label);
    expect(
      unexempt,
      `以下「常驻 × 延迟」组合共享 ≥${COLLISION_PREFIX_LEN} 字符前缀，会把延迟工具坍缩成常驻工具：` +
        `${unexempt.join("、")}。要么把延迟的那个改回常驻，要么确认它们不会被混淆后在 ` +
        `EXEMPT_PAIRS 登记理由与证据。`,
    ).toEqual([]);
  });

  test("worktree / plan 四个工具在真实注册表里都是常驻（2026-08-17 事故的两个前缀对）", () => {
    // enter_worktree / enter_plan_mode 共享 `enter_`(6)，exit_worktree / exit_plan_mode
    // 共享 `exit_`(5)。四个都在常驻组时 live × live 不构成碰撞面；
    // 其中任何一个被延迟，上面的笛卡尔积就会命中，这条则先给出更直白的失败信息。
    const deferredSet = new Set(deferred);
    for (const name of ["enter_worktree", "exit_worktree", "enter_plan_mode", "exit_plan_mode"]) {
      expect(
        deferredSet.has(name),
        `${name} 在真实注册表里被标成延迟——它与同前缀工具的碰撞会重新打开 2026-08-17 的坍缩面`,
      ).toBe(false);
    }
  });

  test("豁免名单里的每一对都真实存在碰撞（防止改名后留下永久失效的豁免）", () => {
    for (const [key, reason] of Object.entries(EXEMPT_PAIRS)) {
      const [a, b] = key.split(" vs ");
      expect(
        commonPrefixLen(a, b),
        `豁免 ${key} 不再共享 ≥${COLLISION_PREFIX_LEN} 字符前缀，已失效，应当删掉`,
      ).toBeGreaterThanOrEqual(COLLISION_PREFIX_LEN);
      expect(reason.trim().length, `豁免 ${key} 没写理由与证据`).toBeGreaterThan(0);
    }
  });
});
