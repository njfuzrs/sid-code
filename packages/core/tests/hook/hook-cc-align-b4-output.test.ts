/**
 * Hook 对齐 CC · 批 4：输出语义（HC16 / HC17 / HC18）
 *
 * - SessionStart / UserPromptSubmit 的 exit 0 纯文本 stdout 进上下文（HC16）
 * - 上下文作为独立 <system-reminder> 块，不拼进用户原文、不触发 thinking 关键词（HC17）
 * - 超长截断 + 转存
 * - PostToolUse exit 2 / decision:block 的反馈回灌（HC18）
 * HC19（退出码 / JSON 优先级）已在 9-27 P1 批落地，由 hook-p1-* 锁住，这里不重复。
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as readSrc } from "node:fs";
import { HookRunner, promotePlainStdoutToContext } from "@sid-code/core/hook/runner.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName, ConfigSource } from "@sid-code/core/hook/types.ts";
import {
  formatHookContextReminder,
  extractHookContext,
  HOOK_CONTEXT_MAX_CHARS,
} from "@sid-code/core/hook/context-inject.ts";
import { hookFeedbackText } from "@sid-code/core/query/tool-executor.ts";

const root = mkdtempSync(join(tmpdir(), "sid-b4-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sysWith(event: string, command: string): HookSystem {
  const sys = new HookSystem();
  sys.initializeFromSources([
    { hooks: { [event]: [{ hooks: [{ type: "command", command }] }] }, source: ConfigSource.User },
  ]);
  sys.setSessionId("s");
  return sys;
}

describe("HC16 纯文本 stdout 进上下文", () => {
  test("UserPromptSubmit：exit 0 文本 → additionalContext", async () => {
    const r = await sysWith("UserPromptSubmit", "echo 暗号-42").fireUserPromptSubmitEvent("hi");
    expect(extractHookContext(r)).toBe("暗号-42");
  });

  test("SessionStart：exit 0 文本 → additionalContext", async () => {
    const r = await sysWith("SessionStart", "echo 分支 main").fireSessionStartEvent("startup");
    expect(extractHookContext(r)).toBe("分支 main");
  });

  test("其他事件不搬（PreToolUse 的 stdout 不是上下文）", () => {
    const out = promotePlainStdoutToContext(
      { systemMessage: "x" },
      HookEventName.PreToolUse,
      0,
      "x",
    );
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  test("非 0 退出 / JSON 输出不搬", () => {
    expect(
      promotePlainStdoutToContext({}, HookEventName.UserPromptSubmit, 1, "warn").hookSpecificOutput,
    ).toBeUndefined();
    expect(
      promotePlainStdoutToContext({}, HookEventName.UserPromptSubmit, 0, '{"a":1}')
        .hookSpecificOutput,
    ).toBeUndefined();
  });

  test("JSON additionalContext 照常可用", async () => {
    const json = JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "来自 JSON" },
    });
    const r = await sysWith("UserPromptSubmit", `printf '%s' '${json}'`).fireUserPromptSubmitEvent(
      "hi",
    );
    expect(extractHookContext(r)).toBe("来自 JSON");
  });
});

describe("HC17 独立块注入", () => {
  test("格式：<system-reminder> 围栏、标明来源事件", () => {
    const t = formatHookContextReminder("UserPromptSubmit", "内容");
    expect(t.startsWith("<system-reminder>")).toBe(true);
    expect(t.endsWith("</system-reminder>")).toBe(true);
    expect(t).toContain("UserPromptSubmit hook");
  });

  test("超长：保留 2000 字符预览，全文转存", () => {
    const dir = join(root, "overflow");
    const long = "x".repeat(HOOK_CONTEXT_MAX_CHARS + 1);
    const t = formatHookContextReminder("SessionStart", long, dir);
    expect(t.length).toBeLessThan(3000);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(readFileSync(join(dir, files[0]!), "utf8")).toBe(long);
  });

  test("结构性：engine 不再把 hook 上下文拼进 userInput，thinking hint 只解析原文", () => {
    const src = readSrc(join(import.meta.dir, "../../src/query/engine.ts"), "utf8");
    expect(src).not.toMatch(/userInput \+ "\\n\\n" \+ additionalCtx/);
    expect(src).toMatch(/const finalInput = userInput;/);
    expect(src).toContain("hookReminders.map");
  });

  test("结构性：app 层 await SessionStart 并把上下文交给 engine", () => {
    const src = readSrc(join(import.meta.dir, "../../../cli/src/app.ts"), "utf8");
    expect(src).toMatch(/await this\.hookSystem\.fireSessionStartEvent\(/);
    expect(src).toContain("setPendingSessionStartContext(extractHookContext(startResult))");
  });
});

describe("HC18 PostToolUse 反馈回灌", () => {
  test("exit 2 的 stderr 作为反馈", async () => {
    const sys = sysWith("PostToolUse", "echo 'lint 失败: 缺分号' >&2; exit 2");
    const r = await sys.firePostToolUseEvent("edit", {}, { output: "ok" }, false);
    expect(hookFeedbackText(r)).toBe("lint 失败: 缺分号");
  });

  test('JSON decision:"block" 的 reason 作为反馈', async () => {
    const json = JSON.stringify({ decision: "block", reason: "格式不对" });
    const sys = sysWith("PostToolUse", `printf '%s' '${json}'`);
    const r = await sys.firePostToolUseEvent("edit", {}, { output: "ok" }, false);
    expect(hookFeedbackText(r)).toBe("格式不对");
  });

  test("exit 0 / exit 1 不产生反馈", async () => {
    for (const cmd of ["echo ok", "echo warn >&2; exit 1"]) {
      const r = await sysWith("PostToolUse", cmd).firePostToolUseEvent("edit", {}, {}, false);
      expect(hookFeedbackText(r)).toBeUndefined();
    }
  });

  test("PostToolUseFailure 同样能拿到反馈（改为 await 之后）", async () => {
    const sys = sysWith("PostToolUseFailure", "echo '请先 read' >&2; exit 2");
    const r = await sys.firePostToolUseFailureEvent("read", {}, "ENOENT");
    expect(hookFeedbackText(r)).toBe("请先 read");
  });
});

// 保证 runner 未被意外改坏：普通 command hook 仍能执行
test("冒烟：runner 正常执行", async () => {
  const r = await new HookRunner().executeHook(
    { type: "command", command: "echo hi" },
    HookEventName.PostToolUse,
    { session_id: "s", cwd: root, hook_event_name: "PostToolUse", timestamp: "" } as any,
  );
  expect(r.exitCode).toBe(0);
});
