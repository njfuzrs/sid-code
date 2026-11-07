/**
 * 计量与成本方案 T1（第一步）：`prompt_total` 必须是**跨 provider 归一化**的 flow。
 *
 * 背景：`total_cumulative_prompt_tokens` 的每轮增量是 provider 原始 `input_tokens`：
 * Anthropic = 未命中余量（不含缓存命中/写入），OpenAI 族 = prompt_tokens 全量。
 * 同一个真实用量在两种 provider 下旧字段必然不等，跨 provider / 跨会话聚合会系统性偏小。
 * 新字段 `prompt_total` 每轮按 normalizeCacheUsage().promptTotal 累加，必须相等。
 *
 * 本 PR 是纯增量：旧字段的值与语义都不动，所以这里同时断言旧字段**保持不等**，
 * 防止后续有人把「顺手归一化旧字段」当成无害修改。
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

  test("collector 落盘：prompt_total 归一化，旧 flow 字段保持 provider 原始口径", async () => {
    const { testDir, hookSystem } = newSession();
    await hookSystem.fireSessionStartEvent("startup", { model: "test-model" });
    // 两轮同一个真实用量，但按各自 provider 的原始字段表达
    await fireRound(hookSystem, { provider: "anthropic", input: REAL.uncached });
    await fireRound(hookSystem, { provider: "openai", input: REAL.total });
    await hookSystem.fireSessionEndEvent("exit");

    const traj = JSON.parse(
      readFileSync(join(testDir, "sessions", "sess-prompt-total", "session.traj"), "utf-8"),
    ) as { metadata: Record<string, unknown> };

    // 新字段：两轮都是 1700 → 3400
    expect(traj.metadata.prompt_total).toBe(REAL.total * 2);
    // 旧字段：1000 + 1700 = 2700，证明本 PR 没有改存量语义（改了这里就会红）
    expect(traj.metadata.total_cumulative_prompt_tokens).toBe(REAL.uncached + REAL.total);
  });
});
