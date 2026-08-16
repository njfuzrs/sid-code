/**
 * spawn 子代理跨进程 compat 传递 —— 用户声明在子代理里静默失效的防回退。
 *
 * 缺陷形态与 `subagent-wire-model.test.ts` **逐条同构**（那份写得更细）：
 * spawn 出的子代理是独立 OS 进程，不读 settings.json、不跑 loadConfig，因此
 * `llm/model-compat.ts` 的进程级表在子进程里恒为空。父进程不播种的话：
 * **父按用户声明发字段、子按内置判定发字段 —— 同一份配置两种行为，且都不报错。**
 *
 * 故障只在「用了 spawn 子代理 + 配了 compat」这一格出现，且父子进程日志分离。
 *
 * 两道防线各测一遍：
 *   ① `getSpawnConfigForSubAgent().modelCompat`：父进程从配置现算整张表随 init 传过去；
 *   ② 子进程 `setModelCompatFromMap` 播种：让本进程内任何路径（含 ModelFallback
 *      换模型后的降级目标）都自动查得到声明，而不是依赖「每个调用点都记得传」。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import {
  setModelCompatFromMap,
  lookupModelCompat,
  resetModelCompat,
} from "@sid-code/core/llm/model-compat.ts";
import type { ParentInitMessage } from "@sid-code/core/agent/sub-agent-protocol.ts";

beforeEach(() => resetModelCompat());
afterEach(() => resetModelCompat());

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(),
    provider: "openai",
    model: "main-gw",
    openaiKey: "sk-test",
    baseURL: "https://api.test.com/v1",
    availableModels: [
      {
        name: "main-gw",
        modelId: "deepseek-chat",
        provider: "openai",
        compat: { supportsThinkingToggle: false },
      },
      {
        name: "cheap-gw",
        modelId: "glm-5",
        provider: "openai",
        baseURL: "https://api.cheap.com/v1",
        compat: { toolChoiceAutoOnly: true },
      },
      { name: "plain-model", provider: "openai" },
    ] as any,
    ...overrides,
  };
}

/** 复刻 headless.ts 收到 init 后的播种逻辑（与 packages/cli/src/entrypoints/headless.ts 同构） */
function seedFromInit(init: Pick<ParentInitMessage, "model_compat">): void {
  if (init.model_compat) setModelCompatFromMap(init.model_compat);
}

describe("防线①：modelCompat 随 spawn 配置过管道", () => {
  test("父进程给出**整张**表，不只是本次要发的那条模型", () => {
    const registry = new ProviderRegistry(testConfig(), { explore: "cheap-gw" });
    const sc = registry.getSpawnConfigForSubAgent("explore");
    expect(sc.model).toBe("cheap-gw");
    // 关键：主模型 main-gw 的声明也在表里。子进程内 ModelFallback 降级会换模型，
    // 只播种「本次这条」的话降级目标查不到声明 → 按内置判定发字段 → 用户声明失效。
    expect(sc.modelCompat).toEqual({
      "main-gw": { supportsThinkingToggle: false },
      "cheap-gw": { toolChoiceAutoOnly: true },
    });
  });

  test("子代理模型 = 主模型时同样带整张表（复用主 spawn 配置那条分支）", () => {
    const registry = new ProviderRegistry(testConfig());
    const sc = registry.getSpawnConfigForSubAgent("explore");
    expect(sc.model).toBe("main-gw");
    expect(sc.modelCompat?.["cheap-gw"]).toEqual({ toolChoiceAutoOnly: true });
  });

  test("没配 compat 的用户：字段整个缺省（管道零多余字节）", () => {
    const registry = new ProviderRegistry(
      testConfig({
        availableModels: [{ name: "main-gw", provider: "openai" }] as any,
      }),
    );
    expect(registry.getSpawnConfigForSubAgent("explore").modelCompat).toBeUndefined();
  });

  test("从配置现算，不依赖 resolveCurrentModelConfig 是否跑过", () => {
    // 本方法可能在任何时机被调；读全局表就会拿到空表。故这里刻意**不**先跑注册。
    expect(lookupModelCompat("main-gw")).toBeUndefined(); // 全局表确实是空的
    const registry = new ProviderRegistry(testConfig());
    expect(registry.getSpawnConfigForSubAgent("explore").modelCompat).toBeDefined();
    // 且构造过程没有污染全局表（buildModelCompatMap 不写全局）。
    expect(lookupModelCompat("main-gw")).toBeUndefined();
  });
});

describe("防线②：子进程按 init 播种后，进程内任何路径都查得到", () => {
  test("播种后主模型与降级目标的声明都在", () => {
    const registry = new ProviderRegistry(testConfig(), { explore: "cheap-gw" });
    const sc = registry.getSpawnConfigForSubAgent("explore");

    // 模拟子进程：表本来是空的
    expect(lookupModelCompat("cheap-gw")).toBeUndefined();
    seedFromInit({ model_compat: sc.modelCompat });

    expect(lookupModelCompat("cheap-gw")).toEqual({ toolChoiceAutoOnly: true });
    // 降级目标同样查得到 —— 这是传整张表而非单条的全部理由。
    expect(lookupModelCompat("main-gw")).toEqual({ supportsThinkingToggle: false });
  });

  test("老版本父进程不发该字段 → 表为空、行为与此前一致（向后兼容）", () => {
    expect(() => seedFromInit({ model_compat: undefined })).not.toThrow();
    expect(lookupModelCompat("main-gw")).toBeUndefined();
  });

  test("脏 payload 不让子进程起不来", () => {
    expect(() => seedFromInit({ model_compat: { a: "nope" } as any })).not.toThrow();
    expect(lookupModelCompat("a")).toBeUndefined();
  });
});
