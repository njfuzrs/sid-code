#!/usr/bin/env bun
/**
 * provider-canary.ts — Provider 冒烟测试（L2 级）
 *
 * 每个已配置的 Provider 发送一个极简请求，验证流式消费正常完成。
 * 成本控制：每次运行 ≤ $0.03（max_tokens=10，prompt 极短）。
 *
 * 用法：
 *   bun run scripts/provider-canary.ts                    # 测试所有已配置 provider
 *   bun run scripts/provider-canary.ts --provider openai  # 只测试 openai
 *   bun run scripts/provider-canary.ts --timeout 15000    # 自定义超时 15s
 *
 * 环境变量：
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_BASE_URL
 *   SID_CODE_CANARY_PROVIDERS — 逗号分隔要测试的 provider 列表（默认全部）
 *
 * 退出码：
 *   0 — 全部通过
 *   1 — 有失败
 *
 * 输出格式（JSON Lines，适合 CI 解析）：
 *   {"provider":"openai","model":"gpt-4o-mini","status":"pass","ttft_ms":320,"total_ms":890,"tokens":{"input":12,"output":8}}
 *   {"provider":"anthropic","model":"claude-haiku-4-5-20251001","status":"fail","error":"timeout","total_ms":10000}
 *
 * 建议 CI 配置（daily cron）：
 *   - 每天 UTC 08:00 运行
 *   - 失败时发送告警到 IM
 *   - 结果归档到 artifacts
 */

import { parseArgs } from "node:util";

// ─── CLI 参数解析 ───

