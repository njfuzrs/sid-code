/**
 * P2-6 —— 非主循环路径的单次尝试流超时档位门禁
 *
 * 对应 `docs/bugfixes/todo/20260811-长任务子代理全超时与主agent绕圈-修复方案.md` §6。
 *
 * 事故形态：3 次 `TimeoutFired(layer=fallback_stream_timeout, threshold_ms=60000)` 全部
 * 打在子代理上，而同一会话实测流 elapsed max = 102.8s —— 慢首字节被当成"无响应"杀掉。
 *
 * 根因是**语义错配**而非数值不当：`resilient-stream.ts` 的缺省档位取了
 * `LIFECYCLE_PRESETS.subAgent.idleTimeoutMs`（60s，三档里最激进的一档），但漏斗里那个
 * 定时器（`fallback.ts` startStreamTimeout）只在发起尝试时武装一次、此后**只在重试路径**
 * 被 reset，**收到数据不续期** —— 它量的是"这次尝试跑了多久"，不是"多久没数据"。
 * 拿 idle 档当整体上限，等于把 60s 当成一次尝试允许的总时长。
 *
 * 为什么要用常量断言而不是构造一个真的 90s 无数据流：§6.4 的验收意图是"90s 无数据不得在
 * 60s 被杀"，但真跑一条 90s 的流会给全量单测加 90 秒墙钟，而它验的其实只是一个缺省档位。
 * 这里改为①直接断言缺省解析结果 + ②断言它与 idle 档不是同一个值 + ③断言 90s 场景落在
 * 阈值内（不会触发），三条合起来覆盖同一个事实，且是毫秒级。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import {
  DEFAULT_SIDE_STREAM_TIMEOUT_MS,
  resolveSideStreamTimeoutMs,
} from "@sid-code/core/llm/resilient-stream.ts";
import { LIFECYCLE_PRESETS } from "@sid-code/core/llm/stream-lifecycle.ts";
import { DEFAULTS as NETWORK_DEFAULTS } from "@sid-code/core/config/network-profile.ts";

describe("P2-6 · 子代理路径缺省流超时取 overall 档而非 idle 档", () => {
  test("缺省值 = subAgent.overallTimeoutMs（180s），不是 idle 档的 60s", () => {
    expect(DEFAULT_SIDE_STREAM_TIMEOUT_MS).toBe(LIFECYCLE_PRESETS.subAgent.overallTimeoutMs);
    expect(DEFAULT_SIDE_STREAM_TIMEOUT_MS).toBe(180_000);
    // 回归形态就是有人把它改回 idle 档：那种改动在行为上只表现为"慢首字节的子代理偶尔
    // 被杀"，没有任何既有断言会失败，所以必须在这里正面钉住二者不相等。
    expect(DEFAULT_SIDE_STREAM_TIMEOUT_MS).not.toBe(LIFECYCLE_PRESETS.subAgent.idleTimeoutMs);
  });

  test("90s 无数据的子代理流落在缺省阈值内 → 不触发 fallback_stream_timeout", () => {
    // §6.4 的核心断言：事故里被误杀的那一档（60s < elapsed ≤ 180s）现在必须活着。
    const NINETY_SECONDS = 90_000;
    expect(NINETY_SECONDS).toBeGreaterThan(LIFECYCLE_PRESETS.subAgent.idleTimeoutMs); // 修复前会被杀
    expect(NINETY_SECONDS).toBeLessThan(resolveSideStreamTimeoutMs()); // 修复后不会
    // 实测 max = 102.8s 那一档同样必须活着（这是事故里的真实样本，不是取整的假想值）。
    expect(102_800).toBeLessThan(resolveSideStreamTimeoutMs());
  });

  test("显式传入优先于缺省（主循环那类注入不被缺省覆盖）", () => {
    expect(resolveSideStreamTimeoutMs(300_000)).toBe(300_000);
    expect(resolveSideStreamTimeoutMs(undefined)).toBe(DEFAULT_SIDE_STREAM_TIMEOUT_MS);
    // 0 是合法的显式值（立即超时，测试里会用到），不得被 ?? 当成"未传"而回落缺省。
    expect(resolveSideStreamTimeoutMs(0)).toBe(0);
  });

  test("主循环路径仍为 300s（不得回归）", () => {
    // 主循环走 app.ts 显式注入 `fallbackNetTimeouts.watchdogNoProgressMs`，
    // 不吃本文件这个缺省。断言注入源的量级未被本次改动带偏。
    expect(NETWORK_DEFAULTS.watchdogNoProgressMs).toBe(300_000);
    expect(resolveSideStreamTimeoutMs(NETWORK_DEFAULTS.watchdogNoProgressMs)).toBe(300_000);
    // 三档相对关系：子代理该比主循环短，但不该短到误杀。
    expect(DEFAULT_SIDE_STREAM_TIMEOUT_MS).toBeLessThan(NETWORK_DEFAULTS.watchdogNoProgressMs);
  });
});
