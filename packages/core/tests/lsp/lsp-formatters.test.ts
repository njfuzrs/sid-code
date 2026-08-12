/**
 * LSP 查询结果格式化单测
 * 覆盖：location 归一化与截断 / hover / documentSymbol（层级+扁平）/ workspaceSymbol /
 *       callHierarchy / URI→相对路径 / 1-based 行列转换
 */

import { describe, test, expect } from "bun:test";
import {
  uriToDisplayPath,
  normalizeLocations,
  formatLocations,
  formatHover,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
  formatCallHierarchyItems,
  formatIncomingCalls,
  formatOutgoingCalls,
  formatCodeActions,
  MAX_LOCATIONS,
  MAX_CODE_ACTIONS,
} from "@sid-code/core/tool/lsp-formatters.ts";
import { pathToFileURL } from "url";
import { join } from "path";

const WS = "/project/root";
const uri = (rel: string) => pathToFileURL(join(WS, rel)).href;
const range = (line: number, char: number) => ({
  start: { line, character: char },
  end: { line, character: char + 3 },
});

describe("uriToDisplayPath", () => {
  test("工作区内文件转相对路径", () => {
    expect(uriToDisplayPath(uri("src/a.ts"), WS)).toBe("src/a.ts");
  });

  test("非 file URI 原样返回", () => {
    expect(uriToDisplayPath("untitled:foo", WS)).toBe("untitled:foo");
  });
});

describe("normalizeLocations", () => {
  test("单个 Location 归一化", () => {
    const locs = normalizeLocations({ uri: uri("a.ts"), range: range(2, 4) });
    expect(locs.length).toBe(1);
    expect(locs[0]!.line).toBe(2);
    expect(locs[0]!.character).toBe(4);
  });

  test("Location 数组归一化", () => {
    const locs = normalizeLocations([
      { uri: uri("a.ts"), range: range(0, 0) },
      { uri: uri("b.ts"), range: range(1, 1) },
    ]);
    expect(locs.length).toBe(2);
  });

  test("LocationLink（targetUri）归一化，优先 targetSelectionRange", () => {
    const locs = normalizeLocations([
      {
        targetUri: uri("a.ts"),
        targetRange: range(5, 0),
        targetSelectionRange: range(5, 8),
      },
    ]);
    expect(locs.length).toBe(1);
    expect(locs[0]!.character).toBe(8); // selectionRange 优先
  });

  test("null / 空数组返回空", () => {
    expect(normalizeLocations(null)).toEqual([]);
    expect(normalizeLocations([])).toEqual([]);
  });
});

describe("formatLocations", () => {
  test("1-based 行列输出", () => {
    const out = formatLocations({ uri: uri("src/a.ts"), range: range(4, 2) }, WS);
    expect(out).toBe("src/a.ts:5:3"); // 0-based (4,2) → 1-based (5,3)
  });

  test("空结果返回自定义标签", () => {
    expect(formatLocations(null, WS, "未找到定义")).toBe("未找到定义");
  });

  test("超过 MAX_LOCATIONS 截断并附统计", () => {
    const many = Array.from({ length: MAX_LOCATIONS + 10 }, (_, i) => ({
      uri: uri(`f${i}.ts`),
      range: range(i, 0),
    }));
    const out = formatLocations(many, WS);
    const lines = out.split("\n").filter((l) => l.includes(".ts:"));
    expect(lines.length).toBe(MAX_LOCATIONS);
    expect(out).toContain(`共 ${MAX_LOCATIONS + 10} 处`);
  });
});

describe("formatHover", () => {
  test("MarkupContent 取 value", () => {
    expect(formatHover({ contents: { kind: "markdown", value: "**类型**: string" } })).toBe(
      "**类型**: string",
    );
  });

  test("MarkedString 数组拼接", () => {
    const out = formatHover({ contents: ["第一段", { language: "ts", value: "const x = 1" }] });
    expect(out).toContain("第一段");
    expect(out).toContain("```ts");
    expect(out).toContain("const x = 1");
  });

  test("空内容返回提示", () => {
    expect(formatHover(null)).toBe("无悬停信息");
    expect(formatHover({ contents: { kind: "plaintext", value: "" } })).toBe("无悬停信息");
  });
});

describe("formatDocumentSymbols", () => {
  test("层级 DocumentSymbol 树缩进", () => {
    const out = formatDocumentSymbols(
      [
        {
          name: "MyClass",
          kind: 5, // Class
          range: range(0, 0),
          selectionRange: range(0, 6),
          children: [{ name: "method", kind: 6, range: range(1, 2), selectionRange: range(1, 2) }],
        },
      ],
      WS,
    );
    expect(out).toContain("Class MyClass");
    expect(out).toContain("  Method method"); // 子项缩进 2 空格
  });

  test("扁平 SymbolInformation 列表", () => {
    const out = formatDocumentSymbols(
      [{ name: "foo", kind: 12, location: { uri: uri("a.ts"), range: range(3, 0) } }],
      WS,
    );
    expect(out).toContain("Function foo");
    expect(out).toContain("a.ts:4:1");
  });

  test("空返回提示", () => {
    expect(formatDocumentSymbols([], WS)).toBe("未找到符号");
  });
});

describe("formatWorkspaceSymbols", () => {
  test("name (kind) — file:line 格式", () => {
    const out = formatWorkspaceSymbols(
      [
        {
          name: "handler",
          kind: 12,
          location: { uri: uri("src/h.ts"), range: range(9, 0) },
          containerName: "routes",
        },
      ],
      WS,
    );
    expect(out).toContain("handler (Function)");
    expect(out).toContain("routes");
    expect(out).toContain("src/h.ts:10:1");
  });
});

