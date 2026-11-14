/**
 * CP-12：无头模式退出前必须落一次用量统计（`usage_stats` / `side_call_stats` / `agent_usage`）。
 *
 * 为什么这条必须有一个门禁：`persistUsageStats()` 原先只挂在 TUI 的每轮 done 上，
 * `-p` 与 `--output-format stream-json` 两条无头路径从不落盘。单看它不是 bug ——
 * 那时账本按进程 id 拆两行、每行只含自己那段，按 sessionId 求和恰好对。
 * 但账本改成**逻辑会话 id 单行**后，resume 那一行只含第二段，少算前一段，
 * 而且「按行求和」看不出问题（只有一行）。也就是说：这条落盘是「单行化」成立的
 * 前提，缺了它，修复本身会把「双计」换成「丢账」。
 *
 * 为什么用源码扫描而不是行为测试：走 `runHeadless` 行为层需要真实模型调用（G3），
 * 门禁跑不了。这里守的是「接线在不在、顺序对不对」——`persistUsageStats` 必须在
 * `finalizeSessionStore()` **之前**（`appendMetadata` 需要 store 还开着），
 * 这两点正是删掉/挪位时会静默失效的部分。
 *
 * 只读源码，不落盘、不联网。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_TS = join(import.meta.dir, "../../src/app.ts");

/** 截出某个方法体：从签名行到下一个同级方法（两空格缩进的非空行）开头。 */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + signature.length);
  const nextMethod = /\n {2}(?:private |public |protected )?(?:async )?[a-zA-Z_][\w]*\(/;
  const m = rest.match(nextMethod);
  return m ? rest.slice(0, m.index) : rest;
}

function assertPersistBeforeFinalize(body: string, label: string): void {
  const persistIdx = body.indexOf("this.persistUsageStats();");
  const finalizeIdx = body.indexOf("this.finalizeSessionStore();");
  expect(persistIdx, `${label} 必须调用 this.persistUsageStats()`).toBeGreaterThan(-1);
  expect(finalizeIdx, `${label} 必须调用 this.finalizeSessionStore()`).toBeGreaterThan(-1);
  // 顺序：appendMetadata 需要 sessionStore 还开着，先落统计再 finalize
  expect(persistIdx, `${label} 的统计落盘必须在 finalizeSessionStore 之前`).toBeLessThan(
    finalizeIdx,
  );
}

describe("CP-12：无头模式退出前落用量统计", () => {
  const src = readFileSync(APP_TS, "utf-8");

  test("`-p`（runHeadless）收尾在 finalize 前落统计", () => {
    assertPersistBeforeFinalize(methodBody(src, "async runHeadless(input: string)"), "runHeadless");
  });

  test("`--output-format stream-json`（runHeadlessSDK）收尾同样落统计", () => {
    assertPersistBeforeFinalize(
      methodBody(src, "private async runHeadlessSDK(input: string)"),
      "runHeadlessSDK",
    );
  });

  test("TUI 路径仍保留每轮 done 落统计（不能被这次改动顺手删掉）", () => {
    // TUI 的 done 分支里 `this.persistUsageStats();` 是既有行为，与上面两条同属
    // 「会话维度字段必须有落盘来源」这条不变量。计数断言：至少 3 处调用
    // （TUI done + runHeadless + runHeadlessSDK）。
    const calls = src.match(/this\.persistUsageStats\(\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
