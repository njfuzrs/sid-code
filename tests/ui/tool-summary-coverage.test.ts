/**
 * 工具 header 摘要的**覆盖度对账** —— 盯住"光秃秃的 `⏺ <name>`"这个反复发作的病灶
 *
 * ## 病史（同一个根因，三次发作）
 *
 * `ui-utils.ts` 的 `getToolSummary` 是一串按工具名的 `if` 分支 + 末尾 `return ""` 兜底。
 * 这个形状的问题不是"漏了某个名字"，而是**漏登记不会报错**：新工具接进来，类型检查过、
 * 全量单测绿，只是 header 上永远只有工具名。已知三次：
 *
 *   1. `sub_agent` —— 只判 `startsWith("subagent")`（无下划线），匹配不到真名 `sub_agent`；
 *   2. `think` —— 没有分支，header 恒为 `⏺ think`，配上结果区无信息的「已记录思考。」；
 *   3. `lsp` —— 没有分支，header 恒为 `⏺ lsp`。而 LSP 单次调用可以卡十几秒
 *      （等语言服务器就绪最长 10s、冷启动、单请求超时 30s），用户全程不知道在查什么
 *      （docs/_template/执行lsp过程空白.txt 的截图就是这个）。
 *
 * ## 这个测试做什么
 *
 * 对**真实工具类**（不是手抄的名字列表）逐个断言：拿一份典型入参喂给 `getToolSummary`，
 * 结果必须非空。新增工具时若忘了在 ui-utils 里登记，这里会红——把"静默看不见"变成
 * "CI 拦住"。
 *
 * 为什么不直接遍历 `toolRegistry`：组装真实 registry 要拉起 provider / MCP / 权限系统等
 * 一大串依赖（见 cli.ts 的 register 调用群），在单测里不划算。折中是**直接 import 工具类**
 * 取 `name()`——名字仍来自生产代码，漂移（改名 / 删除）会在编译期或 name() 上暴露，
 * 而不是靠测试里的字符串字面量。
 *
 * 铁律：调生产函数，不在测试里重写判定。
 */

import { describe, test, expect } from "bun:test";
import { getToolSummary, getToolDetailFull } from "../../src/ui/ui-utils.ts";
import { LSPTool } from "../../src/tool/lsp.ts";
import { ReadTool } from "../../src/tool/read.ts";
import { EditTool } from "../../src/tool/edit.ts";
import { WriteTool } from "../../src/tool/write.ts";
import { BashTool } from "../../src/tool/bash.ts";
import { GrepTool } from "../../src/tool/grep.ts";
import { GlobTool } from "../../src/tool/glob.ts";
// think 走的是现代 buildTool 形态（name 是属性，不是方法），故与上面的 class 工具取名方式不同
import { thinkTool } from "../../src/tool/think.ts";

/**
 * 需要 header 摘要的工具 × 一份典型入参。
 *
 * 工具名取自**工具实例的 name()**（生产代码的唯一事实源），不写字面量——这样工具改名时
 * 这个表自动跟着走，不会出现"测试里写着旧名字所以照样绿"。
 */
const CASES: Array<{ name: string; input: Record<string, unknown>; why: string }> = [
  {
    name: new ReadTool().name(),
    input: { file_path: "/tmp/x/foo.ts", offset: 10, limit: 20 },
    why: "路径 + 行范围",
  },
  { name: new EditTool().name(), input: { file_path: "/tmp/x/foo.ts" }, why: "路径" },
  { name: new WriteTool().name(), input: { file_path: "/tmp/x/foo.ts" }, why: "路径" },
  { name: new BashTool().name(), input: { command: "bun test" }, why: "命令" },
  { name: new GrepTool().name(), input: { pattern: "TODO" }, why: "pattern" },
  { name: new GlobTool().name(), input: { pattern: "**/*.ts" }, why: "pattern" },
  { name: thinkTool.name, input: { thought: "先确认时序再动手" }, why: "思考首句" },
  {
    name: new LSPTool().name(),
    input: { operation: "findReferences", file_path: "/tmp/x/foo.ts", line: 12, character: 3 },
    why: "操作 + 文件 + 位置（本次修复）",
  },
];

describe("工具 header 摘要覆盖度（漏登记 = 光秃秃的 ⏺ <name>）", () => {
  for (const { name, input, why } of CASES) {
    test(`${name} 有非空 header 摘要（${why}）`, () => {
      const summary = getToolSummary(name, input);
      expect(summary).toBeTruthy();
      // 摘要不该只是把工具名重复一遍——那等于没有信息
      expect(summary.trim()).not.toBe(name);
    });

    test(`${name} 有非空权限框详情`, () => {
      // getToolDetailFull 与 getToolSummary 是成对的两个白名单，历史上出现过
      // 「补了前者忘了后者」的半修状态（lsp 此前是两个都缺）。一起盯。
      expect(getToolDetailFull(name, input)).toBeTruthy();
    });
  }

  test("未登记的工具名回落空串（兜底行为本身是对的，只是不该被依赖）", () => {
    // 保留这条是为了说明设计意图：兜底返回 "" 不是 bug，问题在于"漏登记没人发现"。
    // 上面的逐工具断言才是发现机制。
    expect(getToolSummary("some_unregistered_tool", { foo: 1 })).toBe("");
  });
});

describe("LSP header 摘要 —— 各操作形态", () => {
  const lsp = new LSPTool().name();

  test("位置类操作：operation + 相对路径 + 行:列", () => {
    const s = getToolSummary(lsp, {
      operation: "goToDefinition",
      file_path: "/tmp/proj/src/a.ts",
      line: 42,
      character: 7,
    });
    // operation 必须在，且必须保住——它是"用户在看什么"的信息重心
    expect(s).toContain("goToDefinition");
    expect(s).toContain("a.ts");
    expect(s).toContain("42:7");
  });

  test("workspaceSymbol：重心是 query，不是文件", () => {
    const s = getToolSummary(lsp, {
      operation: "workspaceSymbol",
      file_path: "/tmp/proj/src/a.ts",
      query: "DiagnosticRegistry",
    });
    expect(s).toContain("workspaceSymbol");
    expect(s).toContain("DiagnosticRegistry");
    // file_path 只用于定位语言服务器，不该出现在摘要里抢位置
    expect(s).not.toContain("a.ts");
  });

  test("codeAction 省略 line/character（整文件范围）时不出现悬空的冒号", () => {
    const s = getToolSummary(lsp, { operation: "codeAction", file_path: "/tmp/proj/src/a.ts" });
    expect(s).toContain("codeAction");
    expect(s).toContain("a.ts");
    expect(s).not.toMatch(/:\s*$/);
    expect(s).not.toContain("undefined");
  });

  test("入参残缺（只有 operation / 只有路径）不产出 undefined 或空串", () => {
    expect(getToolSummary(lsp, { operation: "hover" })).toBe("hover");
    const onlyPath = getToolSummary(lsp, { file_path: "/tmp/proj/src/a.ts" });
    expect(onlyPath).toContain("a.ts");
    expect(onlyPath).not.toContain("undefined");
  });

  test("权限框详情给完整绝对路径（授权决策依据，不能是相对化后的）", () => {
    const d = getToolDetailFull(lsp, {
      operation: "findReferences",
      file_path: "/tmp/proj/src/a.ts",
      line: 1,
      character: 2,
    });
    expect(d).toContain("/tmp/proj/src/a.ts");
  });
});
