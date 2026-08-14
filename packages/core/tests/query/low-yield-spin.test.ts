/**
 * 低信息量空转检测单元测试（P1-4 item 3）
 *
 * 对应验收（方案 §4.5 第 3 条）：
 *   连续 5 轮"仅 thought + 同参同返回值只读命令" → 触发低信息量空转介入，
 *   且提示文本含具体替代命令。
 *
 * 本组同时钉住一条**现状事实**（第一个 describe）：事故里那条命令进不了已有的
 * repeated-readonly-guard。方案 §4.4 item 3 把落点写成 loop-detection.ts，实测那里
 * 默认全局关闭；而唯一默认开启的那道阀对本形态失明。两条都记在这里，
 * 防止后人以为"已有阀门调个阈值就行"。
 */

import { describe, it, expect } from "bun:test";
import {
  observeLowYieldTurn,
  createLowYieldSpinState,
  buildLowYieldSpinReminder,
  extractCommandBody,
  LOW_YIELD_SPIN_THRESHOLD,
  MAX_LOW_YIELD_INTERVENTIONS,
  type TurnObservation,
} from "@sid-code/core/query/low-yield-spin.ts";
import { isReadonlyProbeCommand } from "@sid-code/core/query/repeated-readonly-guard.ts";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

/** 事故里被跑了 33 次的那条命令原文。 */
const INCIDENT_CMD =
  'cd /Users/zhourusheng/Code/person/sid-code && bunx tsc --noEmit 2>&1 | grep -c "error TS"';

/** 构造一轮"只思考 + 跑一条低信息量命令"的观测。 */
function spinTurn(command: string, output: string): TurnObservation {
  return { commands: [command], outputs: [output], hadFileMutation: false, hadTextOutput: false };
}

describe("现状事实：事故那条命令进不了已有的 repeated-readonly-guard", () => {
  it("含管道 + bunx 不在只读白名单 → isReadOnlyCommand=false，那道阀完全失明", () => {
    // 这是本项必须新写一道检测的直接理由（不是"调阈值就行"）。
    expect(isReadOnlyCommand('bunx tsc --noEmit 2>&1 | grep -c "error TS"')).toBe(false);
    expect(isReadonlyProbeCommand(INCIDENT_CMD)).toBe(false);
  });

  it("对照：git status 系命令确实能进那道阀（证明上面不是测试写错）", () => {
    expect(isReadonlyProbeCommand("cd /a/b && git status --short")).toBe(true);
  });
});

describe("§4.5 验收 3 — 连续 5 轮同参同返回值的单标量命令触发介入", () => {
  it("第 5 轮触发，前 4 轮不触发", () => {
    const state = createLowYieldSpinState();
    const decisions = [];
    for (let i = 0; i < LOW_YIELD_SPIN_THRESHOLD; i++) {
      decisions.push(observeLowYieldTurn(state, spinTurn(INCIDENT_CMD, "139")));
    }
    // 前 THRESHOLD-1 轮都不该触发。
    expect(decisions.slice(0, LOW_YIELD_SPIN_THRESHOLD - 1).every((d) => !d.spinning)).toBe(true);
    const last = decisions[decisions.length - 1];
    expect(last.spinning).toBe(true);
    expect(last.intervene).toBe(true);
    expect(last.repeatTurns).toBe(LOW_YIELD_SPIN_THRESHOLD);
    expect(last.command).toBe(INCIDENT_CMD);
    expect(last.output).toBe("139");
  });

  it("介入文案含具体可执行的替代命令（不是训话）", () => {
    const text = buildLowYieldSpinReminder(INCIDENT_CMD, "139", 5);
    // 三步替代法都要在：落盘 + 计数 + 切片。
    expect(text).toContain("> /tmp/check.txt 2>&1");
    expect(text).toContain("wc -l /tmp/check.txt");
    expect(text).toContain("head -50 /tmp/check.txt");
    // 必须保留原检查命令主体，模型可直接粘贴。
    expect(text).toContain("bunx tsc --noEmit 2>&1");
    // 必须点出根因（只回一个计数，无法指导下一步），而不是只说"别再跑了"。
    expect(text).toContain("只返回一个计数");
    expect(text).toContain("139");
    expect(text).toContain("<system-reminder>");
    // 明确要求现在就开始编辑——给出路而非施压。
    expect(text).toContain("edit");
  });

  it("封顶：介入 MAX 次后保持沉默，且**绝不**强制收尾", () => {
    const state = createLowYieldSpinState();
    let interventions = 0;
    let stillSpinning = 0;
    for (let i = 0; i < 20; i++) {
      const d = observeLowYieldTurn(state, spinTurn(INCIDENT_CMD, "139"));
      if (d.intervene) interventions++;
      if (d.spinning) stillSpinning++;
    }
    expect(interventions).toBe(MAX_LOW_YIELD_INTERVENTIONS);
    // 达阈值后每轮都仍判定 spinning（状态如实），但不再介入。
    expect(stillSpinning).toBeGreaterThan(MAX_LOW_YIELD_INTERVENTIONS);
    // 决策结构里没有 terminate 概念——本阀刻意不掐断任务。
    const d = observeLowYieldTurn(state, spinTurn(INCIDENT_CMD, "139"));
    expect(Object.keys(d)).not.toContain("action");
  });
});

