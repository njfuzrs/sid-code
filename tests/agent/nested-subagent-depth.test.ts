/**
 * P3-1：嵌套子代理受控放开（深度上限 + 全树并发）单测
 *
 * 覆盖：
 * - 默认（开关未开）行为与改造前一致：depth 0 可 spawn，depth ≥ 1 一律拒绝
 * - 开启后：depth < 上限可 spawn，达上限拒绝且给出可操作的说明
 * - env 上限解析：非法值回退、且永不超过 MAX_AGENT_DEPTH 硬顶
 * - withIncrementedDepth 跨 await 不丢深度、并发不串台
 * - tool-filter：未开启时裁掉 sub_agent（省 token），开启后保留在池里交给运行时裁决
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  MAX_AGENT_DEPTH,
  canSpawnSubAgent,
  describeSpawnRejection,
  getAgentDepth,
  isNestedSubAgentEnabled,
  resolveMaxDepth,
  withIncrementedDepth,
} from "@sid-code/core/agent/depth-context.ts";
import { filterToolsForAgent } from "@sid-code/core/agent/tool-filter.ts";

const ENV_KEY = "SID_ENABLE_NESTED_SUBAGENT";
const DEPTH_KEY = "SID_SUBAGENT_MAX_DEPTH";

afterEach(() => {
  delete process.env[ENV_KEY];
  delete process.env[DEPTH_KEY];
});

describe("默认关闭：行为与改造前一致", () => {
  it("主代理（depth 0）可以 spawn", () => {
    expect(getAgentDepth()).toBe(0);
    expect(canSpawnSubAgent()).toBe(true);
  });

  it("子代理（depth 1）不可 spawn，拒绝语与旧文案一致", () => {
    withIncrementedDepth(() => {
      expect(getAgentDepth()).toBe(1);
      expect(canSpawnSubAgent()).toBe(false);
      expect(describeSpawnRejection()).toContain("不允许嵌套");
    });
  });

  it("isNestedSubAgentEnabled 默认 false，仅 1/true 开启", () => {
    expect(isNestedSubAgentEnabled(undefined)).toBe(false);
    expect(isNestedSubAgentEnabled("")).toBe(false);
    expect(isNestedSubAgentEnabled("0")).toBe(false);
    expect(isNestedSubAgentEnabled("yes")).toBe(false);
    expect(isNestedSubAgentEnabled("1")).toBe(true);
    expect(isNestedSubAgentEnabled("true")).toBe(true);
  });
});

describe("开启后：按深度上限放行", () => {
  it("depth 1 < 上限 2 → 放行；depth 2 = 上限 → 拒绝", () => {
    process.env[ENV_KEY] = "1";
    withIncrementedDepth(() => {
      expect(getAgentDepth()).toBe(1);
      expect(canSpawnSubAgent()).toBe(true);

      withIncrementedDepth(() => {
        expect(getAgentDepth()).toBe(2);
        expect(canSpawnSubAgent()).toBe(false);
        // 达上限的拒绝语要能指导模型改换策略（自己做完 / 上报给上层）
        const msg = describeSpawnRejection();
        expect(msg).toContain("深度上限");
        expect(msg).toContain("2");
      });
    });
  });

  it("env 上限：非法值回退硬顶，且不能超过硬顶", () => {
    expect(resolveMaxDepth(undefined)).toBe(MAX_AGENT_DEPTH);
    expect(resolveMaxDepth("")).toBe(MAX_AGENT_DEPTH);
    expect(resolveMaxDepth("abc")).toBe(MAX_AGENT_DEPTH);
    expect(resolveMaxDepth("0")).toBe(MAX_AGENT_DEPTH);
    expect(resolveMaxDepth("-3")).toBe(MAX_AGENT_DEPTH);
    // 关键：env 调大也被封顶（防误配指数爆炸）
    expect(resolveMaxDepth("99")).toBe(MAX_AGENT_DEPTH);
    expect(resolveMaxDepth("1")).toBe(1);
  });

  it("上限设为 1 时，子代理层即拒绝", () => {
    process.env[ENV_KEY] = "1";
    process.env[DEPTH_KEY] = "1";
    withIncrementedDepth(() => {
      expect(canSpawnSubAgent()).toBe(false);
    });
  });
});

describe("深度上下文并发安全", () => {
  it("跨 await 不丢深度", async () => {
    await withIncrementedDepth(async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getAgentDepth()).toBe(1);
    });
    // 退出上下文后回到 0
    expect(getAgentDepth()).toBe(0);
  });

  it("并发分支各自深度独立（不串台）", async () => {
    await Promise.all([
      withIncrementedDepth(async () => {
        await new Promise((r) => setTimeout(r, 8));
        expect(getAgentDepth()).toBe(1);
      }),
      withIncrementedDepth(async () =>
        withIncrementedDepth(async () => {
          await new Promise((r) => setTimeout(r, 3));
          expect(getAgentDepth()).toBe(2);
        }),
      ),
    ]);
    expect(getAgentDepth()).toBe(0);
  });
});

describe("tool-filter 与嵌套开关联动", () => {
  const fakeTool = (name: string) => ({ name: () => name }) as any;
  const tools = [fakeTool("sub_agent"), fakeTool("read")];
  const names = (l: any[]) => l.map((t) => t.name());

  it("未开启 → sub_agent 从子代理工具池裁掉（不让模型白试）", () => {
    const kept = names(filterToolsForAgent(tools, { isBuiltIn: true, builtInType: "general-purpose" }));
    expect(kept).not.toContain("sub_agent");
    expect(kept).toContain("read");
  });

  it("开启 → sub_agent 保留在池里（交给运行时深度裁决）", () => {
    process.env[ENV_KEY] = "1";
    const kept = names(filterToolsForAgent(tools, { isBuiltIn: true, builtInType: "general-purpose" }));
    expect(kept).toContain("sub_agent");
  });

  it("开启 + 自定义 agent 也保留（自定义 agent 不再被额外硬禁）", () => {
    process.env[ENV_KEY] = "1";
    const kept = names(filterToolsForAgent(tools, { isBuiltIn: false }));
    expect(kept).toContain("sub_agent");
  });

  it("用户显式 disallowedTools 始终能禁掉（Layer 3 优先于嵌套开关）", () => {
    process.env[ENV_KEY] = "1";
    const kept = names(filterToolsForAgent(tools, { isBuiltIn: false, disallowedTools: ["sub_agent"] }));
    expect(kept).not.toContain("sub_agent");
  });
});
