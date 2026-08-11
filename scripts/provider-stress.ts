#!/usr/bin/env bun
/**
 * provider-stress.ts — Provider 稳定性 & 压力测试（L4/L5 级）
 *
 * 两种模式：
 *   1. stability（稳定性）：每 N 秒发一次请求，持续 M 分钟，记录成功率/延迟/内存增长
 *   2. stress（压力）：并发 K 个请求 + 随机延迟注入，验证在压力下的行为
 *
 * 用法：
 *   bun run scripts/provider-stress.ts --mode stability --duration 60 --interval 10
 *   bun run scripts/provider-stress.ts --mode stress --concurrency 10 --rounds 5
 *   bun run scripts/provider-stress.ts --mode chaos --duration 30  # 混沌模式（随机 abort/超时注入）
 *
 * 环境变量：
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY
 *   SID_CODE_STRESS_PROVIDER — 要测试的 provider（默认 openai）
 *   SID_CODE_STRESS_MODEL — 要测试的模型
 *
 * 输出：
 *   JSON Lines 格式事件流 + 结尾汇总 JSON
 *
 * 退出码：
 *   0 — 成功率 ≥ 95%
 *   1 — 成功率 < 95%
 */

import { parseArgs } from "node:util";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams } from "@sid-code/core/llm/types.ts";

// ─── CLI 参数 ───