describe("清零条件（避免误伤正当工作）", () => {
  const primed = () => {
    const s = createLowYieldSpinState();
    for (let i = 0; i < LOW_YIELD_SPIN_THRESHOLD - 1; i++) {
      observeLowYieldTurn(s, spinTurn(INCIDENT_CMD, "139"));
    }
    return s;
  };

  it("有文件落盘 → 清零（在干活就不是空转）", () => {
    const s = primed();
    const d = observeLowYieldTurn(s, {
      ...spinTurn(INCIDENT_CMD, "139"),
      hadFileMutation: true,
    });
    expect(d.spinning).toBe(false);
    expect(s.repeatTurns).toBe(0);
  });

  it("有面向用户的文本产出 → 清零（有交付就不是只思考）", () => {
    const s = primed();
    const d = observeLowYieldTurn(s, { ...spinTurn(INCIDENT_CMD, "139"), hadTextOutput: true });
    expect(d.spinning).toBe(false);
  });

  it("返回值变了 → 清零（139→113 是世界在变的证据）", () => {
    const s = primed();
    const d = observeLowYieldTurn(s, spinTurn(INCIDENT_CMD, "113"));
    expect(d.spinning).toBe(false);
    expect(s.repeatTurns).toBe(1);
  });

  it("换了命令 → 清零", () => {
    const s = primed();
    expect(observeLowYieldTurn(s, spinTurn("wc -l /tmp/other.txt", "12")).spinning).toBe(false);
  });

  it("输出不是单标量 → 永不触发（完整错误列表本身就含可执行信息）", () => {
    const s = createLowYieldSpinState();
    const listing = "src/a.ts(1,2): error TS2322\nsrc/b.ts(3,4): error TS2345";
    for (let i = 0; i < 20; i++) {
      expect(observeLowYieldTurn(s, spinTurn("bunx tsc --noEmit", listing)).spinning).toBe(false);
    }
  });

  it("一轮里混有非单标量输出 → 不触发（模型已拿到可执行信息）", () => {
    const s = createLowYieldSpinState();
    const obs: TurnObservation = {
      commands: [INCIDENT_CMD, "bunx tsc --noEmit"],
      outputs: ["139", "src/a.ts(1,2): error TS2322"],
      hadFileMutation: false,
      hadTextOutput: false,
    };
    for (let i = 0; i < 10; i++) expect(observeLowYieldTurn(s, obs).spinning).toBe(false);
  });

  it("没有任何命令的轮次 → 不触发", () => {
    const s = primed();
    const d = observeLowYieldTurn(s, {
      commands: [],
      outputs: [],
      hadFileMutation: false,
      hadTextOutput: false,
    });
    expect(d.spinning).toBe(false);
  });

  it("事故真实序列 139×22 → 136×7 → 113×9：每次值变化都清零，仍能各自触发", () => {
    const s = createLowYieldSpinState();
    let interventions = 0;
    const feed = (value: string, times: number) => {
      for (let i = 0; i < times; i++) {
        if (observeLowYieldTurn(s, spinTurn(INCIDENT_CMD, value)).intervene) interventions++;
      }
    };
    feed("139", 22);
    feed("136", 7);
    feed("113", 9);
    // 每个平台期都有机会介入，但总次数受封顶约束（不会 38 次全催）。
    expect(interventions).toBeGreaterThan(0);
    expect(interventions).toBeLessThanOrEqual(MAX_LOW_YIELD_INTERVENTIONS);
  });
});

describe("extractCommandBody — 剥出检查命令主体", () => {
  it("剥掉 cd 前缀与计数管道，保留 2>&1（否则落盘文件会丢 stderr）", () => {
    expect(extractCommandBody(INCIDENT_CMD)).toBe("bunx tsc --noEmit 2>&1");
  });

  it("无管道时原样返回主体", () => {
    expect(extractCommandBody("cd /a && make lint")).toBe("make lint");
  });

  it("剥掉环境变量赋值前缀", () => {
    expect(extractCommandBody("FOO=1 cd /a && cargo check 2>&1 | wc -l")).toBe("cargo check 2>&1");
  });

  it("取不到主体时返回空串，由调用方回退占位符（不猜命令）", () => {
    expect(extractCommandBody("| wc -l")).toBe("");
    // 猜错的具体命令比占位符更危险，故文案里给 <你的检查命令>。
    expect(buildLowYieldSpinReminder("| wc -l", "5", 5)).toContain("<你的检查命令>");
  });
});
