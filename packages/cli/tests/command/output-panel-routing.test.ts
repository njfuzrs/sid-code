/**
 * 命令输出面板的路由口径：哪些结果进面板、哪些留消息流。
 *
 * 锁三件事：
 * 1. resolvePanel 判据——显式 panel 强制进；声明了 outputPanel 且 ≥ PANEL_MIN_LINES 行才进；
 *    一两行的回执/用法错误留消息流（同一命令的报告与回执长度悬殊，按命令一刀切会让回执也要按 Esc）。
 * 2. 子命令继承父命令声明（`/mcp list` 跟随 `/mcp`），且可单独声明 false 关掉。
 * 3. 真实内置命令表：该进面板的都声明了，作用于对话本身的都没声明（防回归时漏标/误标）。
 */

import { describe, test, expect } from "bun:test";
import { CommandExecutor, resolvePanel } from "@sid-code/cli/command/executor.ts";
import { adaptLegacyCommand, convertResult } from "@sid-code/cli/command/adapter.ts";
import { loadBuiltinCommands } from "@sid-code/cli/command/loaders.ts";
import { PANEL_MIN_LINES } from "@sid-code/core/command-contract/types.ts";
import type { UnifiedCommand, CommandContext } from "@sid-code/cli/command/types.ts";

const CTX = {} as CommandContext;
const REPORT = ["标题", "第二行", "第三行", "第四行"].join("\n");

function textCmd(name: string, value: string, over: Partial<UnifiedCommand> = {}): UnifiedCommand {
  return {
    name,
    description: "测试",
    type: "local",
    load: async () => ({ call: async () => ({ type: "text", value }) }),
    ...over,
  } as UnifiedCommand;
}

describe("resolvePanel 判据", () => {
  test("未声明 → 不进面板，无论多长", () => {
    expect(resolvePanel(REPORT, undefined, undefined)).toBeUndefined();
  });

  test("声明了 + 足够长 → 进面板；true 归一为空 spec", () => {
    expect(resolvePanel(REPORT, undefined, true)).toEqual({});
    expect(resolvePanel(REPORT, undefined, { title: "体检" })).toEqual({ title: "体检" });
  });

  test("声明了但短于 PANEL_MIN_LINES 行 → 留消息流（回执、用法错误）", () => {
    const short = Array.from({ length: PANEL_MIN_LINES - 1 }, (_, i) => `行${i}`).join("\n");
    expect(resolvePanel(short, undefined, true)).toBeUndefined();
    expect(resolvePanel("已删除任务 abc", undefined, true)).toBeUndefined();
  });

  test("尾部空行不计入行数（命令常以 \\n 结尾）", () => {
    expect(resolvePanel("一\n二\n\n\n", undefined, true)).toBeUndefined();
  });

  test("结果显式带 panel → 强制进，不受行数约束、不需要命令声明", () => {
    expect(resolvePanel("一行", { title: "x" }, undefined)).toEqual({ title: "x" });
  });

  test("空输出 → 不进面板", () => {
    expect(resolvePanel("", undefined, true)).toBeUndefined();
  });
});

