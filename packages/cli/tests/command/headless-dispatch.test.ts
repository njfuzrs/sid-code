/**
 * 无头斜杠命令分发（command/headless-dispatch.ts）。
 *
 * 修复前 runHeadless / runHeadlessSDK / runBridge 都把输入直接交给模型：
 * `-p "/plugin market"` 被当成提示词，模型自己去 strings 二进制（实测 110s 未结束）；
 * `-p "/my-skill"` 也不展开，模型能用上只是碰巧认出了名字。
 *
 * 这里锁四件事：
 * 1. 提示词类命令（非 builtin 来源 / 显式 headless:true）走真实 CommandExecutor 并展开；
 * 2. 交互 / 管理类 builtin 拒绝，且指向**真实存在**的 CLI 子命令；
 * 3. 不是命令的输入（路径、--disable-slash-commands）原样提交，不被误拦；
 * 4. 需要人在场的结果（dialog/confirm/clear）报错，不假装成功。
 */

import { describe, test, expect } from "bun:test";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import {
  headlessRefusal,
  mapExecutionResult,
  resolveHeadlessSlash,
  type HeadlessSlashOutcome,
} from "@sid-code/cli/command/headless-dispatch.ts";
import type {
  CommandContext,
  CommandExecutionResult,
  LocalCommandResult,
  UnifiedCommand,
} from "@sid-code/cli/command/types.ts";

const CTX = {} as CommandContext;

function promptCmd(over: { name: string; source?: UnifiedCommand["source"] }): UnifiedCommand {
  return {
    description: "测试 prompt 命令",
    type: "prompt",
    source: "skill",
    getPromptForCommand: async (args: string) => `展开后的提示词 args=${args}`,
    ...over,
  } as unknown as UnifiedCommand;
}

/** local 命令；`result` 是它 call() 的返回值，`onLoad` 用来观测是否被执行 */
function localCmd(
  over: {
    name: string;
    aliases?: string[];
    source?: UnifiedCommand["source"];
    headless?: boolean;
  },
  result: LocalCommandResult = { type: "text", value: "已执行" },
  onLoad?: () => void,
): UnifiedCommand {
  return {
    description: "测试 local 命令",
    source: "builtin",
    ...over,
    type: "local",
    load: async () => {
      onLoad?.();
      return { call: async () => result };
    },
  } as UnifiedCommand;
}

const run = (input: string, commands: UnifiedCommand[], disable = false) =>
  resolveHeadlessSlash(input, {
    commands,
    executor: new CommandExecutor(CTX),
    disableSlashCommands: disable,
  });

describe("提示词类命令：展开后交给模型", () => {
  test("skill 来源的 prompt 命令展开为 submit，displayCommand 是触发命令本身", async () => {
    const r = await run("/my-skill 修一下登录", [promptCmd({ name: "my-skill" })]);
    expect(r).toEqual({
      kind: "submit",
      prompt: "展开后的提示词 args=修一下登录",
      displayCommand: "/my-skill 修一下登录",
    });
  });

  test("自定义命令（legacy 适配的 local，来源 project）返回 submit_prompt → 放行并带 allowed-tools", async () => {
    const custom = localCmd(
      { name: "review-pr", source: "project" },
      {
        type: "submit_prompt",
        prompt: "审查这个 PR",
        allowedTools: ["Read"],
        allowedToolsTrusted: false,
      },
    );
    const r = await run("/review-pr", [custom]);
    expect(r).toEqual({
      kind: "submit",
      prompt: "审查这个 PR",
      displayCommand: "/review-pr",
      allowedTools: ["Read"],
      allowedToolsTrusted: false,
    });
  });

  test("builtin 显式 headless:true（/init）放行", async () => {
    const init = localCmd(
      { name: "init", headless: true },
      { type: "submit_prompt", prompt: "分析代码库" },
    );
    expect((await run("/init", [init])).kind).toBe("submit");
  });

  test("fork 执行的回答（conversational message）作为本轮输出，不再调模型", async () => {
    const forked = localCmd(
      { name: "p:deploy", source: "plugin" },
      { type: "text", value: "子代理的回答", conversational: true },
    );
    const r = await run("/p:deploy", [forked]);
    expect(r).toEqual({ kind: "output", text: "子代理的回答", displayCommand: "/p:deploy" });
  });
});

