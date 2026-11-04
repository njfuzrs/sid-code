/**
 * F3：残卷收工具证据 + 纯工具轮 `.output` 摘要（方案 §4.3 第 3、4 条）。
 *
 * 事故背景（会话 20261103-f5beebde）：三个后台子代理每轮都是**纯工具调用**
 * （sidechain 里 assistant 文本块数为 0）。旧残卷只收文本结论，于是主代理拿到的
 * 残卷是「已改动文件 0 个 / 最后一步停在 read」——它们的成果（git 输出、文件内容）
 * 一条都不在里面；`.output` 也因为只写文本轮而从头到尾是空文件。
 *
 * 落盘隔离：salvage 是纯内存模块（无 IO），不需要 SID_CONFIG_DIR 重定向。
 */

import { describe, test, expect } from "bun:test";
import {
  SalvageCollector,
  buildSalvageOutput,
  formatToolTurnLine,
  type SalvageTurnInfo,
} from "@sid-code/core/agent/salvage.ts";
import {
  truncateForNotification,
  NOTIFICATION_ERROR_MAX_CHARS,
} from "@sid-code/core/task/notification.ts";

/** 造一轮「纯工具、无文本」的快照——本缺陷的典型形态。 */
function toolOnlyTurn(
  turn: number,
  name: string,
  input: Record<string, unknown>,
  result?: { content: string; isError: boolean },
): SalvageTurnInfo {
  return {
    turn,
    textOutput: "",
    tools: [{ name, input, ...(result ? { result } : {}) }],
    tokenCount: turn * 100,
    toolUseCount: turn,
  };
}

