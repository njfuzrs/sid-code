/**
 * Provider 能力查询测试
 * Task 5：各 Provider 返回正确的能力声明
 */

import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "@sid-code/core/llm/anthropic.ts";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { OllamaProvider } from "@sid-code/core/llm/ollama.ts";
import { getCapabilities, DEFAULT_CAPABILITIES } from "@sid-code/core/llm/provider.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { StreamEvent } from "@sid-code/core/llm/types.ts";

describe("Provider capabilities", () => {
  describe("AnthropicProvider", () => {
    const provider = new AnthropicProvider("sk-test", "claude-sonnet-4-20250514");

    test("实现了 capabilities 方法", () => {
      expect(provider.capabilities).toBeDefined();
      expect(typeof provider.capabilities).toBe("function");
    });

    test("支持 streaming", () => {
      expect(provider.capabilities!().streaming).toBe(true);
    });

    test("支持 tools", () => {
      expect(provider.capabilities!().tools).toBe(true);
    });

    test("支持 thinking（Extended Thinking）", () => {
      expect(provider.capabilities!().thinking).toBe(true);
    });

    test("支持 vision", () => {
      expect(provider.capabilities!().vision).toBe(true);
    });

    test("支持 promptCaching", () => {
      expect(provider.capabilities!().promptCaching).toBe(true);
    });

    test("支持 parallelToolCalls", () => {
      expect(provider.capabilities!().parallelToolCalls).toBe(true);
    });
  });

  describe("OpenAIProvider", () => {
    const provider = new OpenAIProvider("sk-test", "gpt-4o");

    test("实现了 capabilities 方法", () => {
      expect(provider.capabilities).toBeDefined();
    });

    test("支持 streaming", () => {
      expect(provider.capabilities!().streaming).toBe(true);
    });

    test("支持 tools", () => {
      expect(provider.capabilities!().tools).toBe(true);
    });

    test("不支持 thinking", () => {
      expect(provider.capabilities!().thinking).toBe(false);
    });

    test("vision 如实声明 false（无图片输入管线，不虚标）", () => {
      expect(provider.capabilities!().vision).toBe(false);
    });

    test("不支持 promptCaching", () => {
      expect(provider.capabilities!().promptCaching).toBe(false);
    });

    test("支持 parallelToolCalls", () => {
      expect(provider.capabilities!().parallelToolCalls).toBe(true);
    });
  });

  describe("OllamaProvider", () => {
    const provider = new OllamaProvider("llama3");

    test("实现了 capabilities 方法", () => {
      expect(provider.capabilities).toBeDefined();
    });

    test("支持 streaming", () => {
      expect(provider.capabilities!().streaming).toBe(true);
    });

    test("不支持 thinking", () => {
      expect(provider.capabilities!().thinking).toBe(false);
    });

    test("不支持 vision", () => {
      expect(provider.capabilities!().vision).toBe(false);
    });

    test("不支持 promptCaching", () => {
      expect(provider.capabilities!().promptCaching).toBe(false);
    });

    test("不支持 parallelToolCalls", () => {
      expect(provider.capabilities!().parallelToolCalls).toBe(false);
    });
  });

  describe("getCapabilities 辅助函数", () => {
    test("有 capabilities 方法时返回实际能力", () => {
      const provider = new AnthropicProvider("sk-test", "claude-sonnet-4-20250514");
      const caps = getCapabilities(provider);
      expect(caps.thinking).toBe(true);
      expect(caps.promptCaching).toBe(true);
    });

    test("无 capabilities 方法时返回默认能力", () => {
      // 模拟一个没有 capabilities 方法的 Provider
      const bareProvider: Provider = {
        name: () => "bare",
        async *sendMessageStream(): AsyncIterable<StreamEvent> {
          yield { type: "message_stop" };
        },
      };
      const caps = getCapabilities(bareProvider);
      expect(caps).toEqual(DEFAULT_CAPABILITIES);
      expect(caps.thinking).toBe(false);
      expect(caps.promptCaching).toBe(false);
    });
  });

  describe("DEFAULT_CAPABILITIES", () => {
    test("streaming 默认 true", () => {
      expect(DEFAULT_CAPABILITIES.streaming).toBe(true);
    });

    test("tools 默认 true", () => {
      expect(DEFAULT_CAPABILITIES.tools).toBe(true);
    });

    test("thinking 默认 false", () => {
      expect(DEFAULT_CAPABILITIES.thinking).toBe(false);
    });

    test("vision 默认 false", () => {
      expect(DEFAULT_CAPABILITIES.vision).toBe(false);
    });

    test("promptCaching 默认 false", () => {
      expect(DEFAULT_CAPABILITIES.promptCaching).toBe(false);
    });

    test("parallelToolCalls 默认 true", () => {
      expect(DEFAULT_CAPABILITIES.parallelToolCalls).toBe(true);
    });
  });
});
