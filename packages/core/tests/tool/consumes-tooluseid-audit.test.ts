/**
 * `consumesToolUseId` 自报的双向对账审计（R3，2026-11-12）
 *
 * 背景：事故 b0aa0f1e —— 模型挂完一次等待后，把**上一轮**那条 `<task-notification>`
 * 当成刚挂这次等待的结果，后续每个请求的 thinking 都在复述「sjgm4oq76 又被杀了」。
 * 通知里当时只有 task-id / status / summary，模型没有任何能与「我刚刚这次调用」对齐的锚点。
 * 修法是让执行器按需注入 `_toolUseId`，后台任务把它存进 task，通知因此能带
 * `<tool-use-id>`（契约见 `src/tool/types.ts` 的 `consumesToolUseId`）。
 *
 * 「自报」会漂移，且两个方向都是缺陷：
 *   - 漏声明（fail-silent）：`bash` 漏了 → 通知少了锚点，模型照旧只能凭叙事猜，
 *     而**构建不报错、其它测试也不会红**（锚点是增强信息，不是正确性依赖）。
 *   - 多声明（fail-leak）：给 `StructuredOutput` / MCP 这类按原始 input 做事的工具加上
 *     → `_toolUseId` 泄进严格 schema 校验与 MCP server 的 arguments。
 *
 * 三张网（与 `consumes-agentid-audit.test.ts` 同范式）：
 *   1. 【实例对账】bash / monitor 真实实例化，断言都自报 `consumesToolUseId === true`。
 *   2. 【源码扫描·无遗漏】`src/tool/` 下凡**读 `_toolUseId` 的工具实现**，都必须声明。
 *   3. 【注入点形态】两个执行器的注入必须被 `tool.consumesToolUseId` 条件包裹。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BashTool } from "@sid-code/core/tool/bash.ts";
import { MonitorTool } from "@sid-code/core/tool/monitor.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const TOOL_SRC_DIR = join(REPO_ROOT, "packages", "core", "src", "tool");

/**
 * 声明读 `_toolUseId` 的完整工具清单。新增一条必须回答：
 * 「这个工具为什么需要知道本次调用 id？」——答不上来就不要加。
 */
const CONSUMES_TOOL_USE_ID = ["bash", "monitor"] as const;

