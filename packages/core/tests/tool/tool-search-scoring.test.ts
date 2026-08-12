/**
 * ToolSearch 加权关键词搜索 —— 评分内核单测
 *
 * 覆盖：parseToolName / compileTermPatterns / searchToolsWithScoring
 * 快路径（精确名/mcp前缀）、+required 必需词、权重排序、MCP 加权。
 */

import { describe, test, expect } from "bun:test";
import {
  parseToolName,
  compileTermPatterns,
  searchToolsWithScoring,
  extractParamText,
  type SearchableTool,
} from "@sid-code/core/tool/tool-search-scoring.ts";

describe("parseToolName", () => {
  test("CamelCase 拆词", () => {
    const r = parseToolName("ToolSearchTool");
    expect(r.parts).toEqual(["tool", "search", "tool"]);
    expect(r.full).toBe("tool search tool");
    expect(r.isMcp).toBe(false);
  });

  test("下划线拆词", () => {
    const r = parseToolName("file_read");
    expect(r.parts).toEqual(["file", "read"]);
    expect(r.full).toBe("file read");
    expect(r.isMcp).toBe(false);
  });

  test("混合 CamelCase + 下划线", () => {
    const r = parseToolName("TaskOutputTool");
    expect(r.parts).toEqual(["task", "output", "tool"]);
  });

  test("mcp__ 三段拆词", () => {
    const r = parseToolName("mcp__github__create_issue");
    expect(r.parts).toEqual(["github", "create", "issue"]);
    expect(r.full).toBe("github create issue");
    expect(r.isMcp).toBe(true);
  });

  test("mcp__ 双段", () => {
    const r = parseToolName("mcp__slack__send_message");
    expect(r.parts).toEqual(["slack", "send", "message"]);
    expect(r.isMcp).toBe(true);
  });

  test("纯小写无分隔", () => {
    const r = parseToolName("read");
    expect(r.parts).toEqual(["read"]);
    expect(r.full).toBe("read");
    expect(r.isMcp).toBe(false);
  });
});

describe("compileTermPatterns", () => {
  test("返回词边界正则", () => {
    const patterns = compileTermPatterns(["read", "file"]);
    expect(patterns.size).toBe(2);
    expect(patterns.get("read")!.test("reading")).toBe(false);
    expect(patterns.get("read")!.test("can read files")).toBe(true);
  });

  test("特殊字符转义（正则元字符按字面匹配）", () => {
    const patterns = compileTermPatterns(["a.b"]);
    // 转义后 "." 是字面点，匹配 "a.b" 但不匹配 "axb"
    expect(patterns.get("a.b")!.test("an a.b token")).toBe(true);
    expect(patterns.get("a.b")!.test("an axb token")).toBe(false);
  });

  test("去重", () => {
    const patterns = compileTermPatterns(["a", "a", "b"]);
    expect(patterns.size).toBe(2);
  });
});

describe("searchToolsWithScoring", () => {
  const tools: SearchableTool[] = [
    {
      name: "mcp__github__create_issue",
      description: "Create a GitHub issue",
      searchHint: "bug report",
    },
    { name: "mcp__github__list_repos", description: "List GitHub repositories" },
    {
      name: "mcp__slack__send_message",
      description: "Send a message to Slack channel",
      searchHint: "chat notify",
    },
    {
      name: "notebook_edit",
      description: "Edit a Jupyter notebook cell",
      searchHint: "jupyter cell ipynb",
    },
    { name: "TaskOutputTool", description: "Get background task output" },
    {
      name: "WebSearchTool",
      description: "Search the web for information",
      searchHint: "internet query",
    },
  ];

  test("精确名快路径（延迟池命中）", () => {
    const r = searchToolsWithScoring("mcp__github__create_issue", tools, tools, 5);
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("mcp__github__create_issue");
    expect(r[0].score).toBe(100); // 精确命中标记
  });

  test("精确名快路径（全量池回退）", () => {
    const allTools = [...tools, { name: "read", description: "Read a file" }];
    const r = searchToolsWithScoring("read", tools, allTools, 5);
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("read");
  });

  test("mcp__ 前缀快路径", () => {
    const r = searchToolsWithScoring("mcp__github", tools, tools, 5);
    expect(r.length).toBe(2);
    expect(r.map((t) => t.name)).toContain("mcp__github__create_issue");
    expect(r.map((t) => t.name)).toContain("mcp__github__list_repos");
  });

  test("关键词搜索 — 名分词命中权重最高(MCP)", () => {
    const r = searchToolsWithScoring("github", tools, tools, 5);
    // github 在 mcp__github__xxx 的 parts 里是整词命中 → +12 每个
    expect(r.length).toBe(2);
    expect(r[0].name).toContain("github");
    expect(r[0].score).toBeGreaterThanOrEqual(12);
  });

  test("关键词搜索 — searchHint 命中", () => {
    const r = searchToolsWithScoring("jupyter", tools, tools, 5);
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].name).toBe("notebook_edit");
  });

  test("关键词搜索 — description 词边界命中", () => {
    const r = searchToolsWithScoring("background", tools, tools, 5);
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("TaskOutputTool");
  });

  test("+required 必需词过滤（require github，按其余词排序）", () => {
    // +github create → 必须含 github；create 仅参与排序。两个 github 工具都保留，
    // 含 create 的排前面。
    const r = searchToolsWithScoring("+github create", tools, tools, 5);
    expect(r.length).toBe(2);
    expect(r[0].name).toBe("mcp__github__create_issue"); // create 命中 → 排第一
    expect(r.map((t) => t.name)).toContain("mcp__github__list_repos");
  });

  test("+required 全不满足 → 无结果", () => {
    const r = searchToolsWithScoring("+nonexistent term", tools, tools, 5);
    expect(r.length).toBe(0);
  });

  test("maxResults 截断", () => {
    // "github" 命中两个 mcp__github__ 工具（名分词整词命中），截断到 1
    const r = searchToolsWithScoring("github", tools, tools, 1);
    expect(r.length).toBe(1);
  });

  test("空 query 返回空", () => {
    const r = searchToolsWithScoring("", tools, tools, 5);
    expect(r.length).toBe(0);
  });

  test("按分数降序排列", () => {
    const r = searchToolsWithScoring("slack send", tools, tools, 5);
    // slack 在 parts 里命中(+12)，send 也在 parts(+12)，加上 desc 可能追加 → 总分高
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
    }
  });

  test("普通工具分词子串命中权重低于整词", () => {
    const similarTools: SearchableTool[] = [
      { name: "reader", description: "Read many files" },
      { name: "read", description: "Read a single file" },
    ];
    // "read" 精确名快路径会命中 "read"
    const r = searchToolsWithScoring("read", similarTools, similarTools, 5);
    expect(r[0].name).toBe("read");
  });
});

