/**
 * M2 / M3 面板整帧回归：
 * - /mcp 面板选「禁用」后，该行状态不再是 ✔、菜单翻成「启用」、manager 真的注销了工具；
 * - 有待审批项目 server 时启动审批框逐个展示，选择结果走 approval.ts。
 *
 * 变异自证：McpDialog 的 disable 分支改回只写 sessionState（不调 toggleMcpServer）→
 * 「面板禁用」组红（菜单仍是「禁用」，工具仍在）。
 *
 * 按键手法沿用 HotkeyChoiceList.test.tsx：自建 stdin emit 字符串，走 KeypressProvider 完整解析链。
 * 落盘隔离：SID_CONFIG_DIR 指 tmpdir。
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import { McpDialog } from "@sid-code/cli/ui/components/McpDialog.tsx";
import { McpApprovalQueue } from "@sid-code/cli/ui/components/McpApprovalDialog.tsx";
import { ARROW_PROMPT } from "@sid-code/cli/ui/constants/figures.ts";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import { MCPConnectionStatus } from "@sid-code/core/mcp/types.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function extractLastFrame(output: string): string {
  const lastStart = output.lastIndexOf(SYNC_START);
  if (lastStart === -1) return output;
  const contentStart = lastStart + SYNC_START.length;
  const endIndex = output.indexOf(SYNC_END, contentStart);
  return endIndex === -1 ? output.slice(contentStart) : output.slice(contentStart, endIndex);
}

function renderWithKeys(node: React.ReactElement) {
  let output = "";
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
  };
  stdout.columns = 100;
  stdout.rows = 30;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdinAny = stdin as unknown as Record<string, unknown>;
  stdinAny.isTTY = true;
  stdinAny.setRawMode = () => stdin;
  stdinAny.setEncoding = () => stdin;
  stdinAny.ref = () => stdin;
  stdinAny.unref = () => stdin;
  const instance = renderSync(node, { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  return {
    frame: () => stripAnsi(extractLastFrame(output)),
    press: async (seq: string, waitMs = ESC_TIMEOUT * 2) => {
      stdin.emit("data", seq);
      await new Promise((r) => setTimeout(r, waitMs));
    },
    unmount: () => instance.unmount(),
  };
}

const KEY = { down: "\x1b[B", enter: "\r" } as const;

/**
 * 轮询到条件成立 / 超时。
 *
 * 为什么不能「press 完固定 sleep 再断言」：`press` 的默认等待是 `ESC_TIMEOUT * 2` = 100ms
 * （`KeypressContext` 判定裸 ESC 的窗口），而 macOS 共享 runner 上一次 event loop 抢占
 * 就能吃掉这个量级。2026-11-10 PR #725 实测到的形态正是如此 —— `KEY.down` 没被处理完，
 * 紧随的 `KEY.enter` 命中了第一项「重新连接」，失败帧里多出一行「重连成功，注册 1 个工具」。
 * 判据从「等多久」改成「等到什么」，与 done/20261107 对 PluginsDialog /
 * layout-bottom-region-snapshot 的改法同源。
 */
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

let ROOT: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "sid-mcp-dialog-"));
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = join(ROOT, "cfg");
  mkdirSync(process.env.SID_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("M2 /mcp 面板禁用当场生效", () => {
  test("选「禁用」后状态非 ✔、菜单翻成「启用」、工具被注销", async () => {
    const mgr = new MCPManager();
    const registry = new Map<string, string[]>();
    (mgr as any).connectWithTimeout = async (name: string) => [{ name: `mcp__${name}__echo` }];
    mgr.onToolsRefresh = (name, tools) => {
      registry.set(
        name,
        tools.map((t: any) => t.name),
      );
    };
    await mgr.addServer("playwright", { transport: "stdio", command: "x" } as MCPServerConfig);
    expect(registry.get("playwright")).toEqual(["mcp__playwright__echo"]);

    const r = renderWithKeys(
      <KeypressProvider>
        <McpDialog onClose={() => {}} mcpManager={mgr} />
      </KeypressProvider>,
    );
    await r.press(""); // 等首帧
    expect(r.frame()).toContain("playwright");
    await r.press(KEY.enter); // 进入 server 菜单
    expect(r.frame()).toContain("禁用");
    // 菜单：重新连接 / 禁用（toolCount 0 时无「查看工具」）
    //
    // ⚠️ 不要改回「down 之后固定 sleep 再 enter」：down 与 enter 之间存在竞态 ——
    // down 没被消费完时，紧随的 enter 会命中**第一项「重新连接」**，于是失败帧里
    // 多出一行「重连成功，注册 1 个工具」（2026-11-10 PR #725 在 macOS 上实测）。
    // 判据从「等够多久」换成「等到光标真的落在禁用项上」：选中标记 ARROW_PROMPT
    // 只在焦点项前渲染，未选中项是等宽空白。
    await r.press(KEY.down);
    const focusedDisable = await waitFor(() =>
      new RegExp(`${ARROW_PROMPT}\\s*禁用`).test(r.frame()),
    );
    expect(
      focusedDisable,
      `按下 down 后光标应停在「禁用」项（选中标记 ${ARROW_PROMPT}）；实际帧：\n${r.frame()}`,
    ).toBe(true);
    await r.press(KEY.enter, 0);
    const menuFlipped = await waitFor(() => r.frame().includes("启用"));
    expect(menuFlipped, `选中「禁用」后菜单应翻成「启用」；实际帧：\n${r.frame()}`).toBe(true);

    const frame = r.frame();
    expect(frame).toContain("启用");
    expect(frame).not.toContain("✔");
    expect(registry.get("playwright")).toEqual([]);
    expect(mgr.getStatus().find((s) => s.name === "playwright")?.status).toBe(
      MCPConnectionStatus.DISABLED,
    );
    r.unmount();
    mgr.closeAll();
  });
});

describe("M3 启动审批框", () => {
  test("逐个展示，默认聚焦「拒绝」；批准第一个后展示第二个", async () => {
    const decisions: Array<[string, string]> = [];
    let done = false;
    const r = renderWithKeys(
      <KeypressProvider>
        <McpApprovalQueue
          pending={[
            { name: "tavily", target: "npx tavily" },
            { name: "mastergo", target: "npx mastergo" },
          ]}
          onDecision={(n, c) => {
            decisions.push([n, c]);
          }}
          onDone={() => {
            done = true;
          }}
        />
      </KeypressProvider>,
    );
    await r.press("");
    expect(r.frame()).toContain("tavily");
    expect(r.frame()).toContain("还有 1 个待审批");
    // 默认聚焦在「拒绝」（第三项），↑↑ 到「批准」
    await r.press("\x1b[A");
    await r.press("\x1b[A");
    await r.press(KEY.enter);
    expect(decisions).toEqual([["tavily", "approve"]]);
    expect(r.frame()).toContain("mastergo");
    // 直接回车 = 默认的「拒绝」
    await r.press(KEY.enter);
    expect(decisions[1]).toEqual(["mastergo", "reject"]);
    expect(done).toBe(true);
    r.unmount();
  });
});
