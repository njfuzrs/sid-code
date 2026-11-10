/**
 * G2 运行器自身的单测：夹具占位符替换、越界路径拦截、轨迹断言、step summary 表格。
 *
 * 这几段是「门禁的门禁」：越界拦截失效 = 回放会去改用例目录外的真实文件；
 * 断言计数写错 = 用例恒绿。所以单独用纯函数测，不起子进程。
 * 真正跑用例的是 scripts/smoke/run.ts（不进 bun test，见专项 M2）。
 */
import { describe, expect, test } from "bun:test";
import { checkEventExpect, checkFileExpect, parseEvents, parseRawRequests } from "./lib/assert.ts";
import { findOutOfRootPaths, substituteCaseRoot } from "./lib/fixture.ts";
import { renderSummary } from "./lib/runner.ts";

const ROOT = "/tmp/sid-smoke-x/repo";

function toolLine(input: Record<string, unknown>, name = "read") {
  return JSON.stringify({
    index: 1,
    response: { content: [{ type: "tool_use", id: "t", name, input }], stop_reason: "tool_use" },
  });
}

describe("substituteCaseRoot", () => {
  test("把 ${CASE_ROOT} 替换成实际目录", () => {
    const out = substituteCaseRoot(toolLine({ file_path: "${CASE_ROOT}/a.txt" }), ROOT);
    expect(JSON.parse(out).response.content[0].input.file_path).toBe(`${ROOT}/a.txt`);
  });

  test("目录里有需要 JSON 转义的字符时替换后仍是合法 JSON", () => {
    const weird = '/tmp/a "b"\\c';
    const out = substituteCaseRoot(toolLine({ file_path: "${CASE_ROOT}/x" }), weird);
    expect(JSON.parse(out).response.content[0].input.file_path).toBe(`${weird}/x`);
  });
});

describe("findOutOfRootPaths", () => {
  test("根目录内的路径放行", () => {
    expect(findOutOfRootPaths(toolLine({ file_path: `${ROOT}/a.txt` }), ROOT)).toEqual([]);
  });

  test("录制时的绝对路径被拦（2026-11-06 探针的真实形态）", () => {
    const v = findOutOfRootPaths(toolLine({ file_path: "/private/tmp/a2-e2e/hello.txt" }), ROOT);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("/private/tmp/a2-e2e/hello.txt");
  });

  test("前缀相同但不在根目录内的兄弟目录被拦", () => {
    expect(findOutOfRootPaths(toolLine({ file_path: `${ROOT}-evil/a.txt` }), ROOT)).toHaveLength(1);
  });

  test("嵌套在数组和对象里的路径也查", () => {
    const line = toolLine({ edits: [{ path: "/etc/passwd" }] }, "multi_edit");
    expect(findOutOfRootPaths(line, ROOT)).toHaveLength(1);
  });

  test("坏行直接算违规，不像 ReplayProvider 那样跳过", () => {
    expect(findOutOfRootPaths("{not json", ROOT)).toEqual(["第 1 行不是合法 JSON"]);
  });

  test("文本块里的斜杠开头字符串不算（只查 tool_use 入参）", () => {
    const line = JSON.stringify({
      index: 1,
      response: { content: [{ type: "text", text: "/etc/passwd" }], stop_reason: "end_turn" },
    });
    expect(findOutOfRootPaths(line, ROOT)).toEqual([]);
  });
});

describe("checkEventExpect", () => {
  const events = parseEvents(
    [
      JSON.stringify({ event: "PostToolUse", data: { tool_name: "read", is_error: false } }),
      JSON.stringify({ event: "PostToolUse", data: { tool_name: "edit", is_error: false } }),
      JSON.stringify({ event: "SessionEnd", data: { exit_status: "end_turn" } }),
      "{半行", // 进程被杀时的末行
    ].join("\n"),
  );

  test("半行被跳过，其余照常解析", () => {
    expect(events).toHaveLength(3);
  });

  test("恰好 N 条：命中与不命中", () => {
    expect(
      checkEventExpect(events, { event: "PostToolUse", where: { tool_name: "edit" }, count: 1 }),
    ).toBeNull();
    expect(checkEventExpect(events, { event: "PostToolUse", count: 1 })).toContain("实际 2 条");
  });

  test("count: 0 能断言「不应该发生」", () => {
    expect(
      checkEventExpect(events, { event: "PostToolUse", where: { tool_name: "bash" }, count: 0 }),
    ).toBeNull();
    expect(
      checkEventExpect(events, { event: "PostToolUse", where: { tool_name: "read" }, count: 0 }),
    ).toContain("实际 1 条");
  });

  test("缺省是 >=1，0 条要报错", () => {
    expect(checkEventExpect(events, { event: "HookExecuted" })).toContain("实际 0 条");
  });

  test("where 值严格相等：false 与缺省不混", () => {
    expect(
      checkEventExpect(events, { event: "PostToolUse", where: { is_error: true } }),
    ).not.toBeNull();
  });
});

