/**
 * `consumesAgentId` 自报的双向对账审计（2026-11-04，B1）
 *
 * 背景：子代理 / forked 两条执行路径过去把 `_agentId` **无条件**注入每一次工具入参，
 * 导致内部字段泄进 `StructuredOutput` 的 schema 校验、workflow 的结果、以及 MCP server
 * 的 arguments（实测见 docs-research 的
 * 《20261104-子代理_agentId泄入工具入参与workflow-phases形态未说明-落地方案.md》）。
 * 修法是按需注入（契约见 `src/tool/types.ts` 的 `consumesAgentId`）。
 *
 * 但「自报」本身会漂移，且**两个方向都是缺陷**：
 *   - 漏声明（fail-open）：`enter_plan_mode` 收不到 `_agentId` → 子代理能进规划态；
 *     `save_memory` 收不到 → 所有来源都记成 main，遥测数字静默变错。
 *   - 多声明（fail-leak）：把 `consumesAgentId` 加到 `StructuredOutput` / MCP 这类
 *     「按原始 input 做事」的工具上 → 本轮修掉的泄漏原样复发。
 *
 * 所以本审计织三张网（与 `loop-detection-exemption-audit.test.ts`、
 * `jit-affected-paths-audit.test.ts` 同一范式：把该维护的清单变成 CI 硬错误）：
 *   1. 【实例对账】三个消费者真实实例化，断言都自报 `consumesAgentId === true`，
 *      且声明集合与清单完全相等（多一个少一个都红）。
 *   2. 【源码扫描·无遗漏】`src/tool/` 与 `src/agent/` 下凡**读 `_agentId` 的工具实现**，
 *      都必须在清单里且源码里确实声明了。
 *   3. 【注入点形态】两个执行器的注入必须被 `tool.consumesAgentId` 条件包裹——
 *      防「有人顺手改回无条件注入」而前面两张网看不出来（工具侧声明还在，注入却照旧）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { MemoryTool } from "@sid-code/core/tool/memory.ts";
import { MemoryStore } from "@sid-code/core/memory/store.ts";
import { StructuredOutputTool } from "@sid-code/core/tool/structured-output-tool.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";

/**
 * 落盘隔离：本文件实例化 `MemoryStore`（构造即落盘类，写
 * `~/.sid-code/projects/<项目哈希>/memory/`）。虽然下面构造实例时传了 tmpdir 派生路径，
 * 但 `no-real-path-writes.test.ts` 的判据是「文本里真的碰了 `process.env.SID_CONFIG_DIR`」——
 * 注释里提到变量名不算隔离。这里显式设一遍，同时也防未来有人把显式路径改成默认构造。
 *
 * 必须存/恢复原值，不要无条件 delete：`bun test` 同批多文件共进程，
 * 直接删会把 preload 的兜底一起抹掉，后续文件静默写真实 home。
 */
const savedConfigDir = process.env.SID_CONFIG_DIR;
let configDir: string;

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "sid-audit-config-"));
  process.env.SID_CONFIG_DIR = configDir;
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判定 */
  }
});

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const TOOL_SRC_DIRS = [
  join(REPO_ROOT, "packages", "core", "src", "tool"),
  join(REPO_ROOT, "packages", "core", "src", "agent"),
];

/**
 * 声明读 `_agentId` 的完整工具清单。新增一条必须回答：
 * 「这个工具为什么需要知道自己在子代理里？」答不上来就不要加。
 */
const CONSUMES_AGENT_ID = ["enter_plan_mode", "save_memory", "sub_agent"] as const;

/** 从工具源文件里抽出 `name(): string { return "xxx" }` 的工具名（与 JIT 审计同一正则） */
function extractToolName(source: string): string | null {
  const m = source.match(/name\(\)\s*:\s*string\s*\{\s*return\s*"([a-z_]+)"/);
  return m ? m[1]! : null;
}

interface ToolFacts {
  tool: string;
  file: string;
  /** 源码里是否出现 `_agentId`（含注释——宁严勿松） */
  mentionsAgentId: boolean;
  declares: boolean;
}

function collectToolFacts(): ToolFacts[] {
  const out: ToolFacts[] = [];
  for (const dir of TOOL_SRC_DIRS) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const file = join(dir, f);
      const source = readFileSync(file, "utf8");
      const tool = extractToolName(source);
      if (!tool) continue;
      out.push({
        tool,
        file,
        mentionsAgentId: source.includes("_agentId"),
        // 只认「声明成 true」；注释里提到字段名不算声明
        declares: /consumesAgentId\s*=\s*true/.test(source),
      });
    }
  }
  return out;
}

const FACTS = collectToolFacts();

