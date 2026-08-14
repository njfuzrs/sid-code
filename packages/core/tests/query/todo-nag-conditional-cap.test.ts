/**
 * todo 催促通道的**条件式**封顶（P1-4 item 2）
 *
 * 对应验收（方案 §4.5 第 2 条）：todo nag 连续注入达 cap 后停止，不再每 8 轮重发。
 *
 * ⚠ 本组测试同时是一道**防回退门禁**，因为本项的实现刻意偏离了修复方案的字面处方：
 *
 * 方案（20260811）§4.4 item 2 写的是"给 todo 通道加 cap，对齐 work-log 的
 * MAX_NO_PROGRESS_NAGS"。但 todo 通道的去重与封顶是 **2026-08-01 实测数据驱动删掉的**
 * （types.ts 注释块：60 轮停滞会话只注入 1 次、nagCount 最终 1/cap 2，封顶连触发机会都没有，
 * 去重先把通道锁死了）—— 无条件 cap 会让"模型真卡住"时催更通道再次哑火，
 * 属"防线过度生效导致主功能失效"。
 *
 * 故实现取方案的另一半（**绑真实进展**）：
 *   - 无真实进展（真卡住）→ 催干活 = 主功能 → **永不封顶**；
 *   - 有真实进展但清单没动 → 催的只是记账 → 催满 cap 即停。
 *
 * 下面第一组断言就是钉住"无进展时永不封顶"这条，防止后人照文档字面改回无条件 cap。
 */

import { describe, it, expect } from "bun:test";
import {
  decideTodoNagInjection,
  MAX_TODO_BOOKKEEPING_NAGS,
  TODO_BOOKKEEPING_NAG_COUNT_KEY,
  MAX_NO_PROGRESS_NAGS,
} from "@sid-code/core/query/reminder-throttle.ts";

describe("防回退：无真实进展时 todo 催更永不封顶（2026-08-01 修复的语义）", () => {
  it("无进展时，任意大的已催次数都仍然注入", () => {
    for (const count of [0, 1, 2, 3, 12, 999]) {
      const d = decideTodoNagInjection({ hasRealProgress: false, bookkeepingNagCount: count });
      expect(d.inject).toBe(true);
      // 无进展态不消耗记账预算——否则等于给主功能加了个隐形 cap。
      expect(d.countedAsNoProgress).toBe(false);
    }
  });

  it("事故里的 12 次催促序列：若真无进展，12 次全都应放行", () => {
    // 事故实测 turnsSinceLastTodoWrite 8→16→24→…→64，共催 12 次。
    // 那 12 次之所以是噪音，是因为**当时有真实进展**（见下一组），
    // 而不是因为"催了 12 次"这个次数本身有问题。
    let injected = 0;
    for (let i = 0; i < 12; i++) {
      if (decideTodoNagInjection({ hasRealProgress: false, bookkeepingNagCount: i }).inject) {
        injected++;
      }
    }
    expect(injected).toBe(12);
  });
});

describe("§4.5 验收 2 — 有真实进展但清单不动时，催满 cap 后停止", () => {
  it("前 cap 次注入并计数，之后停止", () => {
    const seen: boolean[] = [];
    let count = 0;
    // 模拟每 8 轮一次的重发：连续 6 次机会。
    for (let i = 0; i < 6; i++) {
      const d = decideTodoNagInjection({ hasRealProgress: true, bookkeepingNagCount: count });
      seen.push(d.inject);
      if (d.countedAsNoProgress) count++;
    }
    // 前 MAX_TODO_BOOKKEEPING_NAGS 次放行，其余全部停手（不再每 8 轮重发）。
    expect(seen.slice(0, MAX_TODO_BOOKKEEPING_NAGS).every((x) => x === true)).toBe(true);
    expect(seen.slice(MAX_TODO_BOOKKEEPING_NAGS).every((x) => x === false)).toBe(true);
    expect(count).toBe(MAX_TODO_BOOKKEEPING_NAGS);
  });

  it("恰好达到 cap 时即停（边界）", () => {
    expect(
      decideTodoNagInjection({
        hasRealProgress: true,
        bookkeepingNagCount: MAX_TODO_BOOKKEEPING_NAGS,
      }).inject,
    ).toBe(false);
    expect(
      decideTodoNagInjection({
        hasRealProgress: true,
        bookkeepingNagCount: MAX_TODO_BOOKKEEPING_NAGS - 1,
      }).inject,
    ).toBe(true);
  });

  it("cap 可显式覆盖（便于调用方分档）", () => {
    expect(
      decideTodoNagInjection({ hasRealProgress: true, bookkeepingNagCount: 1, cap: 1 }).inject,
    ).toBe(false);
    expect(
      decideTodoNagInjection({ hasRealProgress: true, bookkeepingNagCount: 1, cap: 5 }).inject,
    ).toBe(true);
  });

  it("cap 与 work-log 通道对齐（方案要求的「对齐 MAX_NO_PROGRESS_NAGS」）", () => {
    expect(MAX_TODO_BOOKKEEPING_NAGS).toBe(MAX_NO_PROGRESS_NAGS);
  });
});

describe("接线（静态断言）", () => {
  const loopSrc = Bun.file(new URL("../../src/query/loop.ts", import.meta.url).pathname);

  it("loop.ts 走 decideTodoNagInjection，且计数器挂 SessionState 而非 LoopState", async () => {
    const src = await loopSrc.text();
    expect(src).toContain("decideTodoNagInjection");
    // 计数器必须挂 SessionState：LoopState 每条用户消息重建，封顶会形同虚设。
    expect(src).toContain(`sessionState.set(${"TODO_BOOKKEEPING_NAG_COUNT_KEY"}`);
    expect(src).toContain(`sessionState.get(${"TODO_BOOKKEEPING_NAG_COUNT_KEY"}`);
  });

  it("afterCompact 旁路不受封顶管辖（压缩后必须强制重注，否则清单永久消失）", async () => {
    const src = await loopSrc.text();
    // 形态：(throttleSaysYes && todoNagDecision.inject) || afterCompact
    // afterCompact 必须在 || 右侧、不与 inject 相 AND。
    expect(src).toContain("(throttleSaysYes && todoNagDecision.inject) || afterCompact");
  });

  it("清单推进后清零记账预算（否则长会话里早期催满即永久哑火）", async () => {
    const src = await loopSrc.text();
    expect(src).toContain(`sessionState.set(TODO_BOOKKEEPING_NAG_COUNT_KEY, 0)`);
  });

  it("键名常量存在且非空", () => {
    expect(typeof TODO_BOOKKEEPING_NAG_COUNT_KEY).toBe("string");
    expect(TODO_BOOKKEEPING_NAG_COUNT_KEY.length).toBeGreaterThan(0);
  });

  it("nagCount/cap 只在封顶真生效那一态上报（字段在/不在本身携带信息）", async () => {
    const src = await loopSrc.text();
    // 无进展态永不封顶，此时上报 nagCount/cap 会让离线分析误以为本通道有封顶行为——
    // 那正是 2026-08-01 删这两个字段的理由，todo-realtime-integration.test.ts
    // 「不带封顶字段」那组断言仍在守它。故必须是条件展开而非无条件字段。
    expect(src).toContain("...(todoNagDecision.countedAsNoProgress");
  });
});
