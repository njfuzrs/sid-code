/**
 * D5 第 2 层落点：`loop.ts` 在 `updateUsage(...)` 之后**无条件**把当前端点的渠道可信度
 * 写进 `SessionState.channelTrust`。
 *
 * ## 这条测试专门守什么
 *
 * 「写入点不能放进 `if (breakReport)` 分支」。放在那里的直接后果是：
 * **没有断裂的会话永远拿不到 trust** —— 而 Footer 的标记恰恰每轮都要显示，
 * 不可信渠道更是常常「看起来没断裂」（它的命中数是编的，骤降判据经常不触发）。
 * 也就是说，把写入点放进断裂分支，丢掉的正好是最该标记的那批会话。
 *
 * 所以核心用例构造的是**首轮**：`checkResponseForCacheBreak` 在首轮没有上一轮基线，
 * 必定返回 null。用例先断言「这一轮确实没有断裂记录」（世界前提），再断言标记仍然出现
 * —— 少了前半句，用例就可能在「其实断裂了」的情况下假绿。
 *
 * ## 为什么用真实 queryLoop 而不是直调 `setChannelTrust`
 *
 * 直调只能证明「字段能被赋值」，证明不了「主循环有没有在正确的位置赋值」。
 * 本文件从真实入口 `queryLoop` 进，只 mock 模型层（沿用 `gate-harness.ts` 的做法）。
 *
 * ## 隔离
 *
 * `SID_CODE_CHANNEL_TRUST` 指向 tmp 文件，`resetChannelTrustCache()` 清模块级 60s 缓存
 * —— 否则会读到本机真实登记表（假绿/假红都可能是别人的数据造成的）。
 * `clearCacheBreaks()` 清 `recentBreaks` 单例（模块级，跨文件共享）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeGateHarness } from "./gate-harness.ts";
import { clearCacheBreaks, getRecentCacheBreaks } from "@sid-code/core/api/cache-detection.ts";
import { resetChannelTrustCache } from "@sid-code/core/telemetry/channel-trust.ts";
import type { AccumulatedResponse } from "@sid-code/core/llm/types.ts";

const UNTRUSTED_HOST = "code.ppchat.vip";
const BASE_URL = `https://${UNTRUSTED_HOST}/v1`;

let tmpDir: string;
let prevTrustEnv: string | undefined;

beforeEach(() => {
  prevTrustEnv = process.env.SID_CODE_CHANNEL_TRUST;
  tmpDir = mkdtempSync(join(tmpdir(), "d5-loop-trust-"));
  const path = join(tmpDir, "channel-trust.json");
  writeFileSync(
    path,
    JSON.stringify({
      channels: {
        [UNTRUSTED_HOST]: {
          host: UNTRUSTED_HOST,
          verdict: "untrusted",
          failedCriteria: ["A", "B", "C", "D"],
        },
      },
    }),
    "utf-8",
  );
  process.env.SID_CODE_CHANNEL_TRUST = path;
  resetChannelTrustCache();
  clearCacheBreaks();
});

afterEach(() => {
  resetChannelTrustCache();
  clearCacheBreaks();
  if (prevTrustEnv === undefined) delete process.env.SID_CODE_CHANNEL_TRUST;
  else process.env.SID_CODE_CHANNEL_TRUST = prevTrustEnv;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 首轮响应：没有 cache_read，检测器在首轮没有基线可比 → 必然返回 null */
function firstTurn(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "第一轮回答" }],
    stopReason: "end_turn",
    usage: { inputTokens: 900, outputTokens: 20 },
  } as AccumulatedResponse;
}

describe("D5 · loop 无条件写 channelTrust（不依赖 breakReport）", () => {
  test("无断裂（首轮）+ untrusted 端点 → 标记仍然出现", async () => {
    const h = makeGateHarness({ todos: [], responses: [firstTurn()], baseURL: BASE_URL });

    await h.run();

    // 世界前提：这一轮真的没有断裂被记录（否则本用例守不住「写入点不在断裂分支里」）
    expect(getRecentCacheBreaks()).toHaveLength(0);
    // 被测事实：标记照样出现
    expect(h.sessionState.channelTrust).toBe("untrusted");
    // Footer 读的就是这个判据
    expect(h.sessionState.isChannelUntrusted()).toBe(true);
  });

  test("端点没有登记时写 unknown（不是「只要入账就 untrusted」）", async () => {
    const h = makeGateHarness({
      todos: [],
      responses: [firstTurn()],
      baseURL: "https://api.example.com/v1",
    });

    await h.run();

    expect(h.sessionState.channelTrust).toBe("unknown");
    expect(h.sessionState.isChannelUntrusted()).toBe(false);
  });

  test("没有端点（baseURL 缺省）：写 unknown，不抛、不把空 host 当 untrusted", async () => {
    const h = makeGateHarness({ todos: [], responses: [firstTurn()] });

    await h.run();

    expect(h.sessionState.channelTrust).toBe("unknown");
  });
});
