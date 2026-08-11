/**
 * CLI flag 校验纯函数单测（§7-7 缺口补齐）
 *
 * parseCLIArgs 本身非 export 且内部调用 process.exit，无法直接单测；
 * 但其依赖的校验纯函数是 export 的，这里覆盖它们的正常/边界/非法输入。
 * flag 的组合约束 + 子命令的端到端行为在 flag-e2e.test.ts 中通过 spawn 验证。
 */

import { describe, test, expect } from "bun:test";
import { isValidUUID } from "@sid-code/cli/cli.ts";
import { EFFORT_LEVELS, isEffortLevel } from "@sid-code/core/llm/effort.ts";

describe("isValidUUID（--session-id 校验）", () => {
  test("合法 UUID v4 → true", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("大写 UUID → true（大小写不敏感）", () => {
    expect(isValidUUID("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  test("缺段 → false", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716")).toBe(false);
  });

  test("非十六进制字符 → false", () => {
    expect(isValidUUID("zzzzzzzz-e29b-41d4-a716-446655440000")).toBe(false);
  });

  test("空串 → false", () => {
    expect(isValidUUID("")).toBe(false);
  });

  test("多余空白 → false（不做 trim，要求严格格式）", () => {
    expect(isValidUUID(" 550e8400-e29b-41d4-a716-446655440000 ")).toBe(false);
  });
});

describe("isEffortLevel（--effort 校验）", () => {
  test("五档全部合法", () => {
    for (const lvl of ["low", "medium", "high", "xhigh", "max"]) {
      expect(isEffortLevel(lvl)).toBe(true);
    }
  });

  test("EFFORT_LEVELS 恰好是这五档", () => {
    expect([...(EFFORT_LEVELS as readonly string[])].sort()).toEqual(
      ["high", "low", "max", "medium", "xhigh"].sort(),
    );
  });

  test("auto 不是合法档位（由上层单独处理为 undefined）", () => {
    expect(isEffortLevel("auto")).toBe(false);
  });

  test("未知档位 → false", () => {
    expect(isEffortLevel("ultra")).toBe(false);
    expect(isEffortLevel("")).toBe(false);
  });
});
