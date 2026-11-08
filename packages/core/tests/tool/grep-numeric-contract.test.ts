/**
 * B25：grep 数字入参的契约不能被归一层放宽（Harness 厚薄归位专项，2026-11-08）。
 *
 * 修复前两条实测：
 * - `offset:"-5-3"` → 5：区间切分把前导负号当分隔符切掉了，而同值写成数字 `-5` 会被 `min(0)` 拒；
 * - `head_limit:""` → 0（= 不限条数）：数字归一层按设计把 `""` 放回让 zod 报错，
 *   但 grep 的字段是 `z.coerce.number()`，coerce 把 `""` 静默变成 0。
 *
 * 走真实 `GrepTool` 的 zodSchema + `validateToolInput`，而不是手搓 schema：
 * 这条缺陷的一半在 grep.ts 的字段定义上，桩 schema 测不到它。
 */

import { describe, test, expect } from "bun:test";
import { validateToolInput } from "@sid-code/core/tool/input-validator.ts";
import { GrepTool } from "@sid-code/core/tool/grep.ts";

const grep = new GrepTool();

function check(extra: Record<string, unknown>) {
  return validateToolInput(grep, { pattern: "x", ...extra });
}

describe("grep 数字入参：判不准就报错，不替模型编一个更宽的值", () => {
  test.each([
    ["offset 区间带前导负号", { offset: "-5-3" }],
    ["offset 负数串", { offset: "-5" }],
    ["head_limit 空串", { head_limit: "" }],
    ["head_limit 纯空白", { head_limit: "   " }],
    ["context 空串", { context: "" }],
    ["offset 空串", { offset: "" }],
    ["max_matches_per_file 布尔", { max_matches_per_file: true }],
    ["head_limit 空数组", { head_limit: [] }],
    ["offset 中间有空段", { offset: "1,,2" }],
  ])("%s → 校验失败", (_name, extra) => {
    const r = check(extra);
    expect(r.ok).toBe(false);
  });

  test.each([
    ["数字串照常归一", { head_limit: "5" }, { head_limit: 5 }],
    ["区间取起点", { offset: "117, 130" }, { offset: 117 }],
    ["连字符区间取起点", { offset: "3-5" }, { offset: 3 }],
    ["显式 0 = 不限条数仍然合法", { head_limit: 0 }, { head_limit: 0 }],
    ["null 摘掉 = 未提供", { head_limit: null }, {}],
  ])("%s", (_name, extra, expected) => {
    const r = check(extra);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as Record<string, unknown>;
    for (const key of Object.keys(extra)) {
      expect(data[key]).toEqual((expected as Record<string, unknown>)[key]);
    }
  });
});
