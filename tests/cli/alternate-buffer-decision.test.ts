/**
 * alternateBuffer 判定可观测性测试
 *
 * 背景（2026-08-04 排查教训，见 resolveAlternateBufferDecision 的注释）：
 * 原实现是内联四层三元表达式，只算值不留依据。排查 TUI 刷屏问题时，同事确认
 * "我用的就是 Terminal.app"（按预期该自动回退主屏），但依然复现报错——而当时
 * **没有任何手段验证这次判定的实际结果和依据**（TERM_PROGRAM 会被 tmux/screen
 * 改写或清空，--alternate-buffer 可能藏在 alias 里）。整轮排查因此建立在未经
 * 验证的前提上。
 *
 * 本测试锁两件事：① 优先级不被改坏；② 每条分支都给出非空 reason（可观测性本身）。
 */

import { describe, test, expect } from "bun:test";
import { resolveAlternateBufferDecision } from "@sid-code/cli/cli.ts";

describe("resolveAlternateBufferDecision", () => {
  test("--inline 优先级最高，压过 --alternate-buffer 与 TERM_PROGRAM", () => {
    const d = resolveAlternateBufferDecision({
      inline: true,
      alternateBufferFlag: true,
      termProgram: "iTerm.app",
    });
    expect(d.value).toBe(false);
    expect(d.reason).toContain("--inline");
  });

  test("--alternate-buffer 显式覆盖 Apple_Terminal 自动回退", () => {
    const d = resolveAlternateBufferDecision({
      inline: false,
      alternateBufferFlag: true,
      termProgram: "Apple_Terminal",
    });
    expect(d.value).toBe(true);
    expect(d.reason).toContain("--alternate-buffer");
  });

  test("Apple_Terminal 自动回退主屏模式", () => {
    const d = resolveAlternateBufferDecision({
      inline: false,
      alternateBufferFlag: false,
      termProgram: "Apple_Terminal",
    });
    expect(d.value).toBe(false);
    expect(d.reason).toContain("Apple_Terminal");
  });

  test("其它终端不覆盖，交给 config 默认值", () => {
    for (const term of ["iTerm.app", "vscode", "WezTerm", undefined]) {
      const d = resolveAlternateBufferDecision({
        inline: false,
        alternateBufferFlag: false,
        termProgram: term,
      });
      expect(d.value).toBeUndefined();
      expect(d.reason).toContain("配置默认值");
    }
  });

  test("TERM_PROGRAM 严格相等匹配：大小写/子串都不触发回退", () => {
    // 曾被怀疑过的场景：tmux 下 TERM_PROGRAM 被改写成别的值 → 不该回退
    for (const term of ["apple_terminal", "Apple_Terminal_X", "tmux", ""]) {
      const d = resolveAlternateBufferDecision({
        inline: false,
        alternateBufferFlag: false,
        termProgram: term,
      });
      expect(d.value).toBeUndefined();
    }
  });

  test("每条分支都给出非空 reason（可观测性本身就是被测对象）", () => {
    const cases = [
      { inline: true, alternateBufferFlag: false, termProgram: undefined },
      { inline: false, alternateBufferFlag: true, termProgram: undefined },
      { inline: false, alternateBufferFlag: false, termProgram: "Apple_Terminal" },
      { inline: false, alternateBufferFlag: false, termProgram: "iTerm.app" },
    ];
    for (const c of cases) {
      const d = resolveAlternateBufferDecision(c);
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  test("未设置 TERM_PROGRAM 时 reason 里明示，不显示 undefined", () => {
    const d = resolveAlternateBufferDecision({
      inline: false,
      alternateBufferFlag: false,
      termProgram: undefined,
    });
    expect(d.reason).toContain("<未设置>");
    expect(d.reason).not.toContain("undefined");
  });
});
