/**
 * 注释 / 源码里的「事实声明」与代码对齐（防漂移门禁，2026-10-29）
 *
 * 背景：《AgenticLoop 从零到一》§2 一次核出 9 条文档漂移 + 2 条注释腐坏，全部是
 * 「文档/注释手写了代码事实」的必然产物。这里只锁**仓内**能机械校验的那几条：
 *
 *   1. `yield done` 出口数用区间 [20, 40]，不用等值——从 22 涨到 28 是正常演进，
 *      等值断言只会逼人为改绿去改数字（`negative-yield-defense-audit-fixes.test.ts` 那条
 *      「22 处」腐坏注释就是这么来的）。有诊断价值的是「多到必须 finally + 幂等」这个事实，
 *      所以注释统一写「20+」，下限 20 守的正是那句话。
 *   2. empty-param.ts 顶部不得再声称「每次重试前先压缩」：实际有 P0-2 占用率门禁。
 *   3. loop.ts 的 P0-2 白名单理由注释必须仍在——它是「为什么判据是白名单」的唯一解释，
 *      被重构顺手删掉就找不回来；stop-reason-policy.ts 同样要写明 fail-closed。
 *   4. 注释里不得再出现「22 处 / 22 个 yield done」这类写死的出口数。
 *
 * fix_type: regression_guard
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { MAX_EMPTY_PARAM_RETRIES } from "@sid-code/core/query/empty-param.ts";

const SRC = join(import.meta.dir, "../../src/query");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

describe("注释事实与代码对齐", () => {
  test("loop.ts 的 done 出口数落在 [20, 40]（区间，不是等值）", () => {
    const n = (read("loop.ts").match(/kind: "done"/g) ?? []).length;
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(40);
  });

  test("提到 done 出口数的注释只写「20+」，不写死具体数", () => {
    const files = ["loop.ts", "types.ts", "turn-complete.ts"].map((f) => [f, read(f)] as const);
    const testFile = readFileSync(
      join(import.meta.dir, "negative-yield-defense-audit-fixes.test.ts"),
      "utf8",
    );
    for (const [name, src] of [
      ...files,
      ["negative-yield-defense-audit-fixes.test.ts", testFile] as const,
    ]) {
      // 「有 N 处/个 yield done」形态；N 为纯数字即违规（20+ 合规）
      const bad = src.match(/有\s*\d+\s*[处个]\s*`?(yield done|yield \{ kind: "done")/g);
      expect({ name, bad }).toEqual({ name, bad: null });
    }
  });

  test("empty-param.ts 顶部注释不再声称「每次重试前先压缩」，且写明占用率门禁", () => {
    const head = read("empty-param.ts").split("*/")[0]!;
    expect(head).not.toContain("每次重试前先压缩上下文");
    expect(head).toContain("soft 档");
    expect(MAX_EMPTY_PARAM_RETRIES).toBeGreaterThan(0);
  });

  test("P0-2 白名单理由仍在，分类器写明 fail-closed", () => {
    expect(read("loop.ts")).toContain('不要改成"排除已知的错误情况"');
    expect(read("stop-reason-policy.ts")).toContain("fail-closed");
  });
});
