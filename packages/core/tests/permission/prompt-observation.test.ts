/**
 * 确认弹窗生命周期观测（B21）的消费语义。
 *
 * 为什么值得单独锁：这组字段的唯一价值是「事后判读」（哪种故障），判读的前提是
 * 计数口径不能漂——比如 `queue_ms` 若在重挂载时被重算，就会把「显示后被重挂载」
 * 误读成「排队很久才显示」。这里把四个边界钉住：
 *   ① 未观测时 note* 是 no-op、consume 返回 null（规则直放行 / 子代理路径）；
 *   ② 消费即清（否则会串到下一次没弹窗的决策上）；
 *   ③ 重挂载只累加 mounts，不重算 queue_ms；
 *   ④ 新的 begin 会重置上一次未消费的残留。
 */

import { test, expect, describe } from "bun:test";
import {
  beginPromptObservation,
  consumePromptObservation,
  notePromptKey,
  notePromptKeyDropped,
  notePromptMounted,
  notePromptResolveDropped,
} from "@sid-code/core/permission/decision-telemetry.ts";

describe("PromptObservation", () => {
  test("未开始观测时：note* 全是 no-op，consume 返回 null", () => {
    expect(consumePromptObservation()).toBeNull();
    // 不抛就是通过——这些函数在规则直放行 / 子代理路径上会被无差别调用
    notePromptMounted();
    notePromptKey();
    notePromptKeyDropped();
    notePromptResolveDropped();
    expect(consumePromptObservation()).toBeNull();
  });

  test("完整生命周期：排队时长 / 显示时长 / 按键 / 两层去重", () => {
    const requestedAt = Date.now() - 100;
    beginPromptObservation(requestedAt);
    notePromptMounted(); // 首帧挂载 = 弹窗真的显示了
    notePromptKey();
    notePromptKey();
    notePromptKeyDropped();
    notePromptResolveDropped();

    const obs = consumePromptObservation();
    expect(obs).not.toBeNull();
    expect(obs!.mounts).toBe(1);
    expect(obs!.keys).toBe(2);
    expect(obs!.keysDropped).toBe(1);
    expect(obs!.resolveDropped).toBe(1);
    // queue_ms 从请求产生到首帧挂载，必然 >= 构造时给的 100ms 间隔
    expect(obs!.queueMs).toBeGreaterThanOrEqual(100);
    expect(obs!.shownMs).toBeGreaterThanOrEqual(0);
  });

  test("消费即清：第二次 consume 返回 null（防止串到下一次决策）", () => {
    beginPromptObservation(Date.now());
    notePromptMounted();
    notePromptKey();
    expect(consumePromptObservation()).not.toBeNull();
    expect(consumePromptObservation()).toBeNull();
  });

  test("重挂载只累加 mounts，不重算 queue_ms", () => {
    beginPromptObservation(Date.now() - 50);
    notePromptMounted();
    const first = consumePromptObservation();
    expect(first!.mounts).toBe(1);

    // 同一请求被重挂载（换 key / 父级重建）：begin 不会再调，mounts 继续累加
    beginPromptObservation(Date.now() - 50);
    notePromptMounted();
    notePromptMounted();
    const second = consumePromptObservation();
    expect(second!.mounts).toBe(2);
    // 两次 queue_ms 口径一致（都由「同一次 begin 到首帧」算出），不会因为重挂载变大
    expect(second!.queueMs).toBeGreaterThanOrEqual(50);
  });

  test("新的 begin 重置上一次未消费的残留", () => {
    beginPromptObservation(Date.now());
    notePromptKey();
    notePromptKey();
    // 上一次观测没人消费（异常路径）→ 新请求开始时必须归零，不能把 keys 带过去
    beginPromptObservation(Date.now());
    const obs = consumePromptObservation();
    expect(obs!.keys).toBe(0);
    expect(obs!.keysDropped).toBe(0);
    expect(obs!.mounts).toBe(0);
  });

  test("没挂载过的弹窗：mounts=0 且没有 shown_ms（判读为「压根没显示」）", () => {
    beginPromptObservation(Date.now());
    // 排队期间被 abort：一次挂载都没有
    const obs = consumePromptObservation();
    expect(obs!.mounts).toBe(0);
    expect(obs!.shownMs).toBeUndefined();
  });
});
