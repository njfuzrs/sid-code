/**
 * /model 命令测试
 */

import { describe, test, expect, mock } from "bun:test";
import { ModelCommand } from "../../src/command/builtins.ts";
import type { AppContext } from "../../src/command/types.ts";
import type { Config, ModelConfig } from "../../src/config/config.ts";
import { resolveCurrentModelConfig } from "../../src/config/config.ts";

function createMockContext(config: Partial<Config> = {}): AppContext {
  const fullConfig: Config = {
    provider: "openai",
    model: "qwen3.5-plus",
    anthropicKey: "",
    openaiKey: "test-key",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    maxTokens: 8192,
    availableModels: [],
    permissionMode: "default",
    skipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    yesMode: false,
    sessionId: "",
    continue: false,
    resume: "",
    print: false,
    outputFormat: "text",
    maxTurns: 0,
    systemPrompt: "",
    appendSystemPrompt: "",
    systemPromptFile: "",
    debug: false,
    debugLevel: "INFO",
    debugLogFile: "~/.sid-code/debug.log",
    hooks: [],
    mcpServers: {},
    ...config,
  };

  return {
    config: fullConfig,
    ctxMgr: {} as any,
    registry: {} as any,
    sessionId: "test-session",
    provider: {} as any,
    setModel: mock((model: string) => {
      fullConfig.model = model;
      resolveCurrentModelConfig(fullConfig);
    }),
    exitRequested: false,
    sessionState: {} as any,
  };
}

describe("ModelCommand", () => {
  test("name() 返回 'model'", () => {
    const cmd = new ModelCommand();
    expect(cmd.name()).toBe("model");
  });

  test("aliases() 包含 'm'", () => {
    const cmd = new ModelCommand();
    expect(cmd.aliases()).toContain("m");
  });

  test("无参数时显示当前模型", async () => {
    const cmd = new ModelCommand();
    const ctx = createMockContext();
    const result = await cmd.execute("", ctx);
    expect(result.kind).toBe("message");
    expect(result.message).toContain("qwen3.5-plus");
  });

  test("切换到有效模型", async () => {
    const cmd = new ModelCommand();
    const availableModels: ModelConfig[] = [
      { name: "qwen-plus", provider: "openai" },
      { name: "qwen3.5-plus", provider: "openai" },
    ];
    const ctx = createMockContext({ availableModels });

    await cmd.execute("qwen-plus", ctx);

    expect(ctx.setModel).toHaveBeenCalledWith("qwen-plus");
    expect(ctx.config.model).toBe("qwen-plus");
  });

  test("切换到无效模型时返回错误", async () => {
    const cmd = new ModelCommand();
    const availableModels: ModelConfig[] = [
      { name: "qwen-plus", provider: "openai" },
      { name: "qwen3.5-plus", provider: "openai" },
    ];
    const ctx = createMockContext({ availableModels });

    const result = await cmd.execute("invalid-model", ctx);

    expect(result.kind).toBe("error");
    expect(ctx.setModel).not.toHaveBeenCalled();
    expect(ctx.config.model).toBe("qwen3.5-plus");
  });

  test("无可用模型列表时允许切换任意模型", async () => {
    const cmd = new ModelCommand();
    const ctx = createMockContext({ availableModels: [] });

    await cmd.execute("any-model", ctx);

    expect(ctx.setModel).toHaveBeenCalledWith("any-model");
  });

  test("/model list 返回可用模型列表", async () => {
    const cmd = new ModelCommand();
    const availableModels: ModelConfig[] = [
      { name: "qwen-plus", provider: "openai" },
      { name: "qwen3.5-plus", provider: "openai" },
    ];
    const ctx = createMockContext({ availableModels });

    const result = await cmd.execute("list", ctx);

    expect(result.kind).toBe("message");
    expect(result.message).toContain("qwen-plus");
  });

  test("/model ls 是 list 的别名", async () => {
    const cmd = new ModelCommand();
    const availableModels: ModelConfig[] = [
      { name: "qwen-plus", provider: "openai" },
    ];
    const ctx = createMockContext({ availableModels });

    const result = await cmd.execute("ls", ctx);

    expect(result.kind).toBe("message");
    expect(result.message).toContain("qwen-plus");
  });

  test("切换模型时同时更新 provider 和 baseURL", async () => {
    const cmd = new ModelCommand();
    const availableModels: ModelConfig[] = [
      {
        name: "claude-sonnet",
        provider: "anthropic",
        baseURL: "https://api.anthropic.com",
      },
      {
        name: "qwen-plus",
        provider: "openai",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
    ];
    const ctx = createMockContext({
      availableModels,
      provider: "openai",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });

    await cmd.execute("claude-sonnet", ctx);

    expect(ctx.setModel).toHaveBeenCalledWith("claude-sonnet");
    expect(ctx.config.provider).toBe("anthropic");
    expect(ctx.config.baseURL).toBe("https://api.anthropic.com");
  });

  test("去除参数前后空格", async () => {
    const cmd = new ModelCommand();
    const availableModels: ModelConfig[] = [
      { name: "qwen-plus", provider: "openai" },
    ];
    const ctx = createMockContext({ availableModels });

    await cmd.execute("  qwen-plus  ", ctx);

    expect(ctx.setModel).toHaveBeenCalledWith("qwen-plus");
  });
});
