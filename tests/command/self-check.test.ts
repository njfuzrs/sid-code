/**
 * 编译产物自检单测（command/self-check.ts，方向 0）
 *
 * 回归目标：runSelfCheck 必须真正跑一遍关键代码路径（git-status 锚点 + 止损阀），
 * 在当前仓库（含全部修复）下返回 true。若某天修复被误删导致锚点缺失，自检应转为 false——
 * 这条测试与 make build/rebuild/release 末尾的 --self-check 调用同源，双保险。
 */

import { describe, test, expect } from "bun:test";
import { runSelfCheck } from "../../src/command/self-check.ts";

describe("runSelfCheck", () => {
  test("当前仓库（含全部修复）自检通过", async () => {
    const ok = await runSelfCheck();
    expect(ok).toBe(true);
  });
});