describe("交互 / 管理类 builtin：拒绝并指向 CLI 子命令", () => {
  test("/plugin market → 拒绝，且命令根本没被执行", async () => {
    let called = false;
    const plugin = localCmd(
      { name: "plugin", aliases: ["plugins"] },
      { type: "text", value: "不该执行" },
      () => {
        called = true;
      },
    );
    const r = await run("/plugin market", [plugin]);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("sid-code plugin");
    expect(called).toBe(false);
  });

  test("别名 /plugins 同样拒绝并给出替代", async () => {
    const r = await run("/plugins install x@m", [
      localCmd({ name: "plugin", aliases: ["plugins"] }),
    ]);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("sid-code plugin");
  });

  test("没有 CLI 替代的 builtin（/model）只说明不可用，不编造子命令", async () => {
    const r = await run("/model opus", [localCmd({ name: "model" })]);
    expect(r.kind).toBe("error");
    const msg = (r as { message: string }).message;
    expect(msg).toContain("无头模式");
    expect(msg).not.toContain("CLI 子命令");
  });

  test("未声明来源按 builtin 处理（fail-closed）", () => {
    const cmd = { ...localCmd({ name: "x" }), source: undefined } as UnifiedCommand;
    expect(headlessRefusal(cmd, "x")).not.toBeNull();
  });

  test("CLI 替代表里的子命令在 bootstrap 快速路径真实存在（防止指向一个不存在的命令）", async () => {
    const src = await Bun.file(
      new URL("../../src/entrypoints/bootstrap.ts", import.meta.url),
    ).text();
    for (const sub of ["plugin", "mcp", "agents", "hooks"]) {
      expect(src).toContain(`args[0] === "${sub}"`);
    }
  });
});

describe("不是命令的输入：原样提交", () => {
  test("普通文本", async () => {
    expect(await run("帮我看看日志", [])).toEqual({ kind: "not_command", input: "帮我看看日志" });
  });

  test("单段真实路径 /tmp 不报未知命令（executor 的 stat 判定）", async () => {
    expect(await run("/tmp", [])).toEqual({ kind: "not_command", input: "/tmp" });
  });

  test("未知命令名报错（不再交给模型去猜）", async () => {
    const r = await run("/definitely-not-a-command-xyz", []);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("未知命令");
  });

  test("--disable-slash-commands：连交互类 builtin 也原样提交（与 TUI 同口径）", async () => {
    const r = await run("/plugin market", [localCmd({ name: "plugin" })], true);
    expect(r).toEqual({ kind: "not_command", input: "/plugin market" });
  });
});

describe("mapExecutionResult：每个结果类型都有确定去向", () => {
  const cases: Array<[CommandExecutionResult, HeadlessSlashOutcome["kind"]]> = [
    [{ type: "submit_prompt", value: "p", shouldQuery: true }, "submit"],
    [{ type: "passthrough", value: "/x" }, "not_command"],
    [{ type: "message", value: "m" }, "output"],
    [{ type: "compact", summary: "s" }, "output"],
    [{ type: "quit" }, "output"],
    [{ type: "skip" }, "output"],
    [{ type: "error", message: "e" }, "error"],
    [{ type: "dialog", dialog: "model" as never }, "error"],
    [{ type: "confirm", message: "c", onConfirm: async () => ({ type: "skip" }) }, "error"],
    [{ type: "clear" }, "error"],
  ];
  for (const [result, kind] of cases) {
    test(`${result.type} → ${kind}`, () => {
      expect(mapExecutionResult(result, "/x").kind).toBe(kind);
    });
  }
});
