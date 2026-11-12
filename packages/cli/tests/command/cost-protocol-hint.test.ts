/**
 * /cost 缓存命中率提示（D6，2026-11-10 成本面板核查）。
 *
 * ## 旧行为为什么错
 *
 * 旧实现在「会话里有 openai 族命中、且该族没有缓存写入」时输出写死的一句
 * 「openai 协议为隐式缓存，60-70% 属正常上限」，**不看实际数值**。取证会话
 * （`~/.sid-code/trajectories/sessions/20261110-142303-21c3a481`）里 /cost 显示
 * 91.7%，下一行却是「60-70% 属正常上限」，自相矛盾；而实测主流 openai 兼容渠道
 * 命中率 80–95%（本机 usage-ledger 里 deepseek 473 个会话加权 91.4%），
 * 「60-70% 是上限」这个前提本身不成立。
 *
 * ## 现在的判据
 *
 * 只看实测命中率与请求数（`formatCacheHitHint`）：
 * - 请求数 < LOW_CACHE_HIT_RATE_MIN_REQUESTS（5）→ 不提示（缓存还没热起来）
 * - 命中率 ≥ LOW_CACHE_HIT_RATE_THRESHOLD（50%）→ 不提示
 * - 其余 → 提示「命中率偏低」并给出 `/cache --breaks` 这个可行动作
 *
 * 走真实 CostCommand 入口 + 真实 SessionState.updateUsage 记账，不 mock 判据：
 * 缺陷的形态正是「文案与命中率不同源」，mock 掉任一边都测不出来。
 */
import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import {
  CostCommand,
  formatCacheHitHint,
  LOW_CACHE_HIT_RATE_MIN_REQUESTS,
  LOW_CACHE_HIT_RATE_THRESHOLD,
  type PendingTasksView,
} from "../../src/command/commands/cost/cost.ts";

/** 空闲的后台闸门：避免读进程级单例，和 core 的闸门测试互相干扰 */
const IDLE_GATE: PendingTasksView = { busy: false, busyLabel: null, pendingLabels: [] };

async function runCost(ss: SessionState): Promise<string> {
  const ctx = { sessionState: ss } as any;
  const result = (await new CostCommand(() => IDLE_GATE).call("", ctx)) as { value: string };
  return result.value;
}

/** openai 族记账：prompt_tokens 含命中，无写入（该族恒 0） */
function recordOpenAI(
  ss: SessionState,
  opts: { hit: number; prompt: number; requests?: number; model?: string } = {
    hit: 6_500,
    prompt: 10_000,
  },
): void {
  ss.updateUsage(
    opts.model ?? "gpt-test",
    {
      inputTokens: opts.prompt,
      outputTokens: 100,
      cacheReadInputTokens: opts.hit,
      cacheCreationInputTokens: 0,
    },
    1,
    "openai",
    undefined,
    false,
    opts.requests ?? 1,
  );
}

/** anthropic 族记账：input_tokens 是未命中余量，与命中/写入互斥 */
function recordAnthropic(ss: SessionState, requests = 1): void {
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
    undefined,
    false,
    requests,
  );
}

describe("/cost 缓存命中率提示：按实测值判断（D6）", () => {
  test("取证会话复现：91.7% 命中率不再出现任何「上限」类提示", async () => {
    const ss = new SessionState("cost-hit-hint-test");
    // 方案文档 2.2 节第一段结束时的真实值：累计发送 2,398,645 / 命中 2,199,936 / 31 次请求
    recordOpenAI(ss, { hit: 2_199_936, prompt: 2_398_645, requests: 31 });
    const out = await runCost(ss);
    expect(out).toContain("缓存命中率: 91.7%");
    // 旧文案会在这一行之后写「60-70% 属正常上限」——与面板上的 91.7% 自相矛盾
    expect(out).not.toContain("上限");
    expect(out).not.toContain("60-70");
    expect(out).not.toContain("偏低");
  });

  test("命中率 30%、请求数 5：出现「命中率偏低」并指向 /cache --breaks", async () => {
    const ss = new SessionState("cost-hit-hint-test");
    recordOpenAI(ss, { hit: 3_000, prompt: 10_000, requests: 5 });
    const out = await runCost(ss);
    expect(out).toContain("缓存命中率: 30.0%");
    expect(out).toContain("缓存命中率偏低");
    expect(out).toContain("/cache --breaks");
  });

  test("请求数不足 5 次：命中率再低也不提示（缓存还没热起来）", async () => {
    const ss = new SessionState("cost-hit-hint-test");
    recordOpenAI(ss, { hit: 1_000, prompt: 10_000, requests: LOW_CACHE_HIT_RATE_MIN_REQUESTS - 1 });
    const out = await runCost(ss);
    expect(out).toContain("缓存命中率: 10.0%");
    expect(out).not.toContain("偏低");
  });

  test("命中率正好等于阈值：不提示（>= 阈值视为正常）", async () => {
    const ss = new SessionState("cost-hit-hint-test");
    recordOpenAI(ss, { hit: 5_000, prompt: 10_000, requests: 5 });
    const out = await runCost(ss);
    expect(out).toContain(`缓存命中率: ${LOW_CACHE_HIT_RATE_THRESHOLD}.0%`);
    expect(out).not.toContain("偏低");
  });

  test("anthropic 族显式缓存、命中率高：不提示（协议族不再是判据）", async () => {
    const ss = new SessionState("cost-hit-hint-test");
    recordAnthropic(ss, 5);
    const out = await runCost(ss);
    // promptTotal = 未命中 500 + 命中 8,000 + 写入 1,500 = 10,000 → 80.0%
    expect(out).toContain("缓存命中率: 80.0%");
    expect(out).not.toContain("上限");
    expect(out).not.toContain("偏低");
  });

  test("多协议混用、整体命中率高：不再出现「混用多个协议族」的旧提示", async () => {
    const ss = new SessionState("cost-hit-hint-test");
    recordOpenAI(ss, { hit: 6_500, prompt: 10_000, requests: 3 });
    recordAnthropic(ss, 3);
    const out = await runCost(ss);
    // 两族各 10,000 promptTotal，命中 6,500 + 8,000 = 14,500 → 72.5%
    expect(out).toContain("缓存命中率: 72.5%");
    expect(out).not.toContain("混用多个协议族");
    expect(out).not.toContain("上限");
    expect(out).not.toContain("偏低");
  });
});

describe("formatCacheHitHint：阈值与样本量边界", () => {
  test("91.7% / 31 次 → null（与取证会话现场一致）", () => {
    expect(formatCacheHitHint(91.7, 31)).toBeNull();
  });

  test("30% / 5 次 → 提示含「偏低」与可行动作", () => {
    const hint = formatCacheHitHint(30, LOW_CACHE_HIT_RATE_MIN_REQUESTS);
    expect(hint).toContain("缓存命中率偏低");
    expect(hint).toContain("/cache --breaks");
  });

  test("30% / 4 次 → null（样本太少）", () => {
    expect(formatCacheHitHint(30, LOW_CACHE_HIT_RATE_MIN_REQUESTS - 1)).toBeNull();
  });

  test("正好等于阈值 → null；略低于阈值 → 提示", () => {
    expect(formatCacheHitHint(LOW_CACHE_HIT_RATE_THRESHOLD, 10)).toBeNull();
    expect(formatCacheHitHint(LOW_CACHE_HIT_RATE_THRESHOLD - 0.1, 10)).toContain("偏低");
  });
});