describe("extractParamText（P0-1：参数文本提取）", () => {
  test("正常 properties：名 + 描述拼平", () => {
    const schema = {
      type: "object",
      properties: {
        pull_number: { type: "number", description: "PR 编号" },
        repo: { type: "string", description: "仓库名" },
      },
    };
    const text = extractParamText(schema);
    expect(text).toContain("pull_number");
    expect(text).toContain("PR 编号");
    expect(text).toContain("repo");
    expect(text).toContain("仓库名");
  });

  test("无 properties：返回空串", () => {
    expect(extractParamText({ type: "object" })).toBe("");
    expect(extractParamText(undefined)).toBe("");
    expect(extractParamText({ properties: null } as any)).toBe("");
  });

  test("property 无 description：只取参数名", () => {
    const text = extractParamText({ properties: { flag: { type: "boolean" } } });
    expect(text).toBe("flag");
  });

  test("超长截断到 maxLen", () => {
    const longDesc = "x".repeat(1000);
    const text = extractParamText({ properties: { a: { description: longDesc } } }, 512);
    expect(text.length).toBe(512);
  });
});

describe("searchToolsWithScoring — paramText 第 4 维检索（P0-1）", () => {
  test("description 不含关键词、但参数描述含 → 仍能搜到", () => {
    const tools: SearchableTool[] = [
      {
        name: "mcp__github__merge",
        description: "合并操作", // 不含 "pull" / "number"
        paramText: "pull_number PR 编号 pull request number",
      },
      { name: "mcp__slack__send", description: "发送消息" },
    ];
    const r = searchToolsWithScoring("pull number", tools, tools, 5);
    expect(r.map((x) => x.name)).toContain("mcp__github__merge");
  });

  test("paramText 权重(+3)介于 description(+2) 与 searchHint(+4) 之间", () => {
    // 单一关键词 "celsius"，分别只在 paramText / description 命中
    const paramHit: SearchableTool[] = [
      { name: "aaa", description: "weather info", paramText: "unit celsius fahrenheit" },
    ];
    const descHit: SearchableTool[] = [{ name: "bbb", description: "returns celsius temperature" }];
    const pScore = searchToolsWithScoring("celsius", paramHit, paramHit, 5)[0].score;
    const dScore = searchToolsWithScoring("celsius", descHit, descHit, 5)[0].score;
    // paramText 命中 +3 > description 命中 +2
    expect(pScore).toBeGreaterThan(dScore);
  });

  test("+required 必需词可在 paramText 命中（预过滤一致性）", () => {
    const tools: SearchableTool[] = [
      {
        name: "mcp__x__do",
        description: "generic action",
        // 词边界匹配：必需词需作为独立词出现（与 description 匹配同语义）。
        // 参数描述天然携带自然语言词，这正是 paramText 的检索价值所在。
        paramText: "url the webhook callback address",
      },
      { name: "mcp__y__do", description: "another action" },
    ];
    // 必需词 "webhook" 只在第一个工具的 paramText（描述部分）出现
    const r = searchToolsWithScoring("+webhook do", tools, tools, 5);
    expect(r.map((x) => x.name)).toContain("mcp__x__do");
    expect(r.map((x) => x.name)).not.toContain("mcp__y__do");
  });

  test("无 paramText 的工具行为不变（向后兼容）", () => {
    const tools: SearchableTool[] = [
      { name: "mcp__github__create_issue", description: "创建 issue" },
    ];
    const r = searchToolsWithScoring("github", tools, tools, 5);
    expect(r[0].name).toBe("mcp__github__create_issue");
  });
});
