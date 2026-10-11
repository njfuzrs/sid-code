/**
 * SID_CODE_DEBUG 取值口径（B27）：必须与渲染底座 `packages/tui/src/stderr-guard.ts` 一致（1 / true），
 * 否则同一个变量会出现「ink 日志开了、debug.log 没开」的半开状态。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDebugEnvEnabled } from "@sid-code/cli/cli.ts";

describe("isDebugEnvEnabled", () => {
  test("1 / true 开启", () => {
    expect(isDebugEnvEnabled("1")).toBe(true);
    expect(isDebugEnvEnabled("true")).toBe(true);
  });

  test("未设 / 空 / 0 / false / 其他值不开启", () => {
    for (const v of [undefined, "", "0", "false", "yes", "TRUE "]) {
      expect(isDebugEnvEnabled(v)).toBe(false);
    }
  });

  test("与渲染底座读取口径一致", () => {
    const src = readFileSync(join(import.meta.dir, "../../../tui/src/stderr-guard.ts"), "utf8");
    expect(src).toContain("const debugValue = process.env['SID_CODE_DEBUG'];");
    expect(src).toContain("debugValue === '1' || debugValue === 'true'");
  });
});
