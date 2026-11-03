/**
 * `/cache --breaks` 对不可信渠道的展示（方案 T3 的第二半）。
 *
 * 背景：不可信渠道（`channel-trust.json` 判 untrusted，如 ppchat）的 `cache_read` 是编造的，
 * 它的「命中下降」不是缓存行为。会话内明细里若不标出来，读的人会照着一条渠道编造的数字
 * 去优化本地 prompt；健康度建议若把它算进占比，给出的修复方向同样是错的。
 *
 * 这里断言的是**展示层真的用上了记录里的 `channelTrust`** —— 核心的过滤逻辑
 * （`getCacheHealthAdvice`）由 `packages/core/tests/api/cache-detection.test.ts` 覆盖，
 * 但那条测试全绿时，`--breaks` 也可能压根没把这个字段接上来。
 *
 * 经 `SID_CODE_CACHE_BREAKS` 重定向到 tmp：`recordCacheBreak` 会同步落盘遥测。
 */

import { describe, test, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import {
  clearCacheBreaks,
  recordCacheBreak,
  type CacheBreakRecord,
} from "@sid-code/core/api/cache-detection.ts";
import { CacheCommand } from "@sid-code/cli/command/commands/cache/cache.ts";
import type { CommandContext } from "@sid-code/cli/command/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
// 存/恢复原值，不无条件 delete —— bun test 同进程跑多文件，delete 会抹掉 preload 兜底
const savedBreaks = process.env.SID_CODE_CACHE_BREAKS;

const ctx = { sessionId: undefined } as unknown as CommandContext;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cache-breaks-untrusted-"));
  process.env.SID_CODE_CACHE_BREAKS = join(tmpDir, "cache-breaks.jsonl");
});

afterAll(async () => {
  // 落盘走 dynamic import().then()，是待处理微任务；同步恢复 env 会与它赛跑
  await new Promise((r) => setTimeout(r, 0));
  if (savedBreaks === undefined) delete process.env.SID_CODE_CACHE_BREAKS;
  else process.env.SID_CODE_CACHE_BREAKS = savedBreaks;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  clearCacheBreaks();
});

function rec(over: Partial<CacheBreakRecord> = {}): CacheBreakRecord {
  return {
    dropTokens: 3000,
    dropPercent: 60,
    changes: ["System prompt 变化"],
    categories: ["system_prompt"],
    previousCacheReadTokens: 5000,
    currentCacheReadTokens: 2000,
    ts: 1_700_000_000,
    model: "deepseek-v4-pro",
    ...over,
  };
}

async function runBreaks(): Promise<string> {
  const res = await new CacheCommand().call("--breaks", ctx);
  return (res as { value: string }).value;
}

describe("/cache --breaks 标注不可信渠道", () => {
  test("untrusted 记录逐条标注，trusted 记录不标注", async () => {
    recordCacheBreak(rec({ model: "trusted-model", channelTrust: "trusted" }));
    recordCacheBreak(rec({ model: "bad-model", channelTrust: "untrusted" }));

    const out = await runBreaks();
    const lines = out.split("\n");
    const trustedLine = lines.find((l) => l.includes("trusted-model"))!;
    const untrustedLine = lines.find((l) => l.includes("bad-model"))!;

    expect(trustedLine).not.toContain("渠道 usage 不可信");
    expect(untrustedLine).toContain("⚠ 渠道 usage 不可信");
    // 明细不隐藏记录：两条都在，否则会被读成「没断过」
    expect(lines.some((l) => l.includes("trusted-model"))).toBe(true);
    expect(lines.some((l) => l.includes("bad-model"))).toBe(true);
  });

  test("存在 untrusted 记录时单独一行说明未计入健康度建议", async () => {
    recordCacheBreak(rec({ channelTrust: "untrusted" }));
    recordCacheBreak(rec({ channelTrust: "untrusted" }));

    const out = await runBreaks();
    expect(out).toContain("另有 2 条走 usage 不可信渠道");
  });

  test("全是 trusted 时不出现「另有 N 条」那行", async () => {
    recordCacheBreak(rec({ channelTrust: "trusted" }));
    recordCacheBreak(rec({ channelTrust: "unknown" }));

    const out = await runBreaks();
    expect(out).not.toContain("不可信渠道");
  });

  test("untrusted 记录不参与健康度建议（明细有、建议无）", async () => {
    // 3 条 untrusted 的 system 变化：占明细 100%，若算进建议就会给出「移到 messages 尾部」
    for (let i = 0; i < 3; i++) {
      recordCacheBreak(rec({ channelTrust: "untrusted" }));
    }

    const out = await runBreaks();
    expect(out).toContain("渠道 usage 不可信"); // 明细照常展示
    // 注意别用 not.toContain("健康度建议") —— 「未计入下方健康度建议」那行本身就含这四个字，
    // 断言会恒红。advice 段的标题带冒号，用它才区分得开。
    expect(out).not.toContain("健康度建议:");
    expect(out).not.toContain("移至 messages 尾部");
  });
});