describe("F3 残卷工具证据", () => {
  test("纯工具轮也能给残卷留下成果（本缺陷的正面修复）", () => {
    const c = new SalvageCollector();
    c.recordTurn(
      toolOnlyTurn(
        1,
        "bash",
        { command: "git log --oneline -20" },
        {
          content: "abc123 修缺陷\ndef456 加测试",
          isError: false,
        },
      ),
    );

    const snap = c.snapshot();
    expect(snap.findings).toEqual([]); // 纯工具轮没有文本结论，这正是问题所在
    expect(snap.changedFiles).toEqual([]); // 只读核查也不改文件
    // 唯一的成果在这里：
    expect(snap.toolEvidence).toHaveLength(1);
    expect(snap.toolEvidence[0]!.call).toBe("bash: git log --oneline -20");
    expect(snap.toolEvidence[0]!.content).toContain("abc123");
  });

  test("错误结果不进工具证据（失败调用不是成果）", () => {
    const c = new SalvageCollector();
    c.recordTurn(
      toolOnlyTurn(
        1,
        "bash",
        { command: "cat /nope" },
        {
          content: "ENOENT: no such file",
          isError: true,
        },
      ),
    );
    c.recordTurn(
      toolOnlyTurn(2, "bash", { command: "ls" }, { content: "a.ts b.ts", isError: false }),
    );

    expect(c.snapshot().toolEvidence).toHaveLength(1);
    expect(c.snapshot().toolEvidence[0]!.call).toBe("bash: ls");
  });

  test("没有 result 字段时不进证据（旧调用方 / 协议缺字段）", () => {
    const c = new SalvageCollector();
    c.recordTurn(toolOnlyTurn(1, "read", { file_path: "/a.ts" }));
    expect(c.snapshot().toolEvidence).toEqual([]);
  });

  test("空结果不进证据（grep 无命中不值得占名额）", () => {
    const c = new SalvageCollector();
    c.recordTurn(
      toolOnlyTurn(1, "grep", { pattern: "zzz" }, { content: "   \n ", isError: false }),
    );
    expect(c.snapshot().toolEvidence).toEqual([]);
  });

  test("只保留最近 6 条（越晚越接近最终成果）", () => {
    const c = new SalvageCollector();
    for (let i = 1; i <= 8; i++) {
      c.recordTurn(
        toolOnlyTurn(i, "bash", { command: `cmd${i}` }, { content: `out${i}`, isError: false }),
      );
    }
    const evidence = c.snapshot().toolEvidence;
    expect(evidence).toHaveLength(6);
    expect(evidence[0]!.content).toBe("out3"); // 最早两条被挤掉
    expect(evidence[5]!.content).toBe("out8");
  });

  test("单条结果超过 800 字截断（残卷是摘要，全文在 sidechain）", () => {
    const c = new SalvageCollector();
    c.recordTurn(
      toolOnlyTurn(
        1,
        "read",
        { file_path: "/big.ts" },
        {
          content: "x".repeat(2000),
          isError: false,
        },
      ),
    );
    const e = c.snapshot().toolEvidence[0]!;
    expect(e.content.length).toBe(800 + "…[截断]".length);
    expect(e.content.endsWith("…[截断]")).toBe(true);
  });

  test("`<tool-evidence>` 排在 findings 之后、`<next-step>` 之后（截断时关键段先入窗口）", () => {
    const c = new SalvageCollector();
    c.recordTurn({
      turn: 1,
      textOutput: "结论：这个缺陷在 salvage 层",
      tools: [],
      tokenCount: 10,
      toolUseCount: 0,
    });
    c.recordTurn(
      toolOnlyTurn(
        2,
        "bash",
        { command: "git diff --stat" },
        {
          content: "2 files changed",
          isError: false,
        },
      ),
    );

    const out = buildSalvageOutput(c.snapshot(), { reason: "error", errorMessage: "boom" });
    const findingsAt = out.indexOf("<findings");
    const incompleteAt = out.indexOf("<incomplete>");
    const nextStepAt = out.indexOf("<next-step>");
    const evidenceAt = out.indexOf("<tool-evidence");
    expect(findingsAt).toBeGreaterThan(-1);
    // 仍在 findings 之后（成果顺序不变：结论在前，证据在后）
    expect(evidenceAt).toBeGreaterThan(findingsAt);
    // 但排在 incomplete / next-step **之后**：通道截断时先丢证据尾部，不丢「下一步」。
    // 依据见 salvage.ts 该段的注释（PR #574 review：紧跟 findings 会把两段挤出 4000 字窗口）。
    expect(evidenceAt).toBeGreaterThan(incompleteAt);
    expect(evidenceAt).toBeGreaterThan(nextStepAt);
    expect(out).toContain("2 files changed");
  });

  test("6 条满额证据使残卷超长时，<incomplete> / <next-step> 仍在通知窗口内", () => {
    const c = new SalvageCollector();
    for (let i = 1; i <= 6; i++) {
      c.recordTurn(
        toolOnlyTurn(
          i,
          "bash",
          { command: `git log --oneline -50 r${i}` },
          { content: `${i}`.repeat(700), isError: false },
        ),
      );
    }
    const full = buildSalvageOutput(c.snapshot(), {
      reason: "error",
      errorMessage: "LLM 错误（quota_exhausted）",
      cause: "auth",
      retryAttempts: 3,
      outputFile: "/tmp/sess-agent.jsonl",
    });
    // 前提：这个形态确实超过通知通道（否则本用例测不到截断行为）
    expect(Array.from(full).length).toBeGreaterThan(NOTIFICATION_ERROR_MAX_CHARS);

    const sent = truncateForNotification(full, NOTIFICATION_ERROR_MAX_CHARS, "/tmp/agent.output");
    expect(sent).toContain("<incomplete>");
    expect(sent).toContain("<next-step>");
    expect(sent).toContain("认证失败，检查凭证");
    // 证据被截掉是可接受的：完整残卷在 .output，截断提示给出了指针
    expect(sent).toContain("已截断");
    expect(sent).toContain("/tmp/agent.output");
  });

  test("工具结果正文里的 </evidence> 被转义（不会把段提前闭合）", () => {
    const c = new SalvageCollector();
    c.recordTurn(
      toolOnlyTurn(
        1,
        "read",
        { file_path: "/x/salvage.ts" },
        {
          content: 'parts.push("</evidence>");\nparts.push("</tool-evidence>");',
          isError: false,
        },
      ),
    );
    const out = buildSalvageOutput(c.snapshot(), { reason: "error" });
    // 结构自身的闭合各恰好一条；正文里那两个已转义（否则段边界会被提前闭合）
    expect(out.match(/<\/evidence>/g)?.length).toBe(1);
    expect(out.match(/<\/tool-evidence>/g)?.length).toBe(1);
    expect(out).toContain("&lt;/evidence>");
    expect(out).toContain("&lt;/tool-evidence>");
  });

  test("无证据时不输出空段（避免主代理读到空标签）", () => {
    const c = new SalvageCollector();
    c.recordTurn(toolOnlyTurn(1, "read", { file_path: "/a.ts" }));
    const out = buildSalvageOutput(c.snapshot(), { reason: "error" });
    expect(out).not.toContain("<tool-evidence");
  });

  test("调用描述里的引号被转义（命令原文常带引号，会提前闭合属性）", () => {
    const c = new SalvageCollector();
    c.recordTurn(
      toolOnlyTurn(
        1,
        "bash",
        { command: 'grep -n "foo" a.ts' },
        {
          content: 'a.ts:1:const x = "foo"',
          isError: false,
        },
      ),
    );
    const out = buildSalvageOutput(c.snapshot(), { reason: "error" });
    expect(out).toContain('call="bash: grep -n &quot;foo&quot; a.ts"');
    expect(out).not.toContain('call="bash: grep -n "foo" a.ts"');
  });
});

