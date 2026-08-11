/**
 * 编译产物自检单测（command/self-check.ts，方向 0）
 *
 * 回归目标：runSelfCheck 必须真正跑一遍关键代码路径，在当前仓库（含全部修复）下返回 true。
 * 若某天修复被误删导致锚点缺失，自检应转为 false——这条测试与 make build / release.sh
 * 末尾的 --self-check 调用同源，双保险。
 *
 * 覆盖 4 条校验：git-status 锚点、止损阀、内置 skill 已嵌入、内嵌 rg 平台匹配。
 * 后两条（2026-08-01 新增）挡的是两类**静默**故障：skill 忘生成 → 运行时内置 skill 消失；
 * rg 嵌错平台 → 静默降级回系统 rg。两者在此前都是一路绿灯，正是自检该管的盲区。
 */

import { describe, test, expect } from "bun:test";
import { runSelfCheck } from "@sid-code/cli/command/self-check.ts";
import {
  EMBEDDED_BUILTIN_SKILLS,
  EMBEDDED_BUILTIN_SKILLS_HASH,
} from "@sid-code/core/skill/builtin-embedded.generated.ts";

describe("runSelfCheck", () => {
  test("当前仓库（含全部修复）自检通过", async () => {
    const ok = await runSelfCheck();
    expect(ok).toBe(true);
  });
});

describe("内置 skill 嵌入校验的判据", () => {
  // 刻意不断言具体数量：写死的话每加一个 skill 都要改测试，改测试的手会顺手把数字
  // 改对，断言就退化成摆设。只断言与数量无关的不变量。
  test("嵌入清单非空", () => {
    expect(Array.isArray(EMBEDDED_BUILTIN_SKILLS)).toBe(true);
    expect(EMBEDDED_BUILTIN_SKILLS.length).toBeGreaterThan(0);
  });

  test("哈希非空（ensure-builtin 靠它判断是否重新释放）", () => {
    expect(EMBEDDED_BUILTIN_SKILLS_HASH).toBeTruthy();
  });

  test("每个 skill 都有名字且至少含一个文件", () => {
    for (const s of EMBEDDED_BUILTIN_SKILLS) {
      expect(s.name).toBeTruthy();
      expect(Array.isArray(s.files)).toBe(true);
      expect(s.files.length).toBeGreaterThan(0);
    }
  });
});

describe("内嵌 rg 校验在 dev 模式下的行为", () => {
  test("dev 模式（bun test 即 dev）不因缺内嵌 rg 而失败", async () => {
    // 单测跑在 bun run 语境下，IS_DEV_MODE 为 true，checkEmbeddedRipgrep 应直接跳过。
    // 这条锁住"dev 环境不误报"——否则每次本地跑单测都会被内嵌 rg 绊倒。
    const { IS_DEV_MODE } = await import("@sid-code/core/bootstrap/resolve-executable.ts");
    expect(IS_DEV_MODE).toBe(true);
    expect(await runSelfCheck()).toBe(true);
  });
});
