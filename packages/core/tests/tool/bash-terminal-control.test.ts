/**
 * bash 输出剥离终端控制序列（20261020 会话评估发现 12）
 *
 * 样本形态取自被评会话 `affected-tests:run` 的真实输出：bracketed paste（`ESC[?2004h/l`）、
 * OSC 9;4 进度、SGR 颜色、DCS。剥离后 22,548 → 7,630 字符。
 */
import { describe, it, expect } from "bun:test";
import { stripTerminalControl } from "@sid-code/core/tool/bash/terminal-control.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";

const E = "\x1b";

describe("stripTerminalControl", () => {
  it.each([
    ["SGR 颜色", `${E}[32m✓ pass${E}[0m`, "✓ pass"],
    ["私有模式 bracketed paste", `${E}[?2004hready${E}[?2004l`, "ready"],
    ["OSC 9;4 进度（BEL 结尾）", `a${E}]9;4;1;50\x07b`, "ab"],
    ["OSC 标题（ST 结尾）", `a${E}]0;title${E}\\b`, "ab"],
    ["DCS", `a${E}Pq#0;2;0;0;0${E}\\b`, "ab"],
    ["光标移动与清行", `a${E}[2K${E}[1Gb`, "ab"],
    ["两字符转义 ESC 7 / ESC 8", `${E}7a${E}8`, "a"],
  ])("%s", (_name, input, want) => {
    expect(stripTerminalControl(input)).toBe(want);
  });

  it("文本里的 \\r \\t \\n 不动", () => {
    expect(stripTerminalControl(`a\tb\r\nc${E}[0m`)).toBe("a\tb\r\nc");
  });

  it("不完整序列与孤立 ESC 原样保留（不吞后续内容）", () => {
    expect(stripTerminalControl(`a${E}[`)).toBe(`a${E}[`);
    expect(stripTerminalControl(`a${E}]9;4 未终止 后面还有字`)).toBe(`a${E}]9;4 未终止 后面还有字`);
  });

  it("不含 ESC 时原样返回同一个字符串", () => {
    const s = "plain text";
    expect(stripTerminalControl(s)).toBe(s);
  });
});

describe("bash 工具输出接线", () => {
  it("命令输出里的控制序列在 tool_result 中被剥掉", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    const r = await bash.execute({
      command: `printf '\\033[?2004h\\033]9;4;1;50\\007\\033[32mok\\033[0m\\n'`,
      description: "输出带控制序列的文本",
    });
    expect(r.isError).toBeFalsy();
    expect(String(r.output)).not.toContain(E);
    expect(String(r.output)).toContain("ok");
  });

  it("只有控制序列的输出剥完后回落为「(命令无输出)」而不是空串", async () => {
    if (process.platform === "win32") return;
    const bash = new BashTool();
    const r = await bash.execute({
      command: `printf '\\033[?2004h'`,
      description: "只输出控制序列",
    });
    expect(String(r.output)).toBe("(命令无输出)");
  });
});
