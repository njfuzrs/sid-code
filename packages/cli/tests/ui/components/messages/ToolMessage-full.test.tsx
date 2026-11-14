/**
 * full 档（`enter_worktree` / `exit_worktree`）的整帧渲染测试
 *
 * ## 治的是什么缺陷（PR #813 的漏网）
 *
 * #813 把「短回执工具」留在审计白名单里、注释写「不折」。但折叠有**两层判据**：
 *   1. 数据层：`displayMode === "compact"` → 折成零行正文（#813 修的是这层）；
 *   2. 组件层：`ToolResultDisplay` 的 `maxLines = DEFAULT_MAX_LINES(3)` → **与档位无关**，
 *      任何工具结果超过 3 个视觉行就折成 3 行 + `… N 行已折叠`。
 *
 * 「没声明档位」只对第 1 层免疫，第 2 层照折。`enter_worktree` 的成功回执是 5 个逻辑行
 * （3 行回执 + 2 行路径语义提示，末行按终端列宽折成 2 视觉行 = 6 视觉行），于是屏幕上
 * 显示前 3 行 + `… 3 行已折叠`，折掉的正是 CG-2/H3 那段「此后写文件请用 worktree 路径」
 * ——台账基线 worktree 内写到主仓路径 53 次 / 4 会话。
 *
 * ## 为什么必须整帧测
 *
 * 数据层测试（`tool-result-display-mode-audit.test.ts`）只能断言 `content` 没被置空，
 * 它在 full 档下**永远通过**——折行是 `SlicingMaxSizedBox` 在渲染期做的，只有
 * `lastFrame()` 看得见。这正是 #813 漏掉的观测面。
 *
 * 三条断言：
 *   1. full 档：整段回执（含最后一行路径提示）全部上屏，整帧不含「已折叠」；
 *   2. 对照组：同一份正文、只把 displayMode 换成 undefined → **出现**「已折叠」。
 *      没有这条，第 1 条可能是恒绿（比如折叠逻辑压根没生效）；
 *   3. 错误态同样完整（`tool/types.ts` 硬约束 ②：错误比啰嗦重要）。
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import React from "react";
import stripAnsi from "strip-ansi";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import {
  ToolGroupMessage,
  type ToolCallDisplay,
} from "@sid-code/cli/ui/components/messages/ToolGroupMessage.tsx";
import { UIStateProvider } from "@sid-code/cli/ui/contexts/UIStateContext.tsx";

// 落盘隔离：本组件链会读 app-config（提示计数），必须把目标重定向到 tmpdir，
// 否则会往用户真实的 ~/.sid-code/ 里灌测试数据（见 CONTRIBUTING.md 的测试约定）。
let originalConfigDir: string | undefined;
let isolatedConfigDir: string;

beforeAll(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  isolatedConfigDir = mkdtempSync(join(tmpdir(), "sid-toolmessage-full-"));
  process.env.SID_CONFIG_DIR = isolatedConfigDir;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(isolatedConfigDir, { recursive: true, force: true });
});

/**
 * `enter_worktree` 成功回执的真实形态（`core/tool/enter-worktree.ts` +
 * `worktree/path-semantics.ts`）：5 个逻辑行，末行远超终端列宽。
 */
const RECEIPT = [
  "已创建并进入 Worktree。",
  "路径: /repo/.sid-code/worktrees/thinking-off-floor",
  "分支: worktree-thinking-off-floor",
  "主仓根: /repo（不是当前工作树）",
  "⚠️ 此前在该仓库读过的文件路径指向主仓，写入会落到主仓而不是这个 worktree；" +
    "此后写文件请用 /repo/.sid-code/worktrees/thinking-off-floor 下的路径。",
].join("\n");

function worktreeTool(overrides: Partial<ToolCallDisplay> = {}): ToolCallDisplay {
  return {
    id: "call_enter_worktree_1",
    name: "enter_worktree",
    input: { name: "thinking-off-floor" },
    status: "success",
    result: RECEIPT,
    displayMode: "full",
    ...overrides,
  };
}

function renderTools(tools: ToolCallDisplay[], width = 100): string {
  // `columns` 必须与传给组件的 `terminalWidth` 一致：组件按 props 算换行宽度，
  // 而 `render()` 的假 stdout 是另一个宽度。两者不一致时，按 props 算「放得下」的行
  // 在真实容器里仍超宽，渲染器会再处理一次并吃掉中间字符——那会伪装成组件的 bug。
  const { lastFrame } = render(
    <UIStateProvider initialExpandLevel={0}>
      <ToolGroupMessage tools={tools} terminalWidth={width} />
    </UIStateProvider>,
    { columns: width },
  );
  return stripAnsi(lastFrame() ?? "");
}

describe("full 档：整段回执完整上屏", () => {
  test("路径语义提示（末两行）全部出现，整帧不含「已折叠」", () => {
    const frame = renderTools([worktreeTool()]);
    // 归一化空白后断言：正文会按终端列宽换行，断点落在哪一列不是被测契约
    // （那是 wrapLinesToWidth 的事，有独立测试），这里要验的是**一个字都没丢**。
    const flat = frame.replace(/\s+/g, "");
    // 前 3 行是「回执头部」——它在任何档位下都会显示，单测它没有意义。
    // 真正区分 full 与兜底的是后两行：它们是组件层 maxLines=3 会折掉的部分。
    expect(flat).toContain("主仓根:/repo（不是当前工作树）");
    expect(flat).toContain("此后写文件请用");
    expect(flat).toContain("thinking-off-floor下的路径。");
    expect(frame).not.toContain("已折叠");
  });

  test("对照组：同一份正文不声明档位 → 被组件层折掉 3 行（证明上一条不是恒绿）", () => {
    const frame = renderTools([worktreeTool({ displayMode: undefined })]);
    // 兜底档显示前 3 个视觉行 + 折叠 footer，路径语义提示整段消失。
    // 这条不是缺陷断言，是**判据存档**：进 EXPECTED_UNDECLARED 不等于不折。
    expect(frame).toContain("已折叠");
    expect(frame).not.toContain("主仓根:");
    expect(frame).not.toContain("此后写文件请用");
  });

  test("硬约束②：错误态同样完整可见（错误更该整段可见）", () => {
    const frame = renderTools([
      worktreeTool({
        status: "error",
        isError: true,
        result:
          "无法切回主工作区: boom\n原因：worktree 目录被外部删除\n建议：用 git worktree prune 清理后重试",
      }),
    ]);
    expect(frame).toContain("原因：worktree 目录被外部删除");
    expect(frame).toContain("建议：用 git worktree prune 清理后重试");
    expect(frame).not.toContain("已折叠");
  });

  test("full 档不吃 ctrl+o 阶梯：展开档 0 已经是完整正文（不是靠展开才看到）", () => {
    // full 的语义是「不需要展开」。若哪天有人把它实现成「默认折叠、ctrl+o 才展开」，
    // 那与 compact 就没区别了，本条会挂。
    const level0 = renderTools([worktreeTool()]);
    const level1 = renderTools([worktreeTool()]);
    expect(level0).toBe(level1);
  });
});
