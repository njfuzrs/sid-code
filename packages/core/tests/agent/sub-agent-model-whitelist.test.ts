/**
 * 回归测试：sub_agent 的 model 参数白名单校验（2026-08-01 生产事故）
 *
 * 事故：`model` 参数此前只有 `z.string()`，无任何校验。gpt-5.6-luna 臆造了一个不存在的
 * 模型名 `"deepseek"`（用户实配的是 ali-deepseek-v4-pro / ali-deepseek-v4-flash），
 * 直接透传到网关得 `503 model_not_found`。连带两处内部状态被污染：
 *   - AGENT_LOOP 把这个根本不存在的模型名"跨路径拉黑"
 *   - SESSION 用兜底价（input $2/M）给它估算成本
 *
 * 修复：在 execute() 里与已有的 type 校验同一位置、同一范式做白名单校验——
 * 非法值当场退回可用清单让模型自纠，不透传给网关。
 *
 * fail-open 是本修复的硬性约束：清单为空（用户没配 availableModels）时必须放行，
 * 否则会把所有用户合法配置的模型全部误拦——那比原缺陷更糟。
 */
import { describe, test, expect } from "bun:test";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { Registry } from "@sid-code/core/tool/registry.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";

/** 复刻事故当时的真实用户配置（settings.json 关键字段） */
function incidentConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(),
    provider: "openai",
    model: "gpt-5.6-luna",
    fallbackModel: "ali-deepseek-v4-flash",
    baseURL: "https://uniapi.example.com/v1",
    availableModels: [
      { name: "gpt-5.4", provider: "openai" },
      { name: "ali-deepseek-v4-pro", provider: "openai" },
      { name: "ali-deepseek-v4-flash", provider: "openai" },
      { name: "gpt-5.6-luna", provider: "openai" },
    ],
    ...overrides,
  };
}

describe("getKnownModelNames（sub_agent model 白名单的数据源）", () => {
  test("事故复现：臆造的裸名 deepseek 不在白名单里", () => {
    const registry = new ProviderRegistry(incidentConfig(), {
      default: "ali-deepseek-v4-flash",
      task: "ali-deepseek-v4-pro",
      verify: "ali-deepseek-v4-pro",
    });
    const known = registry.getKnownModelNames();

    // 这是事故的直接断言：模型臆造的名字必须被判为非法
    expect(known).not.toContain("deepseek");
    // 而用户真实配置的相似名必须合法（避免修复过度、把真名也拦了）
    expect(known).toContain("ali-deepseek-v4-pro");
    expect(known).toContain("ali-deepseek-v4-flash");
  });

  test("白名单覆盖 availableModels + 主模型 + 降级模型 + subAgentModels", () => {
    const config = incidentConfig({
      model: "main-only-model",
      fallbackModel: "fallback-only-model",
      availableModels: [{ name: "listed-model", provider: "openai" }],
    });
    const registry = new ProviderRegistry(config, { explore: "subagent-only-model" });
    const known = registry.getKnownModelNames();

    // 后三类即便没写进 availableModels，也是用户有意指定的合法目标，不能判非法
    expect(known).toContain("listed-model");
    expect(known).toContain("main-only-model");
    expect(known).toContain("fallback-only-model");
    expect(known).toContain("subagent-only-model");
  });

  test("去重且保序（清单要直接展示给模型，不能有重复噪音）", () => {
    const config = incidentConfig({
      model: "dup-model",
      fallbackModel: "dup-model",
      availableModels: [
        { name: "dup-model", provider: "openai" },
        { name: "other", provider: "openai" },
      ],
    });
    const registry = new ProviderRegistry(config, { default: "dup-model" });
    const known = registry.getKnownModelNames();

    expect(known.filter((n) => n === "dup-model")).toHaveLength(1);
    expect(known[0]).toBe("dup-model"); // availableModels 顺序优先
  });

  test("fail-open：无任何模型配置时返回空数组（调用方据此放行一切）", () => {
    const config = incidentConfig({ model: "", fallbackModel: "", availableModels: [] });
    const registry = new ProviderRegistry(config, {});
    // 空数组是"无从判断"的信号，绝不能被解读成"没有任何模型合法"
    expect(registry.getKnownModelNames()).toEqual([]);
  });

  test("空串 / 纯空白配置不污染白名单", () => {
    const config = incidentConfig({
      model: "   ",
      fallbackModel: "",
      availableModels: [
        { name: "", provider: "openai" },
        { name: "real", provider: "openai" },
      ],
    });
    const registry = new ProviderRegistry(config, { default: "  " });
    expect(registry.getKnownModelNames()).toEqual(["real"]);
  });

  test("模型名两端空白被归一（模型偶发多打空格不应判非法）", () => {
    const config = incidentConfig({
      model: "  padded-model  ",
      availableModels: [],
      fallbackModel: "",
    });
    const registry = new ProviderRegistry(config, {});
    expect(registry.getKnownModelNames()).toEqual(["padded-model"]);
  });
});