describe("parseRawRequests", () => {
  test("只取带 request 的行，按顺序；响应行与半行跳过", () => {
    const jsonl = [
      JSON.stringify({ request: { system: "s1" } }),
      JSON.stringify({ response: { content: [] } }),
      JSON.stringify({ request: { system: "s2" } }),
      "{半行",
    ].join("\n");
    expect(parseRawRequests(jsonl)).toEqual([{ system: "s1" }, { system: "s2" }]);
  });
});

describe("checkFileExpect", () => {
  const files: Record<string, string> = { "a.txt": "hello sid-code\n" };
  const read = (p: string) => files[p] ?? null;

  test("equals / contains / absent", () => {
    expect(checkFileExpect(read, { path: "a.txt", equals: "hello sid-code\n" })).toBeNull();
    expect(checkFileExpect(read, { path: "a.txt", equals: "hello world\n" })).toContain("内容不等");
    expect(checkFileExpect(read, { path: "a.txt", contains: "sid-code" })).toBeNull();
    expect(checkFileExpect(read, { path: "b.txt", contains: "x" })).toContain("不存在");
    expect(checkFileExpect(read, { path: "b.txt", absent: true })).toBeNull();
    expect(checkFileExpect(read, { path: "a.txt", absent: true })).toContain("期望不存在");
  });
});

// 专项 M2 验收④「step summary 能看到每例 pass/fail/skip」靠的就是这张表。job 绿的时候
// skip 只在这里看得见；G4 的失败信息带多行「最后一帧」，不压成一行会把 markdown 表格撑坏。
describe("renderSummary", () => {
  const md = renderSummary(
    [
      { id: "A2-ok", status: "pass", failures: [], durationMs: 400 },
      {
        id: "B2-seatbelt",
        status: "skip",
        reason: "仅在 darwin 上运行，当前 linux",
        failures: [],
        durationMs: 0,
      },
      {
        id: "A1-dialog",
        status: "fail",
        failures: ["「改文件的一轮结束」超时\n---- 最后一帧 ----\n > a | b", "第二条"],
        durationMs: 21_400,
      },
    ],
    "G4 TUI e2e（linux）",
  );
  const rows = md.split("\n");
  const row = (id: string) => rows.find((l) => l.startsWith(`| ${id} |`)) ?? "";

  test("标题与表头", () => {
    expect(rows[0]).toBe("### G4 TUI e2e（linux）");
    expect(md).toContain("| 用例 | 结果 | 耗时 | 说明 |");
  });

  test("三种状态各一行，skip 带原因、fail 带第一条失败", () => {
    expect(row("A2-ok")).toBe("| A2-ok | ✅ pass | 0.4s |  |");
    expect(row("B2-seatbelt")).toContain("⏭️ skip");
    expect(row("B2-seatbelt")).toContain("仅在 darwin 上运行");
    expect(row("A1-dialog")).toContain("❌ fail");
    expect(row("A1-dialog")).toContain("21.4s");
    expect(row("A1-dialog")).toContain("「改文件的一轮结束」超时");
    expect(row("A1-dialog")).not.toContain("第二条");
  });

  test("多行失败信息压成一行、竖线转义，不撑坏表格", () => {
    expect(rows.filter((l) => l.startsWith("| A1-dialog |"))).toHaveLength(1);
    expect(row("A1-dialog")).toContain("a \\| b");
    expect(md).not.toContain("最后一帧 ----\n");
  });
});
