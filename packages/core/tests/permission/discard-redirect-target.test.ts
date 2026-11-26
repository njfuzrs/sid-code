/**
 * D2：「丢弃型重定向目标」的口径一致性（族 A 三处共用同一个判定）。
 *
 * ## 守的是什么
 *
 * `parser.ts` / `permission/allow-composition.ts` / `task/status-query-commands.ts`
 * 三处都在回答同一个问题——「这个重定向算不算写盘」。修前它们各自实现了一份判定：
 * `parser.ts` 认 `{/dev/null, /dev/zero}`，另两处只认 `/dev/null`。结果是**同一条命令两个结论**：
 * `echo hi > /dev/zero` 在只读判定里算只读，在 allow 规则组合里却是「非纯过滤器」——
 * 而后者在放行路径上。口径已裁决统一到 `{/dev/null, /dev/zero}`（缺陷文档 D2「口径已裁决」）。
 *
 * ## 期望值从哪来（不从实现反推）
 *
 * 判据是「写进去**不产生任何持久副作用**」：`/dev/null` 与 `/dev/zero` 是设备节点，
 * 写进去即丢弃 → 同族；`/dev/nullo` 是一个名字恰好像 `null` 的**真实文件**、
 * `/dev/shm/x` 是 /dev 下的 tmpfs 真实文件、`/tmp/x` 是真实临时文件 → 都会落盘，不算丢弃。
 *
 * `/dev/nullo` 是**真实踩过的坑**：它曾因 `startsWith("/dev/null")` 被当成丢弃目标放行，
 * `bash-security.ts` 的 `stripSafeRedirections` 与 `parser.ts` 各自独立修过一次。
 *
 * ## 变异自证
 *
 * 把 `isDiscardRedirectTarget` 的集合改成只认 `/dev/null` → 本文件里所有 `/dev/zero` 用例转红；
 * 改回 → 全绿。
 */

import { describe, test, expect } from "bun:test";
import { isDiscardRedirectTarget } from "@sid-code/core/tool/bash/parser.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";
import { isPipelineFilterStage } from "@sid-code/core/permission/allow-composition.ts";
import { matchStatusQuery } from "@sid-code/core/task/status-query-commands.ts";

/** 每个目标 + 人工语义期望（true = 丢弃型，写进去不留下任何东西） */
const TARGETS: ReadonlyArray<readonly [string, boolean]> = [
  ["/dev/null", true],
  ["/dev/zero", true],
  ["/dev/nullo", false],
  ["/dev/shm/x", false],
  ["/tmp/x", false],
];

describe("isDiscardRedirectTarget：整段精确相等，不做前缀匹配", () => {
  for (const [target, expected] of TARGETS) {
    test(`${target} → ${expected}`, () => {
      expect(isDiscardRedirectTarget(target)).toBe(expected);
    });
  }

  test("/dev/nullo 不被当成 /dev/null 的前缀命中（历史踩坑形态）", () => {
    expect(isDiscardRedirectTarget("/dev/nullo")).toBe(false);
    // 反向也钉一下：/dev/null 本身必须认（否则这条用例在任何实现下都能过）
    expect(isDiscardRedirectTarget("/dev/null")).toBe(true);
  });

  test("近似形态一律不认：尾斜杠、子路径、大小写变体", () => {
    for (const t of ["/dev/null/", "/dev/null/x", "/dev/zeroo", "/DEV/NULL", "", "/dev/nul"]) {
      expect(isDiscardRedirectTarget(t)).toBe(false);
    }
  });
});

describe("族 A-1：isReadOnlyCommand 的口径", () => {
  for (const [target, expected] of TARGETS) {
    test(`echo hi > ${target} → ${expected ? "只读" : "非只读"}`, () => {
      expect(isReadOnlyCommand(`echo hi > ${target}`)).toBe(expected);
    });
  }
});

describe("族 A-2：isPipelineFilterStage 的口径（allow 规则组合那一侧）", () => {
  for (const [target, expected] of TARGETS) {
    test(`tail -5 > ${target} → ${expected ? "纯过滤器" : "非纯过滤器"}`, () => {
      expect(isPipelineFilterStage(`tail -5 > ${target}`)).toBe(expected);
    });
  }
});

describe("族 A-3：matchStatusQuery 的口径（状态查询那一侧）", () => {
  // 入口选 `matchStatusQuery`：它是 status-query-commands.ts 的公开导出，重定向判定
  // （`extractRedirectTargets(ast).filter(...)`）就在它内部，是「能否判成纯查询」的直接出口。
  // 期望来自人工语义：查询结果重定向到丢弃型设备 = 没有留下任何新信息到磁盘以外的副作用，
  // 仍然是纯查询；重定向到真实文件 = 有副作用，不算纯查询。
  for (const [target, expected] of TARGETS) {
    test(`gh pr checks 701 > ${target} → ${expected ? "纯查询" : "非纯查询"}`, () => {
      const m = matchStatusQuery(`gh pr checks 701 > ${target}`);
      if (expected) expect(m).not.toBeNull();
      else expect(m).toBeNull();
    });
  }

  test("对照：不带重定向的查询必须认得出（防「一律 null 也全绿」）", () => {
    expect(matchStatusQuery("gh pr checks 701")).not.toBeNull();
  });
});

describe("族 A 三处同口径（同一形态不能出现两把尺子）", () => {
  for (const [target] of TARGETS) {
    test(`${target} 在只读判定 / 纯过滤器 / 纯查询三处答案一致`, () => {
      const readOnly = isReadOnlyCommand(`echo hi > ${target}`);
      const filter = isPipelineFilterStage(`tail -5 > ${target}`);
      // status 查询换一条命令形态但目标相同：只有在目标被认作丢弃型时才会判成纯查询
      const statusQuery = matchStatusQuery(`gh pr checks 701 > ${target}`) !== null;
      expect(filter).toBe(readOnly);
      expect(statusQuery).toBe(isDiscardRedirectTarget(target));
      expect(readOnly).toBe(isDiscardRedirectTarget(target));
    });
  }
});
