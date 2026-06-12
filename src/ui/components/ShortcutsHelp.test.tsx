/**
 * ShortcutsHelp 渲染快照测试 — K1
 *
 * 验证 ShortcutsHelp 从 DEFAULT_BINDINGS 生成后,仍渲染出全部关键快捷键。
 * 防止「从表生成」重构后丢项。
 *
 * 测试渲染用 vendored ink 的测试 shim(src/ink/_vendor/testing.tsx)抓 lastFrame 断言。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "../../ink/_vendor/testing.js";
import { ShortcutsHelp } from "./ShortcutsHelp.tsx";

describe("K1 — ShortcutsHelp 从表生成", () => {
  test("渲染出退出 / Copy Mode / Markdown 等关键键描述", () => {
    const { lastFrame } = render(<ShortcutsHelp />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("退出");
    expect(frame).toContain("Copy Mode");
    expect(frame).toContain("切换 Markdown 渲染");
    expect(frame).toContain("切换高度限制");
    expect(frame).toContain("取消当前操作");
  });

  test("渲染出对应的按键名(Ctrl+C / Alt+M 等)", () => {
    const { lastFrame } = render(<ShortcutsHelp />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ctrl+C");
    expect(frame).toContain("Alt+M");
    expect(frame).toContain("Ctrl+O");
  });
});