describe("formatCallHierarchy", () => {
  test("prepareCallHierarchy 项格式化", () => {
    const out = formatCallHierarchyItems(
      [{ name: "fn", kind: 12, uri: uri("a.ts"), selectionRange: range(2, 0) }],
      WS,
    );
    expect(out).toContain("Function fn");
    expect(out).toContain("a.ts:3:1");
  });

  test("incomingCalls 显示调用者与调用次数", () => {
    const out = formatIncomingCalls(
      [
        {
          from: { name: "caller", kind: 12, uri: uri("c.ts"), selectionRange: range(0, 0) },
          fromRanges: [range(1, 0), range(2, 0)],
        },
      ],
      WS,
    );
    expect(out).toContain("caller");
    expect(out).toContain("2 处调用");
  });

  test("outgoingCalls 显示被调用项", () => {
    const out = formatOutgoingCalls(
      [
        {
          to: { name: "callee", kind: 12, uri: uri("d.ts"), selectionRange: range(0, 0) },
          fromRanges: [range(1, 0)],
        },
      ],
      WS,
    );
    expect(out).toContain("callee");
    expect(out).toContain("1 处调用");
  });

  test("空调用层级返回提示", () => {
    expect(formatCallHierarchyItems([], WS)).toContain("无可用的调用层级项");
    expect(formatIncomingCalls([], WS)).toBe("无调用者");
    expect(formatOutgoingCalls([], WS)).toBe("无被调用项");
  });
});

describe("formatCodeActions", () => {
  test("空结果 / 非数组 → 无修复提示", () => {
    expect(formatCodeActions(null, WS)).toContain("无可用的代码修复建议");
    expect(formatCodeActions([], WS)).toContain("无可用的代码修复建议");
    expect(formatCodeActions("bogus", WS)).toContain("无可用的代码修复建议");
  });

  test("过滤掉既无 edit 又无 command 的空壳 action", () => {
    const out = formatCodeActions([{ title: "空壳" }], WS);
    expect(out).toContain("无可用的代码修复建议");
  });

  test("preferred 修复展示 title + kind + 插入内容（1-based 行列）", () => {
    const actions = [
      {
        title: "Add missing import for 'useState'",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          changes: {
            [uri("src/App.tsx")]: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "import { useState } from 'react';\n",
              },
            ],
          },
        },
      },
    ];
    const out = formatCodeActions(actions, WS);
    expect(out).toContain("推荐修复");
    expect(out).toContain("Add missing import for 'useState'");
    expect(out).toContain("[quickfix]");
    // range start/start 相同 → 判定为插入
    expect(out).toContain("插入");
    expect(out).toContain("src/App.tsx:1:1");
    // newText 中的换行被转义，不破坏列表结构
    expect(out).toContain("\\n");
    expect(out).not.toContain("import { useState } from 'react';\n      "); // 未原样带真实换行
  });

  test("newText 为空 → 判定为删除；range 起止不同 → 替换", () => {
    const del = formatCodeActions(
      [
        {
          title: "Remove unused variable",
          kind: "quickfix",
          isPreferred: true,
          edit: {
            changes: {
              [uri("a.ts")]: [
                {
                  range: { start: { line: 41, character: 0 }, end: { line: 42, character: 0 } },
                  newText: "",
                },
              ],
            },
          },
        },
      ],
      WS,
    );
    expect(del).toContain("删除");
    expect(del).toContain("a.ts:42:1"); // 1-based

    const rep = formatCodeActions(
      [
        {
          title: "Replace with const",
          kind: "quickfix",
          isPreferred: true,
          edit: {
            changes: {
              [uri("a.ts")]: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                  newText: "const",
                },
              ],
            },
          },
        },
      ],
      WS,
    );
    expect(rep).toContain("替换");
    expect(rep).toContain("const");
  });

  test("preferred 与非 preferred 分区展示", () => {
    const actions = [
      {
        title: "首选修复",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          changes: {
            [uri("a.ts")]: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "x",
              },
            ],
          },
        },
      },
      {
        title: "备选修复",
        kind: "quickfix",
        edit: {
          changes: {
            [uri("a.ts")]: [
              {
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                newText: "y",
              },
            ],
          },
        },
      },
    ];
    const out = formatCodeActions(actions, WS);
    expect(out).toContain("推荐修复");
    expect(out).toContain("其它修复建议");
    expect(out).toContain("首选修复");
    expect(out).toContain("备选修复");
  });

  test("非 preferred 超过上限时截断并提示剩余数量", () => {
    const actions = Array.from({ length: MAX_CODE_ACTIONS + 5 }, (_, i) => ({
      title: `修复${i}`,
      kind: "quickfix",
      edit: {
        changes: {
          [uri("a.ts")]: [
            {
              range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } },
              newText: "z",
            },
          ],
        },
      },
    }));
    const out = formatCodeActions(actions, WS);
    expect(out).toContain("另有 5 条修复建议未显示");
  });

  test("纯 command 形态 action：提示需服务器执行命令，不谎称可直接 apply", () => {
    const out = formatCodeActions(
      [
        {
          title: "Organize Imports",
          kind: "source.organizeImports",
          command: { title: "Organize", command: "_typescript.organizeImports" },
        },
      ],
      WS,
    );
    expect(out).toContain("Organize Imports");
    expect(out).toContain("需服务器执行命令");
  });

  test("说明文案诚实：只读展示、用 edit 工具落地，不承诺自动 apply", () => {
    const out = formatCodeActions(
      [
        {
          title: "fix",
          kind: "quickfix",
          isPreferred: true,
          edit: {
            changes: {
              [uri("a.ts")]: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: "x",
                },
              ],
            },
          },
        },
      ],
      WS,
    );
    expect(out).toContain("edit 工具");
    expect(out).toContain("不自动改文件");
  });
});
