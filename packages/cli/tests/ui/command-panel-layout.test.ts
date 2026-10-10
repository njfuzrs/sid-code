/**
 * 命令输出面板的纯函数口径：换行、视口、滚动夹取、摘要行。
 * 视口算错 = 面板顶出屏幕或只剩边框；滚动越界 = 空白页；这两类都是肉眼才发现的缺陷，用单测锁住。
 */

import { describe, test, expect } from "bun:test";
import stringWidth from "string-width";
import {
  PANEL_CHROME_ROWS,
  PANEL_SCREEN_RESERVE_ROWS,
  PANEL_MIN_VIEWPORT_ROWS,
  clampPanelOffset,
  maxPanelOffset,
  panelScrollLabel,
  panelSummaryLine,
  panelViewportRows,
  wrapPanelContent,
} from "@sid-code/cli/ui/components/command-panel-layout.ts";

describe("wrapPanelContent", () => {
  test("按列宽折行，CJK 按 2 列计", () => {
    const lines = wrapPanelContent("一二三四五六七八九十", 10);
    expect(lines.length).toBe(2);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(10);
  });

  test("保留空行，去掉尾部空白", () => {
    expect(wrapPanelContent("a\n\nb\n\n", 20)).toEqual(["a", "", "b"]);
  });

  test("制表符展开、CRLF 归一", () => {
    expect(wrapPanelContent("a\tb\r\nc", 20)).toEqual(["a  b", "c"]);
  });

  test("空内容 → 无行", () => {
    expect(wrapPanelContent("  \n ", 20)).toEqual([]);
  });

  test("ANSI 颜色在折行后保留，且不计入宽度", () => {
    const lines = wrapPanelContent("\x1b[32m✔ ok\x1b[0m", 20);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\x1b[32m");
  });
});

describe("视口与滚动", () => {
  test("内容少于可用高度 → 视口 = 内容行数（面板不留大片空白）", () => {
    expect(panelViewportRows(40, 5)).toBe(5);
  });

  test("内容多于可用高度 → 视口 = 终端高度减去外框与预留", () => {
    expect(panelViewportRows(40, 500)).toBe(40 - PANEL_CHROME_ROWS - PANEL_SCREEN_RESERVE_ROWS);
  });

  test("极矮终端 → 视口不低于下限", () => {
    expect(panelViewportRows(8, 500)).toBe(PANEL_MIN_VIEWPORT_ROWS);
  });

  test("偏移夹在 [0, 内容 - 视口]", () => {
    expect(maxPanelOffset(100, 30)).toBe(70);
    expect(clampPanelOffset(-5, 100, 30)).toBe(0);
    expect(clampPanelOffset(999, 100, 30)).toBe(70);
    expect(clampPanelOffset(10, 5, 30)).toBe(0);
  });

  test("滚动提示：一屏放得下时不显示", () => {
    expect(panelScrollLabel(0, 30, 10)).toBeNull();
    expect(panelScrollLabel(0, 30, 85)).toBe("1–30 / 85 行");
    expect(panelScrollLabel(55, 30, 85)).toBe("56–85 / 85 行");
  });
});

describe("panelSummaryLine：面板关闭后留在消息流的痕迹", () => {
  test("取首个非空行 + 总行数", () => {
    expect(panelSummaryLine("\n环境自检 7/8 通过\n✔ git\n✘ rg")).toBe(
      "环境自检 7/8 通过（4 行 · 已在面板中查看）",
    );
  });

  test("首行去 ANSI，超宽截断补 …", () => {
    const s = panelSummaryLine("\x1b[31m" + "长".repeat(50) + "\x1b[0m\n二\n三", 20);
    expect(s).not.toContain("\x1b[");
    expect(s.startsWith("长".repeat(9) + "…")).toBe(true);
  });
});
