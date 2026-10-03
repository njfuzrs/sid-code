/**
 * D60：`sid-code agents` 对内置 summarize 曾显示「工具: (全部)」，官网表格照抄成「全部」。
 * 真实情况相反：filterToolsForAgent 对 summarize 直接 return []（core/agent/tool-filter.ts），零工具。
 * 根因是 tools 字段为空时统一渲染成「(全部)」，而 summarize 的「空」语义是「无」。
 */
import { describe, expect, test } from "bun:test";
import { handleAgentsCommand } from "../../src/command/agents.ts";
import { filterToolsForAgent } from "@sid-code/core/agent/tool-filter.ts";

async function captureJson(): Promise<Array<{ name: string; tools: string }>> {
  const orig = console.log;
  const out: string[] = [];
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    await handleAgentsCommand(["--json"]);
  } finally {
    console.log = orig;
  }
  return JSON.parse(out.join("\n"));
}

describe("D60 · agents 列表的 summarize 工具集", () => {
  test("运行时 summarize 确实零工具（列表口径的事实依据）", () => {
    const fake = [{ name: () => "read" }, { name: () => "bash" }] as never[];
    expect(
      filterToolsForAgent(fake, { isBuiltIn: true, builtInType: "summarize" } as never),
    ).toEqual([]);
  });

  test("列表里 summarize 显示「无」，其他类型不受影响", async () => {
    const rows = await captureJson();
    const summarize = rows.find((r) => r.name === "summarize");
    const gp = rows.find((r) => r.name === "general-purpose");
    expect(summarize?.tools).toBe("(无，纯文本)");
    // general-purpose 定义里是 ["*"]，原样显示，不能被这次特判波及
    expect(gp?.tools).toBe("*");
  });
});
