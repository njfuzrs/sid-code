/**
 * 计量与成本方案 T1：prompt 三个字段必须是**跨 provider 归一化**的口径。
 *
 * 背景：`total_cumulative_prompt_tokens` 的每轮增量曾是 provider 原始 `input_tokens`：
 * Anthropic = 未命中余量（不含缓存命中/写入），OpenAI 族 = prompt_tokens 全量。
 * 同一个真实用量在两种 provider 下旧字段必然不等，跨 provider / 跨会话聚合会系统性偏小。
 *
 * 分两步落地：
 * - 第一步（PR #660）：新增 `prompt_total`，按 normalizeCacheUsage().promptTotal 累加；
 *   旧字段一个都不动（历史数据是 provider 原始口径，改值会让新旧不可比）。
 * - 第二步（本 PR）：stock / flow 两个旧字段也改归一化 —— 它们已流进看板与 digest 判据，
 *   口径不归一化则「花多少钱 ↔ 喂多少 token」的比值本身失真。历史轨迹靠「有没有
 *   `prompt_total`」区分是否归一化之后写的。
 *
 * 落盘隔离：TraceCollector 的 outputDir 指向 tmpdir，不碰 ~/.sid-code。
 */

import { describe, test, expect } from "bun:test";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { normalizeCacheUsage } from "@sid-code/core/llm/types.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** 真实用量：未命中 1000 + 命中 500 + 写入 200 = 1700 */
const REAL = { uncached: 1000, hit: 500, write: 200, total: 1700 };

function newSession() {
  const testDir = join(
    tmpdir(),
    `prompt-total-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  const hookSystem = new HookSystem();
  hookSystem.setSessionId("sess-prompt-total");
  hookSystem.setCwd("/tmp/test");
  const collector = new TraceCollector({ outputDir: testDir });
  collector.registerHooks(hookSystem);
  return { testDir, hookSystem };
}

/**
 * 触发一轮 Before/AfterModel。input 按 provider 口径传入：
 * Anthropic = 未命中余量，OpenAI 族 = 含命中的完整 prompt。
 */
async function fireRound(
  hookSystem: HookSystem,
  opts: { provider: "anthropic" | "openai"; input: number },
) {
  const messages = [{ role: "user", content: "hello" }];
  await hookSystem.fireBeforeModelEvent({
    model: "test-model",
    messages: messages.map((m) => ({ role: m.role, content: String(m.content) })),
    raw_messages: messages,
  });
  await hookSystem.fireAfterModelEvent(
    { model: "test-model", messages: [], raw_messages: messages },
    {
      content_blocks: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        inputTokens: opts.input,
        outputTokens: 10,
        cacheReadInputTokens: REAL.hit,
        cacheCreationInputTokens: REAL.write,
      },
      provider: opts.provider,
    },
  );
}

describe("prompt_total 跨 provider 归一化", () => {
  test("同一真实用量的两种 provider 表达，normalizeCacheUsage 结果相等", () => {
    const anthropic = normalizeCacheUsage(
      {
        inputTokens: REAL.uncached,
        outputTokens: 10,
        cacheReadInputTokens: REAL.hit,
        cacheCreationInputTokens: REAL.write,
      },
      "anthropic",
    );
    const openai = normalizeCacheUsage(
      {
        inputTokens: REAL.total,
        outputTokens: 10,
        cacheReadInputTokens: REAL.hit,
        cacheCreationInputTokens: REAL.write,
      },
      "openai",
    );
    // 前提自证：两个 promptTotal 都等于真实输入，而不是都等于 0 之类的退化值
    expect(anthropic.promptTotal).toBe(REAL.total);
    expect(openai.promptTotal).toBe(REAL.total);
  });

  test("collector 落盘：三个 prompt 字段同一归一化口径，stock 与 flow 不混用", async () => {
    const { testDir, hookSystem } = newSession();
    await hookSystem.fireSessionStartEvent("startup", { model: "test-model" });
    // 两轮同一个真实用量，但按各自 provider 的原始字段表达
    await fireRound(hookSystem, { provider: "anthropic", input: REAL.uncached });
    await fireRound(hookSystem, { provider: "openai", input: REAL.total });
    await hookSystem.fireSessionEndEvent("exit");

    const traj = JSON.parse(
      readFileSync(join(testDir, "sessions", "sess-prompt-total", "session.traj"), "utf-8"),
    ) as { metadata: Record<string, unknown> };

    // flow：两轮都是 1700 → 3400（第二步之前是 1000+1700=2700，改回原始口径这里会红）
    expect(traj.metadata.prompt_total).toBe(REAL.total * 2);
    expect(traj.metadata.total_cumulative_prompt_tokens).toBe(REAL.total * 2);
    // stock：末轮快照 1700 —— 与 flow 相等就说明有人把 stock 也累加了
    expect(traj.metadata.total_tokens_sent).toBe(REAL.total);
  });
});
