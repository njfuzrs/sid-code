/**
 * 缺陷 11：stream-json 路径的「是不是中断」判定。
 *
 * 以前 SDKQueryEngine 和 app.ts runHeadlessSDK 各写一份 `name === "AbortError" || /abort/i`，
 * 引擎那份（wasAborted）零调用者。裸子串有两个方向的错：
 *   - 宿主 interrupt 走 abort("user-cancel")，Promise 以裸字符串 reject，包成 Error 后不含 abort → 判不出；
 *   - 模型错误文案里带 "aborted" → 误判成中断，endReason=abort、退出码 0。
 * 现在编排层只留一处，用 isAbortError 判原始 err。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAbortError } from "@sid-code/core/llm/errors.ts";

const repoRoot = join(import.meta.dir, "../../../..");

describe("缺陷 11：SDK 路径中断判定", () => {
  test("宿主 interrupt 的裸字符串 reason 判为中断", () => {
    expect(isAbortError("user-cancel")).toBe(true);
    expect(isAbortError("session-timeout")).toBe(true);
  });

  test("模型错误文案里带 aborted 不判为中断", () => {
    const err = new Error("the model aborted generation due to content policy");
    expect(/abort/i.test(err.message)).toBe(true); // 旧判据会误判
    expect(isAbortError(err)).toBe(false);
  });

  test("runHeadlessSDK 不再用 /abort/i 裸子串判中断，引擎不再暴露 wasAborted", () => {
    const app = readFileSync(join(repoRoot, "packages/cli/src/app.ts"), "utf-8");
    const start = app.indexOf("const outcome = await sdkRunHeadless(");
    expect(start).toBeGreaterThan(0);
    // 去掉行注释再断言：注释里讲历史可以提到旧判据，门禁只看代码
    const block = app
      .slice(start, app.indexOf("fireSessionEndEvent", start))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(block).toContain("aborted = isAbortError(err)");
    expect(block).not.toMatch(/\/abort\/i/);

    const engine = readFileSync(join(repoRoot, "packages/core/src/sdk/query-engine.ts"), "utf-8");
    expect(engine).not.toMatch(/wasAborted\s*\(\)\s*:/);
  });
});
