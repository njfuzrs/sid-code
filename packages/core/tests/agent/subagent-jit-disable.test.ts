/**
 * 子代理 JIT 开关穿线（B2）
 *
 * 背景：`createJitDiscoverer(ctxMgr, jitDisabled = false)` 的第二参逻辑一直是对的
 * （`if (jitDisabled) return undefined`），但**唯一调用点从不传值** ——
 * 于是 `jitContext: false` 只关得住主代理，子代理照样注入。
 * 「做了但没接到底」的教科书形态：代码里看得见对应的机制，所以比「没实现」更难发现。
 *
 * 三条断言分别封住三个方向：
 *  1. 配了 `false` → 子代理必须**不注入**（这条是修复本体）
 *  2. 未设置 → 子代理必须**照常注入**（这条是 B3 默认值的**联合哨兵**：
 *     若默认值被反转成 false，只测第 1 条永远发现不了）
 *  3. registry 缺失 → 保持开启（`new SubAgent(...)` 直接构造的路径，不引入回归）
 *
 * 判据取 `buildBaseLoopConfig().discoverJitContext` 是否为 undefined ——
 * 这是 `runAgentLoop` 侧「是否触发 JIT」的**唯一**开关（loop 里 `if (discoverJitContext)`），
 * 所以它等价于端到端行为，不是间接指标。
 */

import { describe, test, expect } from "bun:test";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

/** 最小 provider —— 本测试只取 buildBaseLoopConfig 的字段，不真的跑 loop */
const stubProvider: Provider = {
  name: () => "mock",
  defaultModel: () => "mock-model",
  async *sendMessageStream(): AsyncIterable<StreamEvent> {
    yield { type: "message_stop" } as any;
  },
} as unknown as Provider;

function makeConfig(jitContext?: boolean): Config {
  return {
    provider: "mock",
    model: "mock-model",
    ...(jitContext === undefined ? {} : { jitContext }),
  } as unknown as Config;
}

/**
 * 取 `buildBaseLoopConfig` 产出的 `discoverJitContext`。
 * 该方法是 private，测试侧按 `any` 访问 —— 断言的是**生产接线**而非测试替身，
 * 这正是本次修复要钉住的东西（参数存在但没人传）。
 */
function jitDiscovererOf(agent: SubAgent): unknown {
  const ctxMgr = new ContextManager({ maxTokens: 200_000 });
  const cfg = (agent as any).buildBaseLoopConfig(ctxMgr, Date.now(), 60_000);
  return cfg.discoverJitContext;
}

function makeAgentWithRegistry(jitContext?: boolean): SubAgent {
  const registry = new ProviderRegistry(makeConfig(jitContext));
  const agent = new SubAgent(stubProvider, "mock-model", new ToolRegistry());
  (agent as any).registry = registry;
  return agent;
}

describe("B2 · 子代理 JIT 开关穿线", () => {
  test("jitContext: false → 子代理不注入 JIT", () => {
    expect(jitDiscovererOf(makeAgentWithRegistry(false))).toBeUndefined();
  });

  test("jitContext 未设置 → 子代理照常注入（B3 默认值的联合哨兵）", () => {
    // 若 JIT_CONTEXT_DEFAULT 被改成 false 或某处把 `?? true` 写成 `=== true`，
    // 这条会变红 —— 而只测「配了 false 能关掉」是抓不到的。
    expect(typeof jitDiscovererOf(makeAgentWithRegistry(undefined))).toBe("function");
  });

  test("jitContext: true → 子代理注入", () => {
    expect(typeof jitDiscovererOf(makeAgentWithRegistry(true))).toBe("function");
  });

  test("registry 缺失 → 保持开启（不引入回归）", () => {
    const agent = new SubAgent(stubProvider, "mock-model", new ToolRegistry());
    expect((agent as any).registry).toBeUndefined();
    expect(typeof jitDiscovererOf(agent)).toBe("function");
  });

  test("registry 是不完整替身（没有 getJitContextEnabled）→ 保持开启且不抛", () => {
    // 落地时**真的被这条绊倒过**：`ProviderRegistry` 在仓库里常被
    // `as unknown as ProviderRegistry` 强转的字面量替身充当（tests/agent/sub-agent.test.ts:81
    // 就是一个），类型层拦不住缺方法。第一版写成 `this.registry.getJitContextEnabled()`
    // 直接 TypeError，把两个无关的 SubAgentTool 用例打红。
    // 同文件的 `getSpawnConfig?.()` 早有同样的先例 —— registry 是接口位，不是完整实现的保证。
    const agent = new SubAgent(stubProvider, "mock-model", new ToolRegistry());
    (agent as any).registry = { getProvider: () => stubProvider } as any;
    expect(() => jitDiscovererOf(agent)).not.toThrow();
    expect(typeof jitDiscovererOf(agent)).toBe("function");
  });

  test("registry.getJitContextEnabled 读共享引用，运行时改配置即时生效", () => {
    // 与 getLanguage() 同构的约束：**不得**改成构造时快照拷贝。
    // 若有人把 registry 改成 `this.jitEnabled = isJitContextEnabled(config)` 存字段，
    // 这条会变红。
    const config = makeConfig(undefined);
    const registry = new ProviderRegistry(config);
    expect(registry.getJitContextEnabled()).toBe(true);
    (config as any).jitContext = false;
    expect(registry.getJitContextEnabled()).toBe(false);
  });
});
