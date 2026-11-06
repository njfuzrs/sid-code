/**
 * `LocalCommandResult.error` 分支（缺陷 D2）：命令失败必须能被无头识别为非 0。
 *
 * ## 修复前
 *
 * `LocalCommandResult` 联合类型里**没有 `error`**，`errorText()` 只好把失败包装成
 * `{ type: "text", value: "错误: …" }`。于是无头下走 `mapExecutionResult` 的 `message`
 * 分支 → `output` → 退出码 **0**。CI 无法用退出码区分成功与失败，只能 parse stdout 文案。
 *
 * ## 修复后的两条不变量（本文件锁它们）
 *
 * 1. **文本逐字一致**：`error.message` 是完整展示文本，含「错误: 」前缀。TUI 与无头
 *    两侧都直接输出它、不再二次加前缀——否则 TUI 会出现「错误: 错误: …」。
 * 2. **前缀只在一个地方加**：命令侧 `errorText()`、执行引擎侧 `commandError()`。
 *    消费方（`app.ts` / `headless-dispatch.ts`）只透传。这条用静态断言防漂移：
 *    它俩一旦有人「顺手补个前缀」，红的是这里，而不是用户屏幕上的双前缀。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import { resolveHeadlessSlash } from "@sid-code/cli/command/headless-dispatch.ts";
import { errorText } from "@sid-code/cli/command/result.ts";
import type {
  CommandContext,
  CommandExecutionResult,
  LocalCommandResult,
  UnifiedCommand,
} from "@sid-code/cli/command/types.ts";

const CTX = {} as CommandContext;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(REPO, rel), "utf-8");
}

/** 剥注释：注释里合法地写着「错误: 」前缀，直接扫原文会把说明当成代码 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 无头放行的 local 命令；`result` 是它 call() 的返回值 */
function localCmd(name: string, result: LocalCommandResult, headless = true): UnifiedCommand {
  return {
    name,
    description: "测试命令",
    source: "builtin",
    headless,
    type: "local",
    load: async () => ({ call: async () => result }),
  } as unknown as UnifiedCommand;
}

describe("errorText()：失败结果的唯一构造口径", () => {
  test("返回 error 分支，文本与收口前逐字一致（含「错误: 」前缀）", () => {
    expect(errorText("参数错")).toEqual({ type: "error", message: "错误: 参数错" });
  });

  test("message 为 undefined 时只留前缀，不退化成「错误: undefined」", () => {
    expect(errorText(undefined)).toEqual({ type: "error", message: "错误: " });
  });
});

describe("executor：LocalCommandResult.error → CommandExecutionResult.error", () => {
  test("message 原样透传，不二次加前缀（否则 TUI 会出现「错误: 错误: …」）", async () => {
    const r = await new CommandExecutor(CTX).executeSlashCommand("/boom", [
      localCmd("boom", errorText("炸了")),
    ]);
    expect(r).toEqual({ type: "error", message: "错误: 炸了" });
  });

  test("confirm 的 onConfirm 递归走同一套映射：确认后的失败也是 error", async () => {
    const cmd = localCmd("ask", {
      type: "confirm",
      message: "确定？",
      onConfirm: async () => errorText("确认后失败"),
    });
    const r = await new CommandExecutor(CTX).executeSlashCommand("/ask", [cmd]);
    expect(r.type).toBe("confirm");
    const onConfirm = (r as { onConfirm: () => Promise<CommandExecutionResult> }).onConfirm;
    expect(await onConfirm()).toEqual({ type: "error", message: "错误: 确认后失败" });
  });

  test("执行引擎自身的失败（未知命令）也是完整展示文本，与 TUI 同口径", async () => {
    const r = await new CommandExecutor(CTX).executeSlashCommand("/xyzabc-not-real", []);
    expect(r.type).toBe("error");
    expect((r as { message: string }).message).toStartWith("错误: ");
    expect((r as { message: string }).message).toContain("未知命令");
  });
});

describe("无头：error 结果翻成 kind:error（退出码非 0 的唯一来源）", () => {
  test("放行的内置命令返回 errorText → kind:error，文本带前缀、无双前缀", async () => {
    const r = await resolveHeadlessSlash("/boom", {
      commands: [localCmd("boom", errorText("炸了"))],
      executor: new CommandExecutor(CTX),
    });
    expect(r).toEqual({ kind: "error", message: "错误: 炸了" });
  });

  test("对照：成功的文本结果仍是 output，不会被误判成失败", async () => {
    const r = await resolveHeadlessSlash("/ok", {
      commands: [localCmd("ok", { type: "text", value: "好了" })],
      executor: new CommandExecutor(CTX),
    });
    expect(r).toEqual({ kind: "output", text: "好了", displayCommand: "/ok" });
  });
});

describe("反漂移：前缀只在一个地方加", () => {
  test("app.ts 的 TUI error 分支直接展示 message，不二次拼「错误: 」", () => {
    const src = stripComments(readSrc("packages/cli/src/app.ts"));
    // 修复前这里是 `错误: ${result.message ?? ""}`；双前缀正是这样产生的
    expect(src).not.toContain("`错误: ${result.message");
    expect(src).toContain(
      'presentCommandResult(commandInput, result.message ?? "", { isError: true })',
    );
  });

  test("plugin-cli 按结果类型判错，不再 parse「错误: 」文本前缀", () => {
    const src = stripComments(readSrc("packages/cli/src/command/plugin-cli.ts"));
    expect(src).not.toContain('startsWith("错误: ")');
    expect(src).toContain('const isError = result.type === "error"');
  });
});
