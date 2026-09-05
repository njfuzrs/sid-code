/**
 * 门禁：Bridge 事件白名单必须说真实存在的方言，且是唯一的过滤入口（D13）
 *
 * **这道门禁防的东西比"白名单内容对不对"更基本。**
 *
 * 修复前 `isEligibleForBridge` 的集合是
 * `text` / `text_delta` / `tool_use` / `tool_result` / `turn_complete` / `error`
 * —— 这六个里**没有一个是真实的 `QueryEngineEvent.kind`**。它把三套词汇混成了一套：
 * 前四个是 `BridgeOutMessage.type`（出向消息类型），后两个是状态字符串，
 * 而真实的 kind 是 `stream_text` / `tool_start` / `tool_end` / `done` / `fatal_error` …
 *
 * 它能漂到完全脱离现实而没人发现，是因为**三个欺骗信号同时成立**：
 *   - 查覆盖率：它有单测，而且全绿（测试喂给它的也是同一套不存在的词）
 *   - 读代码找链路：`bridge-runner.ts` 顶部的数据流图注释**声称**它在链路上
 *   - 跑一遍看行为：它零生产调用，所以行为一直是对的
 *
 * 于是缺陷清单建议的"一行修复"（switch 前加 `if (!isEligibleForBridge(kind)) return`）
 * 若被照抄，会把 **100% 的事件**过滤掉，Bridge 直接哑掉。
 *
 * 所以判据选**"词汇是否真实存在"**而不是**"集合内容是否等于某个清单"**：
 * 后者会随产品判断变（哪些事件该给远端看是可以讨论的），前者不该变
 * —— 一个不存在的 kind 永远是 bug，不是选择。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  isEligibleForBridge,
  eligibleBridgeKinds,
} from "@sid-code/core/bridge/bridge-messaging.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

/** 从 query/types.ts 里抽出所有真实的事件 kind 字面量 */
function realEventKinds(): Set<string> {
  const src = readFileSync(join(REPO, "packages/core/src/query/types.ts"), "utf-8");
  const kinds = new Set<string>();
  for (const m of src.matchAll(/kind:\s*"([a-z_]+)"/g)) kinds.add(m[1]!);
  return kinds;
}

describe("Bridge 事件白名单", () => {
  test("前提：能从 query/types.ts 抽到一批真实 kind（否则本门禁形同虚设）", () => {
    const kinds = realEventKinds();
    // 抽不到就说明正则或路径失效了 —— 此时门禁会"全绿"，那是最坏的情形。
    expect(kinds.size).toBeGreaterThan(8);
    expect(kinds.has("tool_start")).toBe(true);
    expect(kinds.has("stream_text")).toBe(true);
  });

  test("白名单里每一项都是真实存在的 QueryEngineEvent.kind（D13 的核心判据）", () => {
    const real = realEventKinds();
    const bogus = eligibleBridgeKinds().filter((k) => !real.has(k));
    expect(bogus).toEqual([]);
  });

  test("修复前那六个「方言」词全部不在白名单里（回归保护）", () => {
    // 这六个是修复前的集合。它们不是 kind，永远不该被认为合格 ——
    // 若哪天又出现在白名单里，说明有人按 BridgeOutMessage.type 而不是事件 kind 在填。
    for (const stale of [
      "text",
      "text_delta",
      "tool_use",
      "tool_result",
      "turn_complete",
      "error",
    ]) {
      expect(isEligibleForBridge(stale)).toBe(false);
    }
  });

  test("内部事件被过滤（这些真实存在，但不该给远端看）", () => {
    for (const k of [
      "compact",
      "context_warning",
      "loop_detected",
      "loop_recovery",
      "tombstone",
      "user_message_added",
      "retry",
      "max_turns",
      "hook_blocked",
      "assistant_message",
    ]) {
      expect(isEligibleForBridge(k)).toBe(false);
    }
  });

  test("用户可见事件通过", () => {
    for (const k of ["stream_text", "tool_start", "tool_end", "done", "system", "fatal_error"]) {
      expect(isEligibleForBridge(k)).toBe(true);
    }
  });

  test("forwardEvent 真的调用了白名单（不再是两套并行判断）", () => {
    const src = readFileSync(join(REPO, "packages/core/src/bridge/bridge-runner.ts"), "utf-8");
    // 剥注释后再查：本仓有过"我写的注释骗过了我写的门禁"的教训，
    // 而这个文件的注释里刻意保留了 isEligibleForBridge 的名字作为教训记录。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("if (!isEligibleForBridge(event.kind)) return;");
  });

  test("forwardEvent 的每个 case 都在白名单里（否则那个分支是死代码）", () => {
    const src = readFileSync(join(REPO, "packages/core/src/bridge/bridge-runner.ts"), "utf-8");
    const body = src.slice(src.indexOf("private forwardEvent"));
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const cases = [...code.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]!);

    expect(cases.length).toBeGreaterThan(0);
    // 一个不在白名单里的 case 永远进不去 —— 那就是新的死代码，
    // 也正是 D13 那种"两套判断漂移"会长出来的东西。
    const unreachable = cases.filter((c) => !isEligibleForBridge(c));
    expect(unreachable).toEqual([]);
  });
});
