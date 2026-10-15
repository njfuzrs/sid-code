/**
 * /plugin 交互面板回归。
 *
 * 修复前：/plugin 无参落到 list 文本，只有 1 个插件时结果 2 行 < PANEL_MIN_LINES，
 * 被路由到状态栏一闪而过，用户看不全也无法管理。
 *
 * 变异自证：
 * - PluginCommand 无参改回走 list → 「无参打开面板」红；
 * - list 去掉 panel 字段 → 「list 强制进面板」红；
 * - DialogSwitch 漏接 "plugins" 分支 → 整帧用例拿不到「插件管理」标题。
 *
 * 落盘隔离：SID_CONFIG_DIR 指 tmpdir（loadAllPlugins 会读 installed.json）。
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderSync } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider, ESC_TIMEOUT } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import {
  PluginsDialog,
  pluginMenuActions,
  pluginDetailLines,
  toPluginRows,
  type PluginRow,
} from "@sid-code/cli/ui/components/PluginsDialog.tsx";
import { PluginCommand } from "@sid-code/cli/command/plugin.ts";
import { setInlinePluginDirs } from "@sid-code/cli/plugin/loader.ts";
import { clearAllPluginCaches } from "@sid-code/cli/plugin/caches.ts";
import type { AppContext } from "@sid-code/cli/command/types.ts";
import type { LoadedPlugin } from "@sid-code/cli/plugin/types.ts";

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
  stdout.columns = 120;
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

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fakePlugin(over: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    name: "feishu-docs",
    manifest: { name: "feishu-docs", version: "1.0.1", description: "读取飞书云文档" },
    path: "/tmp/feishu-docs",
    source: "feishu-docs@company",
    enabled: true,
    isBuiltin: false,
    marketplace: "company",
    commandsPaths: [],
    skillsPaths: ["/tmp/feishu-docs/skills"],
    agentsPaths: [],
    ...over,
  };
}

let prevConfigDir: string | undefined;
let home: string;
let pluginDir: string;

beforeEach(() => {
  prevConfigDir = process.env.SID_CONFIG_DIR;
  home = mkdtempSync(join(tmpdir(), "sid-plugins-dialog-home-"));
  process.env.SID_CONFIG_DIR = home;
  pluginDir = mkdtempSync(join(tmpdir(), "sid-plugins-dialog-p-"));
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "demo-plugin", version: "2.3.4", description: "演示插件描述" }),
  );
  setInlinePluginDirs([pluginDir]);
  clearAllPluginCaches();
});

afterEach(() => {
  setInlinePluginDirs([]);
  clearAllPluginCaches();
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(home, { recursive: true, force: true });
  rmSync(pluginDir, { recursive: true, force: true });
});

describe("/plugin 命令路由", () => {
  test("无参打开 plugins 面板（不再回一段会一闪而过的文本）", async () => {
    const r = await new PluginCommand().execute("", {} as AppContext);
    expect(r).toEqual({ kind: "dialog", dialog: "plugins" });
  });

  test("list 只有一个插件时也强制进面板", async () => {
    const r = await new PluginCommand().execute("list", {} as AppContext);
    expect(r.kind).toBe("message");
    expect(r.message).toContain("demo-plugin@2.3.4");
    expect(r.message!.trimEnd().split("\n").length).toBeLessThan(3); // 低于 PANEL_MIN_LINES
    expect(r.panel).toBeDefined();
  });
});

describe("纯函数口径", () => {
  test("市场插件：详情 / 禁用 / 检查更新 / 卸载", () => {
    const actions = pluginMenuActions({ plugin: fakePlugin(), enabled: true }).map((a) => a.action);
    expect(actions).toEqual(["detail", "disable", "update", "uninstall"]);
  });

  test("已禁用的本地插件：给启用、不给检查更新", () => {
    const row: PluginRow = { plugin: fakePlugin({ marketplace: undefined }), enabled: false };
    expect(pluginMenuActions(row).map((a) => a.action)).toEqual(["detail", "enable", "uninstall"]);
  });

  test("内置插件只能查看详情", () => {
    const row: PluginRow = { plugin: fakePlugin({ isBuiltin: true }), enabled: true };
    expect(pluginMenuActions(row).map((a) => a.action)).toEqual(["detail"]);
  });

  test("启用在前、禁用在后", () => {
    const rows = toPluginRows({
      enabled: [fakePlugin({ name: "a" })],
      disabled: [fakePlugin({ name: "b" })],
      errors: [],
    });
    expect(rows.map((r) => [r.plugin.name, r.enabled])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  test("详情行含来源 / 状态 / 组件", () => {
    const lines = pluginDetailLines({ plugin: fakePlugin(), enabled: true }).join("\n");
    expect(lines).toContain("来源: feishu-docs@company");
    expect(lines).toContain("状态: 已启用");
    expect(lines).toContain("Skill(1 目录)");
  });
});

describe("面板整帧", () => {
  test("列表展示插件，Enter 进菜单，再进详情，Esc 逐级返回并关闭", async () => {
    let closed = false;
    const ui = renderWithKeys(
      <KeypressProvider>
        <PluginsDialog onClose={() => (closed = true)} />
      </KeypressProvider>,
    );
    try {
      await waitFor(() => ui.frame().includes("demo-plugin@2.3.4"));
      const list = ui.frame();
      expect(list).toContain("插件管理");
      expect(list).toContain("demo-plugin@2.3.4");
      expect(list).toContain("演示插件描述");
      expect(list).toContain("已启用");

      await ui.press("\r");
      expect(ui.frame()).toContain("查看详情");

      await ui.press("\r");
      await waitFor(() => ui.frame().includes("路径:"));
      expect(ui.frame()).toContain(`路径: ${pluginDir}`);

      await ui.press("\x1b");
      expect(ui.frame()).toContain("查看详情");
      await ui.press("\x1b");
      expect(ui.frame()).toContain("Enter 管理");
      await ui.press("\x1b");
      expect(closed).toBe(true);
    } finally {
      ui.unmount();
    }
  });
});
