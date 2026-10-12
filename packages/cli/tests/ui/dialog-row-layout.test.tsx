/**
 * 列表类面板行布局回归（与 /commands 面板同源的问题）：
 * 一行内平铺多个 Text、外部数据过长或带换行时，yoga 压缩前面的 Text，
 * 名称被折成两行、后续列起点漂移。这里锁住共享工具与三个典型面板。
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import stringWidth from "string-width";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import {
  truncateToWidth,
  oneLine,
  fitCell,
  clipLine,
  columnWidth,
} from "@sid-code/cli/ui/components/shared/text-layout.ts";
import { McpDialog, computeMcpServerLayout } from "@sid-code/cli/ui/components/McpDialog.tsx";
import { HooksDialog } from "@sid-code/cli/ui/components/HooksDialog.tsx";
import { memoryNameColWidth } from "@sid-code/cli/ui/components/MemoryDialog.tsx";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** 等一拍再取帧：McpDialog 等组件在 useEffect 里才加载数据，首帧是空态 */
async function frame(el: React.ReactElement, columns: number): Promise<string[]> {
  const { lastFrame, unmount } = render(<KeypressProvider>{el}</KeypressProvider>, { columns });
  await new Promise((r) => setTimeout(r, 30));
  const out = stripAnsi(lastFrame() ?? "").split("\n");
  unmount();
  return out;
}

describe("shared/text-layout", () => {
  test("truncateToWidth 按显示宽截断（CJK 一字 2 列），不是按码元", () => {
    const s = truncateToWidth("中文中文中文中文", 7);
    expect(stringWidth(s)).toBeLessThanOrEqual(7);
    expect(s.endsWith("…")).toBe(true);
  });

  test("oneLine 压掉换行与连续空白", () => {
    expect(oneLine("a\n  b\t\tc\n")).toBe("a b c");
    expect(oneLine(undefined)).toBe("");
  });

  test("fitCell 结果显示宽度恒等于列宽", () => {
    for (const v of ["短", "a much longer value here", "多行\n内容\n很长很长很长", ""]) {
      expect(stringWidth(fitCell(v, 10))).toBe(10);
    }
  });

  test("clipLine 不补齐、不含换行", () => {
    const s = clipLine("第一行\n第二行第二行第二行", 8);
    expect(s).not.toContain("\n");
    expect(stringWidth(s)).toBeLessThanOrEqual(8);
  });

  test("columnWidth 封顶：一条超长值不会把整列推宽", () => {
    expect(columnWidth(["a", "bb", "x".repeat(200)], 20)).toBe(20);
    expect(columnWidth(["a", "bbb"], 20)).toBe(3);
    expect(columnWidth([], 20, 4)).toBe(4);
  });
});

describe("McpDialog 服务器列表", () => {
  const servers = [
    {
      name: "playwright",
      transport: "stdio",
      status: "connected",
      toolCount: 25,
      resourceCount: 0,
      promptCount: 0,
    },
    {
      name: "a-very-long-mcp-server-name-that-goes-on",
      transport: "http",
      status: "failed",
      toolCount: 0,
      resourceCount: 0,
      promptCount: 0,
      error:
        "connect ECONNREFUSED 127.0.0.1:3000\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16) 很长的中文错误说明",
    },
    {
      name: "lark",
      transport: "stdio",
      status: "connected",
      toolCount: 18,
      resourceCount: 2,
      promptCount: 1,
    },
  ] as any[];
  const manager = { getStatus: () => servers } as any;

  for (const width of [80, 120]) {
    test(`宽 ${width}：每台服务器一行，传输列起点一致，无行溢出`, async () => {
      const lines = await frame(<McpDialog onClose={() => {}} mcpManager={manager} />, width);
      const rows = lines.filter((l) => /\((stdio|http)\)/.test(l));
      expect(rows.length).toBe(servers.length);
      const starts = rows.map((l) => stringWidth(l.slice(0, l.search(/\((stdio|http)\)/))));
      expect(new Set(starts).size).toBe(1);
      for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(width);
    });
  }

  test("列宽总和不超过可用宽度", () => {
    const l = computeMcpServerLayout(servers, 100);
    const total = l.nameCol + l.transportCol + l.statusCol + l.countsCol + l.tailCol + 2 * 4;
    expect(total).toBeLessThanOrEqual(100 - 7);
  });
});

describe("HooksDialog 列表", () => {
  const hooks = [
    {
      eventName: "PreToolUse",
      source: "project",
      enabled: true,
      config: { command: "echo ok" },
    },
    {
      eventName: "PostToolUse",
      source: "user",
      enabled: false,
      config: {
        command:
          "bash -c 'for f in $(git diff --name-only); do npx prettier --write \"$f\"; done'\n && echo formatted && 很长的后续命令很长的后续命令",
      },
    },
    {
      eventName: "Stop",
      source: "user",
      enabled: true,
      config: { url: "https://hooks.example.com/notify" },
    },
  ] as any[];
  const hookSystem = { getAllHooks: () => hooks } as any;

  test("每条 hook 一行，事件列起点一致，无行溢出", async () => {
    const width = 90;
    const lines = await frame(<HooksDialog onClose={() => {}} hookSystem={hookSystem} />, width);
    const rows = lines.filter(
      (l) => /(PreToolUse|PostToolUse|Stop)\s/.test(l) && /\[.+级\]/.test(l),
    );
    expect(rows.length).toBe(hooks.length);
    const starts = rows.map((l) =>
      stringWidth(l.slice(0, l.search(/(PreToolUse|PostToolUse|Stop)\s/))),
    );
    expect(new Set(starts).size).toBe(1);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(width);
  });
});

describe("MemoryDialog 名称列", () => {
  test("超长 key 不会让名称列超过行宽一半", () => {
    const w = memoryNameColWidth(["short", "k".repeat(300)], 100);
    expect(w).toBeLessThanOrEqual(Math.floor((100 - 7) * 0.5));
    expect(memoryNameColWidth(["ab", "abcd"], 100)).toBe(4);
  });
});