describe("F3 纯工具轮 .output 摘要", () => {
  test("有结果时带字节数与工具名 + 首参", () => {
    const line = formatToolTurnLine(3, [
      {
        name: "bash",
        input: { command: "git status --short" },
        result: { content: " M a.ts\n", isError: false },
      },
    ]);
    expect(line).toBe("[轮次 3] bash(git status --short) → 8 字节\n");
  });

  test("出错的工具标「出错」而不是字节数", () => {
    const line = formatToolTurnLine(1, [
      { name: "bash", input: { command: "false" }, result: { content: "boom", isError: true } },
    ]);
    expect(line).toBe("[轮次 1] bash(false) → 出错\n");
  });

  test("没有结果字段时说「结果未知」而不是「0 字节」（两者含义完全不同）", () => {
    const line = formatToolTurnLine(1, [{ name: "read", input: { file_path: "/a.ts" } }]);
    expect(line).toBe("[轮次 1] read(/a.ts) → 结果未知\n");
  });

  test("一轮多个工具用分号分隔（仍是一行）", () => {
    const line = formatToolTurnLine(2, [
      { name: "read", input: { file_path: "/a.ts" }, result: { content: "x", isError: false } },
      { name: "grep", input: { pattern: "foo" }, result: { content: "y", isError: false } },
    ]);
    expect(line).toBe("[轮次 2] read(/a.ts) → 1 字节; grep(foo) → 1 字节\n");
  });

  test("首参过长截断到 80 字（`.output` 是摘要，不是 transcript）", () => {
    const line = formatToolTurnLine(1, [
      {
        name: "bash",
        input: { command: "c".repeat(200) },
        result: { content: "x", isError: false },
      },
    ]);
    expect(line).toContain(`bash(${"c".repeat(80)}…)`);
    expect(line).not.toContain("c".repeat(81));
  });

  test("没有工具时返回 null（调用方据此不写空行）", () => {
    expect(formatToolTurnLine(1, [])).toBeNull();
    expect(formatToolTurnLine(1, [{ name: "", input: {} }])).toBeNull();
  });
});