const { values } = parseArgs({
  options: {
    provider: { type: "string", short: "p" },
    timeout: { type: "string", short: "t" },
    model: { type: "string", short: "m" },
    verbose: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
provider-canary.ts — Provider 冒烟测试

用法：
  bun run scripts/provider-canary.ts [options]

选项：
  -p, --provider <name>   只测试指定 provider (openai|anthropic|ollama)
  -t, --timeout <ms>      单次请求超时(ms)，默认 10000
  -m, --model <model>     指定模型（覆盖默认）
  -v, --verbose           输出详细日志
  -h, --help              显示帮助

环境变量：
  SID_CODE_CANARY_PROVIDERS   逗号分隔要测试的 provider 列表
  ANTHROPIC_API_KEY           Anthropic API key
  OPENAI_API_KEY              OpenAI API key
  OLLAMA_BASE_URL             Ollama 地址（默认 http://localhost:11434）
`);
  process.exit(0);
}

const TIMEOUT_MS = parseInt(values.timeout ?? "10000", 10);
const VERBOSE = values.verbose ?? false;

// ─── Provider 配置 ───

interface CanaryProviderConfig {
  name: string;
  defaultModel: string;
  getApiKey: () => string | undefined;
  baseURL?: string;
}

const PROVIDER_CONFIGS: CanaryProviderConfig[] = [
  {
    name: "openai",
    defaultModel: "gpt-4o-mini",
    getApiKey: () => process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  },
  {
    name: "anthropic",
    defaultModel: "claude-haiku-4-5-20251001",
    getApiKey: () => process.env.ANTHROPIC_API_KEY,
  },
  {
    name: "ollama",
    defaultModel: "qwen2.5:0.5b",
    getApiKey: () => "ollama", // ollama 不需要 key
    baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  },
];

// ─── 确定要测试的 Provider ───

function getTargetProviders(): CanaryProviderConfig[] {
  // CLI --provider 优先
  if (values.provider) {
    const found = PROVIDER_CONFIGS.find((p) => p.name === values.provider);
    if (!found) {
      console.error(`未知 provider: ${values.provider}，可选: ${PROVIDER_CONFIGS.map((p) => p.name).join(", ")}`);
      process.exit(1);
    }
    return [found];
  }

  // 环境变量
  const envList = process.env.SID_CODE_CANARY_PROVIDERS;
  if (envList) {
    const names = envList.split(",").map((s) => s.trim());
    return PROVIDER_CONFIGS.filter((p) => names.includes(p.name));
  }

  // 默认：只测试有 API key 的
  return PROVIDER_CONFIGS.filter((p) => {
    const key = p.getApiKey();
    return key && key !== "";
  });
}

// ─── 执行单个 Provider 冒烟 ───

interface CanaryResult {
  provider: string;
  model: string;
  status: "pass" | "fail" | "skip";
  ttft_ms?: number;
  total_ms: number;
  tokens?: { input: number; output: number };
  error?: string;
  text?: string;
}

async function runCanary(config: CanaryProviderConfig): Promise<CanaryResult> {
  const model = values.model ?? config.defaultModel;
  const startTime = Date.now();

  // 检查 API key
  const apiKey = config.getApiKey();
  if (!apiKey) {
    return {
      provider: config.name,
      model,
      status: "skip",
      total_ms: 0,
      error: "API key not configured",
    };
  }

  try {
    // 动态导入 provider（避免启动时加载所有依赖）
    const { OpenAIProvider } = await import("../src/llm/openai.ts");
    const { AnthropicProvider } = await import("../src/llm/anthropic.ts");

    let provider: import("../src/llm/provider.ts").Provider;
    switch (config.name) {
      case "openai":
      case "ollama":
        provider = new OpenAIProvider(apiKey, model, config.baseURL);
        break;
      case "anthropic":
        provider = new AnthropicProvider(apiKey, model, config.baseURL);
        break;
      default:
        throw new Error(`不支持的 provider: ${config.name}`);
    }

    // 极简请求（成本最低）
    const params = {
      model,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Say hi" }] }],
      maxTokens: 10,
    };

    // 带超时的流式消费
    const abortCtl = new AbortController();
    const timeoutId = setTimeout(() => abortCtl.abort("canary-timeout"), TIMEOUT_MS);

    let text = "";
    let ttftMs: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const event of provider.sendMessageStream(params, abortCtl.signal)) {
        if (event.type === "content_block_delta" && "delta" in event) {
          const delta = (event as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            if (!ttftMs) ttftMs = Date.now() - startTime;
            text += delta.text;
          }
        }
        if (event.type === "message_start" && (event as any).message?.usage) {
          inputTokens = (event as any).message.usage.inputTokens ?? 0;
        }
        if (event.type === "message_delta" && (event as any).usage) {
          outputTokens = (event as any).usage.outputTokens ?? 0;
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    const totalMs = Date.now() - startTime;

    // 验证：必须有非空文本输出
    if (!text.trim()) {
      return {
        provider: config.name,
        model,
        status: "fail",
        total_ms: totalMs,
        ttft_ms: ttftMs,
        error: "empty response (no text output)",
      };
    }

    return {
      provider: config.name,
      model,
      status: "pass",
      ttft_ms: ttftMs,
      total_ms: totalMs,
      tokens: { input: inputTokens, output: outputTokens },
      text: VERBOSE ? text : undefined,
    };
  } catch (err) {
    const totalMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes("timeout") || errMsg.includes("abort");

    return {
      provider: config.name,
      model,
      status: "fail",
      total_ms: totalMs,
      error: isTimeout ? `timeout (${TIMEOUT_MS}ms)` : errMsg,
    };
  }
}

// ─── 主流程 ───

async function main() {
  const targets = getTargetProviders();

  if (targets.length === 0) {
    console.error("没有可测试的 provider（请设置 API key 环境变量）");
    process.exit(1);
  }

  if (VERBOSE) {
    console.error(`[canary] 测试 ${targets.length} 个 provider: ${targets.map((t) => t.name).join(", ")}`);
    console.error(`[canary] 超时: ${TIMEOUT_MS}ms`);
  }

  const results: CanaryResult[] = [];
  let hasFailure = false;

  for (const config of targets) {
    if (VERBOSE) console.error(`[canary] 测试 ${config.name}...`);

    const result = await runCanary(config);
    results.push(result);

    // JSON Lines 输出（不含 text 字段以减少噪音）
    const output = { ...result };
    if (!VERBOSE) delete output.text;
    console.log(JSON.stringify(output));

    if (result.status === "fail") hasFailure = true;
  }

  // 汇总
  if (VERBOSE) {
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const skipped = results.filter((r) => r.status === "skip").length;
    console.error(`\n[canary] 结果: ${passed} pass, ${failed} fail, ${skipped} skip`);
  }

  process.exit(hasFailure ? 1 : 0);
}

main().catch((err) => {
  console.error("[canary] 未处理异常:", err);
  process.exit(1);
});