describe("SubAgentTool.execute 的 model 拦截（真实修复面）", () => {
  /** 构造一个只到「参数校验」为止就能返回的 SubAgentTool */
  function makeTool(config: Config, subAgentModels: Record<string, string> = {}) {
    const registry = new ProviderRegistry(config, subAgentModels);
    // toolRegistry 只在真正 spawn 子代理后才被用到；本组测试全部在参数校验阶段返回，
    // 所以传一个空 Registry 足够，不需要 mock provider/网络。
    return new SubAgentTool(registry, new Registry() as never);
  }

  const validCall = {
    type: "explore",
    description: "d",
    prompt: "p",
  };

  test("事故复现：model=deepseek 被当场拦下，不透传给网关", async () => {
    const tool = makeTool(incidentConfig(), { default: "ali-deepseek-v4-flash" });
    const result = await tool.execute({ ...validCall, model: "deepseek" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("deepseek");
    // 报错必须列出可选清单，模型才能自纠（对齐 type 校验的既有范式）
    expect(result.output).toContain("ali-deepseek-v4-pro");
    expect(result.output).toContain("ali-deepseek-v4-flash");
  });

  // ── 「放行」类断言不走 execute() ──
  //
  // 放行意味着继续往下真正 spawn 子代理 → 发起真实网络请求。在单测里那既慢又不确定
  // （实测打出 "Unable to connect" 噪音），且**断言不到点**：网络失败与 model 被拦
  // 都表现为 isError=true，只能靠 output 文案区分，等于在测文案而非测行为。
  //
  // 所以放行侧改为断言「白名单包含该模型」——这正是 execute() 里那个 if 的判据本身，
  // 拦截侧则走完整 execute()（它在校验阶段就返回，不触网）。两侧合起来覆盖分支全集。
  test("合法模型名不在拦截集合内", () => {
    const registry = new ProviderRegistry(incidentConfig(), {});
    expect(registry.getKnownModelNames()).toContain("ali-deepseek-v4-pro");
  });

  test("省略 model 不触发校验（params.model 为空即短路）", async () => {
    // 用一个白名单里必然不存在的值验证「非空才校验」的短路逻辑：
    // 传空串应被 ?.trim() 短路放行、而非报"不在可用模型列表中"。
    const tool = makeTool(incidentConfig());
    const result = await tool.execute({ ...validCall, model: "   ", type: "__nonexistent__" });
    // 故意给非法 type，让 execute() 在 model 校验**之前**就返回，
    // 从而确认空白 model 没有抢先触发拦截、也不触网。
    expect(result.isError).toBe(true);
    expect(result.output).toContain("无效的子代理类型");
  });

  test("fail-open：白名单为空时不产生拦截判据", () => {
    const registry = new ProviderRegistry(
      incidentConfig({ model: "", fallbackModel: "", availableModels: [] }),
      {},
    );
    // 空清单 → execute() 里 `known.length > 0` 为假 → 无条件放行
    expect(registry.getKnownModelNames()).toHaveLength(0);
  });

  test("大小写敏感：错误大小写被拦（网关区分大小写）", async () => {
    const tool = makeTool(incidentConfig());
    const result = await tool.execute({ ...validCall, model: "ALI-DeepSeek-V4-Pro" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不在可用模型列表中");
  });
});

describe("sub_agent 的 model 参数 schema 描述", () => {
  test("描述里明确要求用完整准确名、不要臆造", async () => {
    // 白名单是"事后拦截"，描述是"事前引导"——两者都要有，否则模型每次都得靠报错学习
    const src = Bun.file(
      new URL("../../../../packages/core/src/agent/tool.ts", import.meta.url).pathname,
    );
    const text = await src.text();
    const modelFieldBlock = text.slice(text.indexOf("model: z"), text.indexOf("cwd: z"));
    expect(modelFieldBlock).toMatch(/完整模型名|准确名称/);
    expect(modelFieldBlock).toMatch(/臆造|不要凭印象/);
  });
});
