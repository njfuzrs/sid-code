/**
 * 压缩后重注入标志（T6）：单一置位入口 + 手动 /compact 的会话标记
 *
 * 哨兵：loop.ts 里不许再出现裸的 `xxxPendingAfterCompact = true`，新增压缩出口必须走
 * markPostCompactReinject；手动 /compact（loop 外）必须调 markSessionCompacted。
 * 变异自证：删掉 compact.ts 里任一处 markSessionCompacted，源码断言变红；
 * 删掉 loop.ts 入口的 consumeSessionCompactMark，接线断言变红。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  markPostCompactReinject,
  markSessionCompacted,
  consumeSessionCompactMark,
  SESSION_COMPACTED_PENDING_KEY,
} from "@sid-code/core/query/post-compact-flags.ts";
import { createInitialLoopState } from "@sid-code/core/query/types.ts";
import { SessionState } from "@sid-code/core/session/state.ts";

const ROOT = join(import.meta.dir, "../../../..");
const loopSrc = readFileSync(join(ROOT, "packages/core/src/query/loop.ts"), "utf8");
const compactSrc = readFileSync(
  join(ROOT, "packages/cli/src/command/commands/compact/compact.ts"),
  "utf8",
);

describe("post-compact-flags", () => {
  test("markPostCompactReinject 置位三个标志", () => {
    const s = createInitialLoopState(10);
    markPostCompactReinject(s);
    expect(s.goalReminderPendingAfterCompact).toBe(true);
    expect(s.todoReminderPendingAfterCompact).toBe(true);
    expect(s.deferredToolsPendingAfterCompact).toBe(true);
  });

  test("会话标记：消费一次后清掉", () => {
    const ss = new SessionState("t6");
    const s1 = createInitialLoopState(10);
    expect(consumeSessionCompactMark(ss, s1)).toBe(false);
    expect(s1.todoReminderPendingAfterCompact).not.toBe(true);

    markSessionCompacted(ss);
    const s2 = createInitialLoopState(10);
    expect(consumeSessionCompactMark(ss, s2)).toBe(true);
    expect(s2.todoReminderPendingAfterCompact).toBe(true);
    expect(ss.get(SESSION_COMPACTED_PENDING_KEY)).toBeUndefined();

    const s3 = createInitialLoopState(10);
    expect(consumeSessionCompactMark(ss, s3)).toBe(false);
  });

  test("markSessionCompacted 容忍缺省 sessionState", () => {
    expect(() => markSessionCompacted(undefined)).not.toThrow();
  });
});

describe("哨兵：所有压缩出口都经单一入口置位", () => {
  test("loop.ts 无裸置位，且 loop 内出口数为 7", () => {
    expect(loopSrc).not.toMatch(/PendingAfterCompact\s*=\s*true/);
    expect(loopSrc.match(/markPostCompactReinject\(state\)/g)?.length).toBe(7);
  });

  test("queryLoop 入口消费会话标记", () => {
    const entry = loopSrc.indexOf("createInitialLoopState(config.maxTurns");
    const consume = loopSrc.indexOf("consumeSessionCompactMark(sessionState, state)");
    expect(entry).toBeGreaterThan(0);
    expect(consume).toBeGreaterThan(entry);
    expect(consume - entry).toBeLessThan(400);
  });

  test("手动 /compact 的两条成功路径都打会话标记", () => {
    expect(compactSrc.match(/markSessionCompacted\(ctx\.sessionState\)/g)?.length).toBe(2);
  });
});
