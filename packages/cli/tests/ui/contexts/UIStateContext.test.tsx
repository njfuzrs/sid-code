/**
 * TO4 — 工具结果阶梯式展开级别测试
 *
 * 验证展开级别的纯转换逻辑与行数映射。状态机本身用纯函数表达，
 * 避免依赖 React 渲染时序（vendored ink 测试 shim 对外部 setState 不保证同步刷新）。
 */

import { test, expect, describe } from "bun:test";
import {
  EXPAND_LEVEL_MAX_LINES,
  nextExpandLevel,
  expandLevelFromConstrain,
  type ExpandLevel,
} from "@sid-code/cli/ui/contexts/UIStateContext.tsx";

describe("TO4 — EXPAND_LEVEL_MAX_LINES 映射", () => {
  test("级别 0/1/2 对应 3/50/Infinity（对标 cc MAX_LINES_TO_SHOW=3）", () => {
    expect(EXPAND_LEVEL_MAX_LINES[0]).toBe(3);
    expect(EXPAND_LEVEL_MAX_LINES[1]).toBe(50);
    expect(EXPAND_LEVEL_MAX_LINES[2]).toBe(Infinity);
  });
});

describe("TO4 — nextExpandLevel 循环", () => {
  test("0→1→2→0 循环", () => {
    expect(nextExpandLevel(0)).toBe(1);
    expect(nextExpandLevel(1)).toBe(2);
    expect(nextExpandLevel(2)).toBe(0);
  });
});

describe("TO4 — expandLevelFromConstrain 向后兼容", () => {
  test("true→级别0（折叠），false→级别2（全展开）", () => {
    expect(expandLevelFromConstrain(true)).toBe(0 as ExpandLevel);
    expect(expandLevelFromConstrain(false)).toBe(2 as ExpandLevel);
  });
});
