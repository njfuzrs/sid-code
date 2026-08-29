/**
 * 非交互模式拒绝的**成因可见性**（Harbor A11 第七棒，2026-08-29）
 *
 * ## 这份测试守的是什么
 *
 * headless 下 `ask → deny` 时，`checker.ts` 的 `decisionReason` 曾写死
 * `{ type: "other", reason: "非交互模式" }`。而**模型看到的就是它**：
 * `tool-executor.ts` 用 `explainDecision(decision)` 组装 tool_result，
 * 那个函数**优先读 `decisionReason`**（`decision.reason` 只在它缺失时兜底），
 * 于是带着真实成因的长文本只进了审计日志，对话里只剩
 * `权限拒绝: 拒绝 — 非交互模式` —— 一句不含任何可行动信息的话。
 *
 * ## 为什么值得一个专门的测试文件
 *
 * 实测代价（A11 两题逐轨迹复算）：34/66 次工具调用被拒，成因是**三类语义完全
 * 不同**的东西（21× 白名单外需确认 / 8× injection 启发式 / 3× 写入工作区外），
 * 而它们在对话里长得**一模一样**。模型于是盲试：环境探测型动作占 30–39%、
 * 同一条 heredoc 原样重发两次、往 `/tmp` 写 9 次全被拒却从未被告知
 * 「`/tmp` 在工作区外」。对照 mini-swe-agent 8 步提交，我们 33 次调用撞满
 * `--max-turns` 未解出。
 *
 * ⚠️ **这个失效模式不会让任何测试变红，也不会留下错误日志** ——
 * 权限系统「按设计工作」，审计日志「字段齐全」，只是**信息没送到需要它的那一侧**。
 * 所以判据必须钉在「模型实际看到的那个字符串」上，而不是 `decision.reason`。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { explainDecision } from "@sid-code/core/permission/explainer.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Config } from "@sid-code/core/config/config.ts";

/** 照 Harbor agent 的真实配置：`--print` + `--max-turns 40` + `acceptEdits`。 */
function makeChecker(workspace: string): PermissionChecker {
  const config = {
    ...defaultConfig(),
    print: true,
    maxTurns: 40,
    permissionMode: "acceptEdits",
    disallowedTools: [],
    allowedTools: [],
  } as Config;
  return new PermissionChecker(config, undefined, workspace);
}

/** 模型实际收到的 tool_result 文本（与 `tool-executor.ts` 的拼法一致）。 */
async function whatTheModelSees(
  checker: PermissionChecker,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ allowed: boolean; text: string }> {
  const decision = await checker.check({ toolName, input } as never);
  return { allowed: decision.allowed, text: `权限拒绝: ${explainDecision(decision)}` };
}

describe("非交互模式拒绝必须把成因说给模型（A11 34/66 次被拒的直接成因）", () => {
  let ws: string;

  // 这些用例**全部照 A11 真实轨迹的 audit log 逐字取**，不是构造的。
  // 构造用例会漂移到「我以为模型会发什么命令」，而这三条是它真的发过的。
  const REAL_DENIED: {
    label: string;
    tool: string;
    input: Record<string, unknown>;
    /** 成因里必须出现的关键词 —— 它是模型改道所需的最小信息 */
    mustExplain: string;
  }[] = [
    {
      label: "heredoc 正文含 Python 三引号 → injection 启发式（原样重发过两次）",
      tool: "bash",
      input: {
        command: "mkdir -p /app && cat << 'EOF' > /tmp/t.py\nimport re\nIPV4 = r'''x'''\nEOF",
      },
      mustExplain: "injection",
    },
    {
      label: '环境探测里的 echo "---" → 被判带引号的 flag 混淆',
      tool: "bash",
      input: { command: 'which perl node grep 2>&1; grep --version 2>&1 | head -1; echo "---"' },
      mustExplain: "injection",
    },
    {
      label: "写 /tmp → 工作区外（该题连写 9 次，9 次全拒）",
      tool: "write",
      input: { file_path: join(tmpdir(), "a11-outside-workspace.pl"), content: "x" },
      mustExplain: "工作区外",
    },
  ];

  test.each(REAL_DENIED)("$label", async ({ tool, input, mustExplain }) => {
    ws = mkdtempSync(join(tmpdir(), "a11-denial-vis-"));
    try {
      const { allowed, text } = await whatTheModelSees(makeChecker(ws), tool, input);
      // 前提：这条确实被拒了。它要是被放行，本用例证明不了任何事 ——
      // 而「用例还在、判据已失效」正是本仓最贵的那类门禁失效。
      expect(allowed).toBe(false);

      // ① 真实成因必须出现在**模型看到的**那句话里（不是只在 audit log 里）。
      expect(text).toContain(mustExplain);

      // ② 必须说破「重试无用」。实测模型把静默拒绝当偶发失败，原样重发过两次；
      // 说破它等于把一次白烧的轮次换成一次改道。
      expect(text).toContain("重试相同输入不会改变结果");

      // ③ ⛔ 反向锁：**不许退化成只有「非交互模式」这四个字**。
      // 这正是修复前的形态，而它当时不会让任何断言变红。
      expect(text).not.toBe("权限拒绝: 拒绝 — 非交互模式");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("三类成因在模型侧必须**互相可区分**（修复前它们逐字相同）", async () => {
    ws = mkdtempSync(join(tmpdir(), "a11-denial-distinct-"));
    try {
      const checker = makeChecker(ws);
      const seen: string[] = [];
      for (const c of REAL_DENIED) {
        seen.push((await whatTheModelSees(checker, c.tool, c.input)).text);
      }
      // 这条是本文件的核心判据：**分不开就等于没说**。
      // 修复前三句话完全相同 → new Set(...).size === 1。
      expect(new Set(seen).size).toBe(REAL_DENIED.length);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("审计日志口径保持不变（`decision.reason` 仍是原文，历史轨迹可比）", async () => {
    // 修复只动 `decisionReason`（给模型看的），**不动 `reason`**（进审计日志的）。
    // 动它会让 A11 那份复算与新轨迹不同口径 —— 而那份复算正是这次修复的证据来源。
    ws = mkdtempSync(join(tmpdir(), "a11-denial-audit-"));
    try {
      const decision = await makeChecker(ws).check({
        toolName: "write",
        input: { file_path: join(tmpdir(), "outside.txt"), content: "x" },
      } as never);
      expect(decision.reason).toStartWith("非交互模式下自动拒绝: ");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
