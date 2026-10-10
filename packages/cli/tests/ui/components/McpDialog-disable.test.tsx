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
    await r.press(KEY.down);
    await r.press(KEY.enter, 400);

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