function makeConsumerInstances(): Array<{ name: string; declares: boolean }> {
  const planManager = new PlanModeManager();
  const providerRegistry = new ProviderRegistry({ provider: "anthropic", model: "test" } as any);
  const toolRegistry = new ToolRegistry();
  // MemoryTool 构造函数不落盘，路径只是后续写入时用；给 tmpdir 派生值避免任何真实 home 路径。
  const memoryStore = new MemoryStore(mkdtempSync(join(tmpdir(), "sid-audit-")));

  const instances: Array<{ name(): string; consumesAgentId?: true }> = [
    new EnterPlanModeTool(planManager),
    new MemoryTool(memoryStore),
    new SubAgentTool(providerRegistry, toolRegistry),
  ];
  return instances.map((t) => ({ name: t.name(), declares: t.consumesAgentId === true }));
}

describe("B1 consumesAgentId：与真实工具双向对账", () => {
  test("扫描到了工具源码（防正则失配导致审计空跑通过）", () => {
    expect(FACTS.length).toBeGreaterThan(20);
    expect(FACTS.some((f) => f.tool === "read")).toBe(true);
    // 三个消费者的文件必须被扫到，否则下面的「无遗漏」是在空集上通过
    for (const name of CONSUMES_AGENT_ID) {
      expect(
        FACTS.some((f) => f.tool === name),
        `扫描结果里缺少工具 ${name}`,
      ).toBe(true);
    }
  });

  test("【实例对账】三个消费者都自报 consumesAgentId=true", () => {
    const instances = makeConsumerInstances();
    expect(instances.map((i) => i.name).sort()).toEqual([...CONSUMES_AGENT_ID].sort());
    for (const { name, declares } of instances) {
      expect(declares, `工具 ${name} 应自报 consumesAgentId=true`).toBe(true);
    }
  });

  test("【无遗漏】源码里读 _agentId 的工具都必须在清单里且确实声明", () => {
    const readers = FACTS.filter((f) => f.mentionsAgentId);
    const missing = readers.filter(
      (f) => !(CONSUMES_AGENT_ID as readonly string[]).includes(f.tool) || !f.declares,
    );
    const detail = missing.map((f) => `  - ${f.tool} (${f.file}) 声明=${f.declares}`).join("\n");
    expect(
      missing.length,
      missing.length === 0
        ? ""
        : `以下工具源码读了 _agentId，但没在 CONSUMES_AGENT_ID 清单里正确声明：\n${detail}\n` +
            `请二选一：① 保留读取 → 在工具类里加 \`readonly consumesAgentId = true as const;\` ` +
            `并登记进本文件的 CONSUMES_AGENT_ID；② 不读 → 删掉对 _agentId 的依赖（推荐）。`,
    ).toBe(0);
  });

  test("【无多余】清单里的每个工具都真实存在", () => {
    for (const name of CONSUMES_AGENT_ID) {
      expect(
        FACTS.some((f) => f.tool === name),
        `清单里的 ${name} 在源码中不存在（工具已删/改名？请同步清单）`,
      ).toBe(true);
    }
  });

  test("StructuredOutput 不声明（它就是被无差别注入坑到的那个工具）", () => {
    const tool = new StructuredOutputTool({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
    expect((tool as any).consumesAgentId).toBeUndefined();
  });
});

describe("B1 注入点形态：必须被 consumesAgentId 条件包裹", () => {
  /** 断言注入行出现在 `tool.consumesAgentId` 判断之后（顺序即"被条件包裹"的证据） */
  function assertGuarded(file: string, injection: string) {
    const source = readFileSync(file, "utf8");
    const guardAt = source.indexOf("tool.consumesAgentId");
    const injectAt = source.indexOf(injection);
    expect(guardAt, `${file} 里找不到 tool.consumesAgentId 判断`).toBeGreaterThan(-1);
    expect(injectAt, `${file} 里找不到注入语句 ${injection}`).toBeGreaterThan(-1);
    expect(
      guardAt,
      `${file} 的注入没有被 tool.consumesAgentId 包裹（无条件注入会让内部字段外泄）`,
    ).toBeLessThan(injectAt);
  }

  test("run-tool-use.ts（子代理 / spawn 两条路径共用的执行器）", () => {
    assertGuarded(
      join(REPO_ROOT, "packages/core/src/query/run-tool-use.ts"),
      '_agentId = "sub-agent"',
    );
  });

  test("forked-agent.ts（后台 forked 代理路径）", () => {
    assertGuarded(
      join(REPO_ROOT, "packages/core/src/agent/forked-agent.ts"),
      '_agentId: "forked-agent"',
    );
  });

  test("bridge 透传 consumesAgentId（新接口工具注册后仍能被执行器看到）", () => {
    const source = readFileSync(join(REPO_ROOT, "packages/core/src/tool/bridge.ts"), "utf8");
    expect(source).toContain("consumesAgentId: true,");
  });
});
