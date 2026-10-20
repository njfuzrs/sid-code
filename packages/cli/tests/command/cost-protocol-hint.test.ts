/**
 * /cost 协议族提示的判据必须与命中率同源（B1，2026-10-18 成本页文档核查发现）。
 *
 * 命中率是全会话跨模型聚合（SessionState.getNormalizedCacheUsage 遍历 modelUsage），
 * 旧判据却是「当前模型 provider === openai」+「全会话 cacheCreation 为 0」——两个不同范围
 * 的条件拼在一起。先 anthropic 后 /model 切 openai、或主模型 openai + anthropic 子代理时，
 * anthropic 部分的写入量让条件恒假，提示要防的「60-70% 误判成 bug」重新暴露。
 *
 * 走真实 CostCommand 入口 + 真实 SessionState.updateUsage 记账，不 mock 判据：
 * 缺陷的形态正是「判据读的字段与命中率读的字段不同源」，mock 掉任一边都测不出来。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import { CostCommand } from "../../src/command/builtins.ts";

const SINGLE_HINT = "openai 协议为隐式缓存，60-70% 属正常上限";
const MIXED_HINT = "本会话混用多个协议族";

/** openai 族一次调用：prompt_tokens 含命中，无写入 */
function recordOpenAI(ss: SessionState, model = "gpt-test", write = 0): void {
  ss.updateUsage(
    model,
    {
      inputTokens: 10_000,
      outputTokens: 100,
      cacheReadInputTokens: 6_500,
      cacheCreationInputTokens: write,
    },
    1,
    "openai",
  );
}

/** anthropic 族一次调用：input_tokens 为未命中余量，有显式写入 */
function recordAnthropic(ss: SessionState): void {
  ss.updateUsage(
    "claude-test",
    {
      inputTokens: 500,
      outputTokens: 100,
      cacheReadInputTokens: 8_000,
      cacheCreationInputTokens: 1_500,
    },
    1,
    "anthropic",
  );
}

async function runCost(ss: SessionState, currentProvider: string): Promise<string> {
  const ctx = { sessionState: ss, config: { provider: currentProvider } } as any;
  const result = (await new CostCommand().execute("", ctx)) as { message: string };
  return result.message;
}

describe("/cost 协议族提示：判据与命中率同源（B1）", () => {
  test("单 openai 会话：出现单族提示", async () => {
    const ss = new SessionState("cost-hint-test");
    recordOpenAI(ss);
    const out = await runCost(ss, "openai");
    expect(out).toContain(SINGLE_HINT);
    expect(out).not.toContain(MIXED_HINT);
  });

  test("场景 A：先 anthropic 后切 openai —— 修复前因全会话写入 > 0 漏提示", async () => {
    const ss = new SessionState("cost-hint-test");
    recordAnthropic(ss);
    recordOpenAI(ss);
    const out = await runCost(ss, "openai");
    expect(out).toContain(MIXED_HINT);
  });

  test("场景 D：主模型 openai + anthropic 子代理 —— 不切模型也会漏提示", async () => {
    const ss = new SessionState("cost-hint-test");
    recordOpenAI(ss);
    recordAnthropic(ss); // 子代理 usage-sink 按自身 provider 记进 modelUsage
    const out = await runCost(ss, "openai");
    expect(out).toContain(MIXED_HINT);
  });

  test("场景 B：先 openai 后切 anthropic —— 历史 openai 部分仍需解释，不受当前模型影响", async () => {
    const ss = new SessionState("cost-hint-test");
    recordOpenAI(ss);
    recordAnthropic(ss);
    const out = await runCost(ss, "anthropic");
    expect(out).toContain(MIXED_HINT);
  });

  test("单 anthropic 会话：不出现提示（即便当前 config.provider 被改成 openai）", async () => {
    const ss = new SessionState("cost-hint-test");
    recordAnthropic(ss);
    // 刚 /model 切到 openai、还没跑过一轮：会话里没有任何 openai 族用量，不该提示
    const out = await runCost(ss, "openai");
    expect(out).not.toContain(SINGLE_HINT);
    expect(out).not.toContain(MIXED_HINT);
  });

  test("openai 族出现显式写入：结构性上限的解释不再适用，不提示", async () => {
    const ss = new SessionState("cost-hint-test");
    recordOpenAI(ss, "gpt-test", 1_000);
    const out = await runCost(ss, "openai");
    expect(out).not.toContain(SINGLE_HINT);
    expect(out).not.toContain(MIXED_HINT);
  });
});