/** 从工具源文件里抽出工具名（新旧两种接口形态都认） */
function extractToolName(source: string): string | null {
  // 旧接口：name(): string { return "xxx" }
  const legacy = source.match(/name\(\)\s*:\s*string\s*\{\s*return\s*"([a-z_]+)"/);
  if (legacy) return legacy[1]!;
  // 新接口：readonly name = "xxx"
  const modern = source.match(/readonly\s+name\s*=\s*"([a-z_]+)"/);
  return modern ? modern[1]! : null;
}

interface ToolFacts {
  tool: string;
  file: string;
  /** 源码里是否出现 `_toolUseId`（含注释——宁严勿松） */
  mentionsToolUseId: boolean;
  declares: boolean;
}

function collectToolFacts(): ToolFacts[] {
  const out: ToolFacts[] = [];
  for (const f of readdirSync(TOOL_SRC_DIR)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const file = join(TOOL_SRC_DIR, f);
    const source = readFileSync(file, "utf8");
    const tool = extractToolName(source);
    if (!tool) continue;
    out.push({
      tool,
      file,
      mentionsToolUseId: source.includes("_toolUseId"),
      // 只认「声明成 true」；注释里提到字段名不算声明
      declares: /consumesToolUseId\s*=\s*true/.test(source),
    });
  }
  return out;
}

const FACTS = collectToolFacts();

describe("R3 consumesToolUseId：与真实工具双向对账", () => {
  test("扫描到了工具源码（防正则失配导致审计空跑通过）", () => {
    expect(FACTS.length).toBeGreaterThan(20);
    expect(FACTS.some((f) => f.tool === "read")).toBe(true);
    for (const name of CONSUMES_TOOL_USE_ID) {
      expect(
        FACTS.some((f) => f.tool === name),
        `扫描结果里缺少工具 ${name}`,
      ).toBe(true);
    }
  });

  test("【实例对账】bash / monitor 都自报 consumesToolUseId=true", () => {
    const bash = new BashTool();
    const monitor = new MonitorTool();
    // bash 走旧接口（name 是方法），monitor 走新接口（name 是属性）——两种都要覆盖，
    // 它们分别经 legacy 直存与 bridge 转发两条路径进入执行器。
    expect(
      typeof bash.name === "function" ? bash.name() : bash.name,
      "bash 应声明 consumesToolUseId=true",
    ).toBe("bash");
    expect((bash as { consumesToolUseId?: true }).consumesToolUseId).toBe(true);
    expect(monitor.name).toBe("monitor");
    expect(monitor.consumesToolUseId).toBe(true);
  });

  test("【无遗漏】源码里读 _toolUseId 的工具都必须声明", () => {
    // `internal-fields.ts` 是字段名单本身（含字段名字面量），不算消费者；
    // `types.ts` / `bridge.ts` 是契约与透传表，同样不算。它们由 extractToolName 天然排除
    // （没有工具名），这里显式断言一下，防止将来有人给它们加个 name 就被误纳入。
    const readers = FACTS.filter((f) => f.mentionsToolUseId);
    const missing = readers.filter(
      (f) => !(CONSUMES_TOOL_USE_ID as readonly string[]).includes(f.tool) || !f.declares,
    );
    const detail = missing.map((f) => `  - ${f.tool} (${f.file}) 声明=${f.declares}`).join("\n");
    expect(
      missing.length,
      missing.length === 0
        ? ""
        : `以下工具源码读了 _toolUseId，但没在 CONSUMES_TOOL_USE_ID 清单里正确声明：\n${detail}\n` +
            `请二选一：① 保留读取 → 在工具类里加 \`readonly consumesToolUseId = true as const;\` ` +
            `并登记进本文件的 CONSUMES_TOOL_USE_ID；② 不读 → 删掉对 _toolUseId 的依赖。`,
    ).toBe(0);
  });

  test("【无多余】清单里的每个工具都真实存在", () => {
    for (const name of CONSUMES_TOOL_USE_ID) {
      expect(
        FACTS.some((f) => f.tool === name),
        `清单里的 ${name} 在源码中不存在（工具已删/改名？请同步清单）`,
      ).toBe(true);
    }
  });
});

describe("R3 注入点形态：必须被 consumesToolUseId 条件包裹", () => {
  /** 断言注入行出现在 `tool.consumesToolUseId` 判断之后（顺序即"被条件包裹"的证据） */
  function assertGuarded(file: string, injection: string) {
    const source = readFileSync(file, "utf8");
    const guardAt = source.indexOf("tool.consumesToolUseId");
    const injectAt = source.indexOf(injection);
    expect(guardAt, `${file} 里找不到 tool.consumesToolUseId 判断`).toBeGreaterThan(-1);
    expect(injectAt, `${file} 里找不到注入语句 ${injection}`).toBeGreaterThan(-1);
    expect(
      guardAt,
      `${file} 的注入没有被 tool.consumesToolUseId 包裹（无条件注入会让内部字段外泄）`,
    ).toBeLessThan(injectAt);
  }

  test("run-tool-use.ts（子代理 / spawn 两条路径共用的执行器）", () => {
    assertGuarded(
      join(REPO_ROOT, "packages/core/src/query/run-tool-use.ts"),
      "internalFields._toolUseId = block.id",
    );
  });

  test("tool-executor.ts（主循环路径）", () => {
    assertGuarded(
      join(REPO_ROOT, "packages/core/src/query/tool-executor.ts"),
      "_toolUseId: block.id",
    );
  });

  test("bridge 透传 consumesToolUseId（新接口工具注册后仍能被执行器看到）", () => {
    const source = readFileSync(join(REPO_ROOT, "packages/core/src/tool/bridge.ts"), "utf8");
    expect(source).toContain("consumesToolUseId: true,");
  });

  test("_toolUseId 在内部字段剥离名单里（模型伪造会被剥掉）", () => {
    const source = readFileSync(
      join(REPO_ROOT, "packages/core/src/tool/internal-fields.ts"),
      "utf8",
    );
    expect(source).toContain('"_toolUseId"');
  });
});
