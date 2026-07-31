/**
 * src/llm/openai.ts::probeOpenAICompatModel 单测。
 *
 * 这个函数是 model-capabilities.ts::probeModelCapability 的 openai 线格式适配器——
 * 后者故意不碰任何 provider 实现（见其文件头注释），HTTP 细节（端点拼接、Bearer 鉴权、
 * 响应解读）由本文件测的这层负责。覆盖点：
 *   1. 请求确实打到 `${baseURL}/chat/completions`，带 Bearer 鉴权
 *   2. 400 响应且能解出档位 → 写入能力缓存
 *   3. 200 响应（服务端不校验该字段）→ 写入 effortValues: []
 *   4. 网络异常 → 不抛出、不写缓存（静默，留给自愈路径）
 *
 * 全部用例都通过 __resetCapabilityCacheForTest 隔离真实磁盘缓存（同 model-capabilities.test.ts
 * 的隔离必要性：不隔离会读到/写到 ~/.sid-code/model-capabilities.json 真实数据）。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { probeOpenAICompatModel } from "../../src/llm/openai.ts";
import { lookupCapability, __resetCapabilityCacheForTest } from "../../src/llm/model-capabilities.ts";

let origFetch: typeof globalThis.fetch;

beforeEach(() => {
  __resetCapabilityCacheForTest({});
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("probeOpenAICompatModel — 请求构造", () => {
  test("打到 {baseURL}/chat/completions，带 Bearer 鉴权与 max_tokens=16 的小请求", async () => {
    let capturedURL: string | undefined;
    let capturedInit: any;
    globalThis.fetch = (async (url: any, init: any) => {
      capturedURL = String(url);
      capturedInit = init;
      return { ok: true, text: async () => "" } as any;
    }) as any;

    await probeOpenAICompatModel("vendor-x-model", "https://gateway.example.com/v1", "sk-test-key");

    expect(capturedURL).toBe("https://gateway.example.com/v1/chat/completions");
    expect(capturedInit.headers.Authorization).toBe("Bearer sk-test-key");
    const body = JSON.parse(capturedInit.body);
    expect(body.model).toBe("vendor-x-model");
    expect(body.max_tokens).toBe(16);
    expect(typeof body.reasoning_effort).toBe("string");
  });

  test("baseURL 末尾多余的斜杠不会拼出双斜杠", async () => {
    let capturedURL: string | undefined;
    globalThis.fetch = (async (url: any) => {
      capturedURL = String(url);
      return { ok: true, text: async () => "" } as any;
    }) as any;

    await probeOpenAICompatModel("m", "https://gateway.example.com/v1/", "k");
    expect(capturedURL).toBe("https://gateway.example.com/v1/chat/completions");
  });
});

describe("probeOpenAICompatModel — 结果写入能力缓存", () => {
  test("400 且能解出档位 → effortValues 写入缓存", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        text: async () =>
          "Invalid value: '__sid_code_probe__'. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.",
      }) as any) as any;

    await probeOpenAICompatModel("brand-new-model", "https://gw.example.com/v1", "k");

    const cap = lookupCapability("brand-new-model");
    expect(cap?.effortValues).toContain("high");
    expect(cap?.source).toBe("probe");
  });

  test("200（服务端不校验该字段）→ effortValues 写入空数组，即明确不支持", async () => {
    globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as any) as any;

    await probeOpenAICompatModel("no-reasoning-model", "https://gw.example.com/v1", "k");

    const cap = lookupCapability("no-reasoning-model");
    expect(cap?.effortValues).toEqual([]);
    expect(cap?.supportsReasoning).toBe(false);
  });

  test("网络异常（fetch 抛出）→ 静默返回，不写缓存、不向上抛出", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    // 不用 try/catch 包裹：若函数意外向上抛出，await 会让 bun:test 直接判定本用例失败。
    await probeOpenAICompatModel("unreachable-model", "https://gw.example.com/v1", "k");
    expect(lookupCapability("unreachable-model")).toBeNull();
  });

  test("无法识别的错误文本 → 不猜、不写缓存", async () => {
    globalThis.fetch = (async () => ({ ok: false, text: async () => "Internal Server Error" }) as any) as any;

    await probeOpenAICompatModel("weird-error-model", "https://gw.example.com/v1", "k");
    expect(lookupCapability("weird-error-model")).toBeNull();
  });
});