describe("CommandExecutor 路由", () => {
  test("声明 outputPanel 的命令，长结果带 panel 返回", async () => {
    const ex = new CommandExecutor(CTX);
    const r = await ex.executeSlashCommand("/doc", [textCmd("doc", REPORT, { outputPanel: true })]);
    expect(r).toEqual({ type: "message", value: REPORT, panel: {} });
  });

  test("未声明的命令照旧走消息流（不带 panel 字段）", async () => {
    const ex = new CommandExecutor(CTX);
    const r = await ex.executeSlashCommand("/doc", [textCmd("doc", REPORT)]);
    expect(r).toEqual({ type: "message", value: REPORT });
  });

  test("子命令继承父命令声明：/parent list 进面板", async () => {
    const parent = textCmd("parent", REPORT, {
      outputPanel: true,
      subCommands: () => [textCmd("list", REPORT)],
    });
    const ex = new CommandExecutor(CTX);
    expect(ex.resolveOutputPanel("parent list", [parent])).toBe(true);
    const r = await ex.executeSlashCommand("/parent list", [parent]);
    expect((r as { panel?: unknown }).panel).toEqual({});
  });

  test("子命令可单独声明 false 关掉继承", () => {
    const parent = textCmd("parent", REPORT, {
      outputPanel: true,
      subCommands: () => [textCmd("add", REPORT, { outputPanel: false })],
    });
    expect(new CommandExecutor(CTX).resolveOutputPanel("parent add", [parent])).toBe(false);
  });

  test("按别名查找也能拿到声明", () => {
    const cmd = textCmd("doctor", REPORT, { outputPanel: true, aliases: ["checkup"] });
    expect(new CommandExecutor(CTX).resolveOutputPanel("checkup", [cmd])).toBe(true);
  });

  test("executeImmediate 与 executeSlashCommand 口径一致", async () => {
    const cmd = textCmd("doc", REPORT, { outputPanel: true });
    const r = await new CommandExecutor(CTX).executeImmediate(cmd, "");
    expect((r as { panel?: unknown }).panel).toEqual({});
  });
});

describe("legacy 适配器透传", () => {
  test("gates.outputPanel 透传到适配产物", () => {
    const legacy = {
      name: () => "cost",
      aliases: () => [],
      description: () => "",
      execute: async () => ({ kind: "message" as const, message: REPORT }),
    };
    expect(adaptLegacyCommand(legacy, "builtin", { outputPanel: true }).outputPanel).toBe(true);
  });

  test("旧结果上的 panel 字段不丢", () => {
    expect(convertResult({ kind: "message", message: "x", panel: { title: "t" } })).toEqual({
      type: "text",
      value: "x",
      panel: { title: "t" },
    });
  });
});

describe("真实内置命令表的声明", () => {
  // 测试按名字写死期望（同 loaders.ts 注释：不复用表本身，否则漏字段与漏透传会一起变绿）
  const SHOULD_PANEL = [
    "doctor",
    "status",
    "debug",
    "insights",
    "workflows",
    "keybindings",
    "todos",
    "conflict",
    "terminal-setup",
    "diff",
    "bug",
    "claude-api",
    "model",
    "statusline",
    "help",
    "config",
    "cost",
    "stats",
    "cache",
    "trace",
    "telemetry",
    "checkpoints",
    "memory",
    "hooks",
    "undo",
    "restore",
    "mcp",
    "ide",
    "lsp",
    "skills",
    "agents",
    "commands",
    "plugin",
    "reload-plugins",
    "permissions",
    "ps",
    "worktree",
    "cron",
  ];
  // 作用于对话本身、或只有单行回执的命令：进面板反而多按一次 Esc
  const SHOULD_NOT_PANEL = [
    "compact",
    "clear",
    "rewind",
    "plan",
    "init",
    "btw",
    "loop",
    "goal",
    "exit",
    "allow",
    "deny",
    "add-dir",
    "theme",
    "language",
    "vim",
    "fast",
    "rename",
    "color",
    "copy",
  ];

  test("该进面板的都声明了", async () => {
    const byName = new Map((await loadBuiltinCommands()).map((c) => [c.name, c]));
    const missing = SHOULD_PANEL.filter((n) => byName.has(n) && !byName.get(n)!.outputPanel);
    expect(missing).toEqual([]);
    // 名单里的命令都真实存在（防止改名后这条测试空转）
    expect(SHOULD_PANEL.filter((n) => !byName.has(n))).toEqual([]);
  });

  test("作用于对话 / 单行回执的命令没声明", async () => {
    const byName = new Map((await loadBuiltinCommands()).map((c) => [c.name, c]));
    const wrong = SHOULD_NOT_PANEL.filter((n) => byName.get(n)?.outputPanel);
    expect(wrong).toEqual([]);
  });
});
