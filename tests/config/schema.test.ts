import { describe, test, expect } from "bun:test";
import { validateConfig } from "../../src/config/schema.ts";
import type { Config } from "../../src/config/config.ts";

describe("Config Validation", () => {
  const baseConfig: Config = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    anthropicKey: "sk-ant-test123456789012345678901234567890",
    openaiKey: "",
    baseURL: "",
    maxTokens: 16384,
    availableModels: [],
    permissionMode: "default",
    skipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    yesMode: false,
    allowedDirectories: [],
    blockedDirectories: [],
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
    debugLogFile: "",
    hooks: {},
    mcpServers: {},
    useAlternateBuffer: true,
    showLineNumbers: true,
  };

  test("valid config passes validation", () => {
    const result = validateConfig(baseConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("invalid provider fails validation", () => {
    const config = { ...baseConfig, provider: "invalid" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === "provider")).toBe(true);
  });

  test("maxTokens below minimum fails validation", () => {
    const config = { ...baseConfig, maxTokens: 500 };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === "maxTokens")).toBe(true);
  });

  test("invalid permission mode fails validation", () => {
    const config = { ...baseConfig, permissionMode: "invalid-mode" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === "permissionMode")).toBe(true);
  });

  test("empty model name fails validation", () => {
    const config = { ...baseConfig, model: "" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === "model")).toBe(true);
  });

  test("placeholder API key generates warning", () => {
    const config = { ...baseConfig, anthropicKey: "your-api-key-here" };
    const result = validateConfig(config);
    expect(result.warnings.some(w => w.path === "anthropicKey")).toBe(true);
  });

  test("invalid MCP server config fails validation", () => {
    const config = {
      ...baseConfig,
      mcpServers: {
        test: {
          transport: "stdio" as const,
          // missing command
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path.includes("mcpServers"))).toBe(true);
  });
});
