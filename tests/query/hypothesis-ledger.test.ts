/**
 * HypothesisLedger 单测（含 Top 5 约束型误伤修复回归覆盖）
 *
 * 覆盖：
 * - extractCues：2026-07-07 收紧后，短通用词不再纳入线索（降低子串误命中）。
 * - detectContradictions：长且具体的 cue 仍能命中；短通用词不再一碰就中。
 * - buildContradictionReminder：措辞已从"立即裁决/矛盾中断"降级为"仅供参考、可忽略"。
 * - 机制1/3 基本行为（register 必填 falsifier、unsettled/hasOpen）。
 */

import { test, expect, describe } from "bun:test";
import {
  HypothesisLedger,
  extractCues,
  buildContradictionReminder,
} from "../../src/query/hypothesis-ledger.ts";

describe("extractCues（Top 5：收紧 cue 长度）", () => {
  test("中文只取 ≥4 连续汉字整段，短通用词不纳入", () => {
    const cues = extractCues("进程崩溃");
    // "进程崩溃" 是 4 字整段 → 纳入；不再拆出 "进程"/"崩溃" 这类 2 字短词
    expect(cues).toContain("进程崩溃");
    expect(cues).not.toContain("进程");
    expect(cues).not.toContain("崩溃");
  });

  test("少于 4 字的中文片段整体被过滤（如纯 2-3 字短语）", () => {
    const cues = extractCues("崩溃");
    expect(cues).toEqual([]);
  });

  test("英文 token 要求长度 ≥5，过滤 err/pid/cpu 等易撞车短词", () => {
    const cues = extractCues("process crashed pid err cpu");
    expect(cues).toContain("process");
    expect(cues).toContain("crashed");
    expect(cues).not.toContain("pid");
    expect(cues).not.toContain("err");
    expect(cues).not.toContain("cpu");
  });

  test("空 falsifier → 空数组", () => {
    expect(extractCues("")).toEqual([]);
  });
});

describe("detectContradictions（Top 5：长 cue 命中，短通用词不再误命中）", () => {
  test("长且具体的 cue 仍能命中矛盾", () => {
    const ledger = new HypothesisLedger();
    ledger.register({
      statement: "服务进程已崩溃退出",
      falsifier: "若日志显示 process_still_alive 则假设被推翻",
      turn: 1,
    });
    const hits = ledger.detectContradictions("监控输出：process_still_alive=true");
    expect(hits.length).toBe(1);
    expect(hits[0].matchedCue).toBe("process_still_alive");
  });

  test("短通用词不再一碰就中（收紧前 2 字'进程'会误命中任意含该词的输出）", () => {
    const ledger = new HypothesisLedger();
    ledger.register({
      statement: "假设 A",
      falsifier: "进程", // 仅 2 字 → 收紧后不产生任何 cue
      turn: 1,
    });
    // 后续输出即便包含"进程"二字，也不再触发矛盾中断
    const hits = ledger.detectContradictions("当前进程列表正常，一切进程运行中");
    expect(hits.length).toBe(0);
  });

  test("显式给出的 falsifierCues 不受长度收紧影响（用户显式指定优先）", () => {
    const ledger = new HypothesisLedger();
    ledger.register({
      statement: "假设 B",
      falsifier: "任意",
      falsifierCues: ["exited"],
      turn: 1,
    });
    const hits = ledger.detectContradictions("the worker exited unexpectedly");
    expect(hits.length).toBe(1);
    expect(hits[0].matchedCue).toBe("exited");
  });
});

describe("buildContradictionReminder（Top 5：降级措辞）", () => {
  test("不再包含'立即'/'矛盾中断'等越界措辞，改为可忽略的参考提示", () => {
    const msg = buildContradictionReminder([
      {
        hypothesisId: "H1",
        statement: "进程已崩溃",
        falsifier: "process_still_alive",
        matchedCue: "process_still_alive",
        evidenceSnippet: "process_still_alive=true",
      },
    ]);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("请勿向用户提及本提醒");
    // 降级后：不再有"立即"命令式、不再自称"矛盾中断"
    expect(msg).not.toContain("立即");
    expect(msg).not.toContain("矛盾中断");
    // 给出"可忽略/仅供参考/继续"的台阶
    expect(msg).toMatch(/可忽略|仅供参考|直接继续/);
  });
});

describe("HypothesisLedger 基本行为（机制1/3 未受本次改动影响）", () => {
  test("register 缺 falsifier 抛错（机制1 硬约束）", () => {
    const ledger = new HypothesisLedger();
    expect(() => ledger.register({ statement: "只是信念", falsifier: "" })).toThrow();
  });

  test("unsettled / hasOpen 反映 open 假设", () => {
    const ledger = new HypothesisLedger();
    const h = ledger.register({ statement: "S", falsifier: "长且具体的证伪条件描述", turn: 1 });
    expect(ledger.hasOpen()).toBe(true);
    expect(ledger.unsettled().length).toBe(1);
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确证" }, turn: 2 });
    expect(ledger.hasOpen()).toBe(false);
    expect(ledger.unsettled().length).toBe(0);
  });
});