const { values } = parseArgs({
  options: {
    mode: { type: "string", short: "m", default: "stability" },
    duration: { type: "string", short: "d", default: "60" },
    interval: { type: "string", short: "i", default: "10" },
    concurrency: { type: "string", short: "c", default: "5" },
    rounds: { type: "string", short: "r", default: "3" },
    provider: { type: "string", short: "p", default: "openai" },
    model: { type: "string" },
    verbose: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
provider-stress.ts — Provider 稳定性 & 压力测试

模式：
  stability  每 interval 秒发一次请求，持续 duration 秒
  stress     并发 concurrency 个请求，重复 rounds 轮
  chaos      稳定性 + 随机注入（abort/超时/并发突增）

选项：
  -m, --mode <mode>           stability|stress|chaos（默认 stability）
  -d, --duration <sec>        稳定性/混沌模式持续时间（秒，默认 60）
  -i, --interval <sec>        稳定性模式请求间隔（秒，默认 10）
  -c, --concurrency <n>       压力模式并发数（默认 5）
  -r, --rounds <n>            压力模式轮次（默认 3）
  -p, --provider <name>       provider 名称（默认 openai）
  --model <model>             指定模型
  -v, --verbose               详细输出
  -h, --help                  显示帮助
`);
  process.exit(0);
}

const MODE = values.mode ?? "stability";
const DURATION_S = parseInt(values.duration ?? "60", 10);
const INTERVAL_S = parseInt(values.interval ?? "10", 10);
const CONCURRENCY = parseInt(values.concurrency ?? "5", 10);
const ROUNDS = parseInt(values.rounds ?? "3", 10);
const PROVIDER_NAME = values.provider ?? process.env.SID_CODE_STRESS_PROVIDER ?? "openai";
const MODEL_OVERRIDE = values.model ?? process.env.SID_CODE_STRESS_MODEL;
const VERBOSE = values.verbose ?? false;

// ─── Provider 创建 ───

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  ollama: "qwen2.5:0.5b",
};

async function createProvider(): Promise<{ provider: Provider; model: string }> {
  const model = MODEL_OVERRIDE ?? DEFAULT_MODELS[PROVIDER_NAME] ?? "gpt-4o-mini";
  const { OpenAIProvider } = await import("@sid-code/core/llm/openai.ts");
  const { AnthropicProvider } = await import("@sid-code/core/llm/anthropic.ts");

  switch (PROVIDER_NAME) {
    case "openai": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY not set");
      return { provider: new OpenAIProvider(key, model, process.env.OPENAI_BASE_URL), model };
    }
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY not set");
      return { provider: new AnthropicProvider(key, model), model };
    }
    case "ollama": {
      const baseURL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      return { provider: new OpenAIProvider("ollama", model, baseURL), model };
    }
    default:
      throw new Error(`Unknown provider: ${PROVIDER_NAME}`);
  }
}

// ─── 单次请求执行 ───

interface RequestResult {
  seq: number;
  status: "pass" | "fail" | "timeout" | "aborted";
  ttft_ms?: number;
  total_ms: number;
  output_tokens: number;
  error?: string;
  mem_mb?: number;
}

async function executeRequest(
  provider: Provider,
  model: string,
  seq: number,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<RequestResult> {
  const startTime = Date.now();
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const abortCtl = new AbortController();
  const timeoutId = setTimeout(() => abortCtl.abort("stress-timeout"), timeoutMs);

  // 合并外部 signal
  if (opts?.signal) {
    opts.signal.addEventListener("abort", () => abortCtl.abort("external-abort"), { once: true });
  }

  const params: SendParams = {
    model,
    messages: [{ role: "user", content: [{ type: "text", text: `Count from 1 to 3. (seq=${seq})` }] }],
    maxTokens: 20,
  };

  let ttftMs: number | undefined;
  let outputTokens = 0;

  try {
    for await (const event of provider.sendMessageStream(params, abortCtl.signal)) {
      if (event.type === "content_block_delta") {
        if (!ttftMs) ttftMs = Date.now() - startTime;
        outputTokens++;
      }
    }
    clearTimeout(timeoutId);

    return {
      seq,
      status: "pass",
      ttft_ms: ttftMs,
      total_ms: Date.now() - startTime,
      output_tokens: outputTokens,
      mem_mb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes("timeout");
    const isAbort = errMsg.includes("abort");

    return {
      seq,
      status: isTimeout ? "timeout" : isAbort ? "aborted" : "fail",
      total_ms: Date.now() - startTime,
      output_tokens: outputTokens,
      error: errMsg.slice(0, 200),
      mem_mb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  }
}

// ─── 模式实现 ───

async function runStability(provider: Provider, model: string): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  const endTime = Date.now() + DURATION_S * 1000;
  let seq = 0;

  log(`[stability] 开始：每 ${INTERVAL_S}s 一次请求，持续 ${DURATION_S}s`);

  while (Date.now() < endTime) {
    seq++;
    const result = await executeRequest(provider, model, seq);
    results.push(result);
    emit(result);

    const remaining = endTime - Date.now();
    if (remaining > INTERVAL_S * 1000) {
      await sleep(INTERVAL_S * 1000);
    }
  }

  return results;
}

async function runStress(provider: Provider, model: string): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  let seq = 0;

  log(`[stress] 开始：并发 ${CONCURRENCY}，${ROUNDS} 轮`);

  for (let round = 0; round < ROUNDS; round++) {
    log(`[stress] 第 ${round + 1}/${ROUNDS} 轮`);
    const batch = Array.from({ length: CONCURRENCY }, () => {
      seq++;
      return executeRequest(provider, model, seq);
    });

    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
    batchResults.forEach(emit);

    // 轮间短暂休息（避免 rate limit）
    if (round < ROUNDS - 1) await sleep(2000);
  }

  return results;
}

async function runChaos(provider: Provider, model: string): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  const endTime = Date.now() + DURATION_S * 1000;
  let seq = 0;

  log(`[chaos] 开始：持续 ${DURATION_S}s，随机注入 abort/超时/并发突增`);

  while (Date.now() < endTime) {
    seq++;
    const chaos = Math.random();

    if (chaos < 0.1) {
      // 10% 概率：提前 abort（模拟用户 ESC）
      const abortCtl = new AbortController();
      const abortDelay = Math.floor(Math.random() * 500) + 100; // 100-600ms 后 abort
      setTimeout(() => abortCtl.abort("chaos-abort"), abortDelay);
      const result = await executeRequest(provider, model, seq, { signal: abortCtl.signal });
      results.push(result);
      emit({ ...result, _chaos: "early_abort" });
    } else if (chaos < 0.2) {
      // 10% 概率：极短超时（模拟超时场景）
      const result = await executeRequest(provider, model, seq, { timeoutMs: 500 });
      results.push(result);
      emit({ ...result, _chaos: "short_timeout" });
    } else if (chaos < 0.3) {
      // 10% 概率：并发突增（3 个并发）
      const burst = Array.from({ length: 3 }, () => {
        seq++;
        return executeRequest(provider, model, seq);
      });
      const burstResults = await Promise.all(burst);
      results.push(...burstResults);
      burstResults.forEach((r) => emit({ ...r, _chaos: "burst" }));
    } else {
      // 70% 正常请求
      const result = await executeRequest(provider, model, seq);
      results.push(result);
      emit(result);
    }

    // 随机间隔 2-8s
    const intervalMs = Math.floor(Math.random() * 6000) + 2000;
    const remaining = endTime - Date.now();
    if (remaining > intervalMs) await sleep(intervalMs);
  }

  return results;
}

// ─── 汇总输出 ───

interface Summary {
  mode: string;
  provider: string;
  model: string;
  total_requests: number;
  passed: number;
  failed: number;
  timed_out: number;
  aborted: number;
  success_rate: number;
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  total_p50_ms: number;
  total_p95_ms: number;
  mem_start_mb: number;
  mem_end_mb: number;
  mem_growth_mb: number;
  duration_s: number;
}

function computeSummary(results: RequestResult[], startMemMb: number): Summary {
  const passed = results.filter((r) => r.status === "pass");
  const ttfts = passed.map((r) => r.ttft_ms!).filter((t) => t != null).sort((a, b) => a - b);
  const totals = results.map((r) => r.total_ms).sort((a, b) => a - b);
  const endMemMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);

  return {
    mode: MODE,
    provider: PROVIDER_NAME,
    model: MODEL_OVERRIDE ?? DEFAULT_MODELS[PROVIDER_NAME] ?? "unknown",
    total_requests: results.length,
    passed: passed.length,
    failed: results.filter((r) => r.status === "fail").length,
    timed_out: results.filter((r) => r.status === "timeout").length,
    aborted: results.filter((r) => r.status === "aborted").length,
    success_rate: results.length > 0 ? passed.length / results.length : 0,
    ttft_p50_ms: percentile(ttfts, 50),
    ttft_p95_ms: percentile(ttfts, 95),
    total_p50_ms: percentile(totals, 50) ?? 0,
    total_p95_ms: percentile(totals, 95) ?? 0,
    mem_start_mb: startMemMb,
    mem_end_mb: endMemMb,
    mem_growth_mb: endMemMb - startMemMb,
    duration_s: DURATION_S,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ─── 工具函数 ───

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emit(data: unknown): void {
  console.log(JSON.stringify(data));
}

function log(msg: string): void {
  if (VERBOSE) console.error(msg);
}

// ─── 主流程 ───

async function main() {
  const startMemMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  const { provider, model } = await createProvider();

  log(`[stress] provider=${PROVIDER_NAME}, model=${model}, mode=${MODE}`);

  let results: RequestResult[];
  switch (MODE) {
    case "stability":
      results = await runStability(provider, model);
      break;
    case "stress":
      results = await runStress(provider, model);
      break;
    case "chaos":
      results = await runChaos(provider, model);
      break;
    default:
      console.error(`未知模式: ${MODE}`);
      process.exit(1);
  }

  // 输出汇总
  const summary = computeSummary(results, startMemMb);
  console.log(JSON.stringify({ type: "summary", ...summary }));

  if (VERBOSE) {
    console.error(`\n[stress] 完成`);
    console.error(`  总请求: ${summary.total_requests}`);
    console.error(`  成功率: ${(summary.success_rate * 100).toFixed(1)}%`);
    console.error(`  TTFT P50/P95: ${summary.ttft_p50_ms ?? "-"}ms / ${summary.ttft_p95_ms ?? "-"}ms`);
    console.error(`  总耗时 P50/P95: ${summary.total_p50_ms}ms / ${summary.total_p95_ms}ms`);
    console.error(`  内存增长: ${summary.mem_growth_mb}MB (${summary.mem_start_mb} → ${summary.mem_end_mb})`);
  }

  // 排除 chaos 模式中故意注入的 abort/timeout，只看"正常请求"的成功率
  const normalResults = MODE === "chaos"
    ? results.filter((r) => r.status !== "aborted") // chaos abort 是故意的
    : results;
  const normalSuccessRate = normalResults.length > 0
    ? normalResults.filter((r) => r.status === "pass").length / normalResults.length
    : 0;

  // 退出码判定：成功率 < 95% 或内存增长 > 20MB
  const MAX_MEM_GROWTH_MB = parseInt(process.env.SID_CODE_STRESS_MAX_MEM_MB ?? "20", 10);
  if (normalSuccessRate < 0.95) {
    if (VERBOSE) console.error(`[stress] FAIL: 成功率 ${(normalSuccessRate * 100).toFixed(1)}% < 95%`);
    process.exit(1);
  }
  if (summary.mem_growth_mb > MAX_MEM_GROWTH_MB) {
    if (VERBOSE) console.error(`[stress] FAIL: 内存增长 ${summary.mem_growth_mb}MB > ${MAX_MEM_GROWTH_MB}MB`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[stress] 未处理异常:", err);
  process.exit(1);
});
