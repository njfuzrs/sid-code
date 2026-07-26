/**
 * §12 P2-1 复审：maxThinkingTokens 配置链路回归
 *
 * 覆盖「用户写进配置 → 进入 Config → 被 effort 层消费」这条链路的两个薄弱环节：
 *   1. 字段归一化：settings.json（camelCase）直通 + YAML 风格（snake_case）别名命中同一字段。
 *      此前 maxThinkingTokens 只靠 keyMap 的 `keyMap[k] || k` 兜底隐式透传，没有显式登记、
 *      也没有任何测试——一旦有人给 keyMap 加了同名不同义的条目就会静默改写用户配置。
 *   2. schema 校验边界：必须是正整数（0 / 负数 / 小数一律拒绝）。
 *
 * 单独成文件（而非并入 tests/llm/effort.test.ts）：本文件要 import config.ts，
 * 它带全局配置态副作用，与 effort 测试同文件会污染 tests/config 下其它用例。
 */

import { describe, test, expect } from "bun:test";
import { normalizeConfigKeysForTest } from "../../src/config/config.ts";
import { SettingsSchema } from "../../src/config/settings/types.ts";

describe("§12 P2-1 maxThinkingTokens 字段归一化", () => {
  test("snake_case 别名 max_thinking_tokens 命中 Config.maxThinkingTokens", () => {
    expect(normalizeConfigKeysForTest({ max_thinking_tokens: 8000 }).maxThinkingTokens).toBe(8000);
  });

  test("camelCase（settings.json 口径）直通保留", () => {
    expect(normalizeConfigKeysForTest({ maxThinkingTokens: 12000 }).maxThinkingTokens).toBe(12000);
  });

  test("未设时不出现该字段（undefined 而非 0，避免被当成「已钳制到 0」）", () => {
    expect(normalizeConfigKeysForTest({ model: "x" }).maxThinkingTokens).toBeUndefined();
  });
});

describe("§12 P2-1 maxThinkingTokens schema 边界", () => {
  const schema = SettingsSchema();

  test("正整数通过", () => {
    expect(schema.safeParse({ maxThinkingTokens: 8000 }).success).toBe(true);
  });

  test("0 / 负数 / 小数被拒绝", () => {
    expect(schema.safeParse({ maxThinkingTokens: 0 }).success).toBe(false);
    expect(schema.safeParse({ maxThinkingTokens: -1 }).success).toBe(false);
    expect(schema.safeParse({ maxThinkingTokens: 1.5 }).success).toBe(false);
  });

  test("缺省合法（不钳制）", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });
});
