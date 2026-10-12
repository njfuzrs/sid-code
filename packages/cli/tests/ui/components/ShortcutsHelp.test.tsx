/**
 * ShortcutsHelp 渲染快照测试 — K1
 *
 * 验证 ShortcutsHelp 从运行时键位表 + 仅展示项生成后，渲染出全部关键快捷键，
 * 且描述不在列宽内折行（此前 33% 固定列宽把「（双击确认）」截成两行）。
 *
 * 测试渲染用 vendored ink 的测试 shim 抓 lastFrame 断言。
 */

import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { ShortcutsHelp } from "@sid-code/cli/ui/components/ShortcutsHelp.tsx";
import { DEFAULT_BINDINGS } from "@sid-code/cli/ui/keybindings/defaultBindings.ts";
import {
  buildHelpSections,
  HELP_ONLY_SHORTCUTS,
} from "@sid-code/cli/ui/keybindings/helpShortcuts.ts";

// 去 ANSI 后逐行比对
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("K1 — ShortcutsHelp 从表生成", () => {
  test("渲染出退出 / 复制模式 / Markdown 等关键键描述", () => {
    // 宽终端：这里测的是「不丢项」，不是换行。
    const { lastFrame } = render(<ShortcutsHelp />, { columns: 200 });
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("按两次退出");
    expect(frame).toContain("复制模式");
    expect(frame).toContain("切换 Markdown 渲染");
    expect(frame).toContain("展开/收起折叠内容");
    expect(frame).toContain("中断模型输出");
  });

  test("渲染出对应的按键名(Ctrl+C / Alt+M 等)", () => {
    const { lastFrame } = render(<ShortcutsHelp />, { columns: 200 });
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("Ctrl+C");
    expect(frame).toContain("Alt+M");
    expect(frame).toContain("Ctrl+O");
  });

  test("补齐此前缺失的固定键：Esc Esc / Ctrl+D / Tab / 翻页 / Emacs 编辑键", () => {
    const { lastFrame } = render(<ShortcutsHelp />, { columns: 200 });
    const frame = strip(lastFrame() ?? "");
    for (const k of ["Esc Esc", "Ctrl+D", "Tab", "PgUp/PgDn", "Shift+↑/↓", "Ctrl+K/U/W", "?"]) {
      expect(frame).toContain(k);
    }
  });

  test("标题不再误导去 /help，改为说明怎么关闭与改绑", () => {
    const { lastFrame } = render(<ShortcutsHelp />, { columns: 200 });
    const frame = strip(lastFrame() ?? "");
    expect(frame).not.toContain("输入 /help 查看更多");
    expect(frame).toContain("任意键关闭");
  });

  test("有前提条件的键把条件写进分组标题", () => {
    const { lastFrame } = render(<ShortcutsHelp />, { columns: 200 });
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("仅在输出中生效");
    expect(frame).toContain("无对应任务时照常编辑输入");
  });

  // 原始问题：120 列下「终止全部后台任务（双击确认」+ 下一行孤立的「）」。
  for (const columns of [80, 120, 160]) {
    test(`${columns} 列下每条描述都完整出现在同一行（不折行）`, () => {
      const { lastFrame } = render(<ShortcutsHelp />, { columns });
      const lines = strip(lastFrame() ?? "").split("\n");
      const items = buildHelpSections(DEFAULT_BINDINGS).flatMap((s) => s.items);
      const broken = items.filter((i) => !lines.some((l) => l.includes(i.description)));
      expect(broken.map((i) => i.description)).toEqual([]);
    });
  }
});

describe("helpShortcuts — 数据完整性", () => {
  test("所有 showInHelp 绑定都进了某个分组（没有项被分组过滤丢掉）", () => {
    const shown = DEFAULT_BINDINGS.filter((b) => b.showInHelp).length;
    const total = buildHelpSections(DEFAULT_BINDINGS).reduce((n, s) => n + s.items.length, 0);
    expect(total).toBe(shown + HELP_ONLY_SHORTCUTS.length);
  });

  test("仅展示项不与运行时表的 display 重复（防同一键出现两次）", () => {
    const displays = new Set(DEFAULT_BINDINGS.filter((b) => b.showInHelp).map((b) => b.display));
    expect(HELP_ONLY_SHORTCUTS.filter((s) => displays.has(s.key)).map((s) => s.key)).toEqual([]);
  });
});
