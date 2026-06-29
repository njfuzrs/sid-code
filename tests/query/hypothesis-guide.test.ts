/**
 * 假设纪律首轮引导单测（query/hypothesis-guide.ts，修复"防线零触发"）
 *
 * 覆盖：AND 检测（路径+动词同时满足才触发）、各类不误伤反例、已知盲区（无路径核查）、
 * reminder 文本为"建议非强制"且含"请勿向用户复述"约束。
 */

import { describe, test, expect } from "bun:test";
import {
  detectInvestigationContext,
  buildHypothesisGuideReminder,
} from "../../src/query/hypothesis-guide.ts";

describe("detectInvestigationContext — AND 条件触发", () => {
  test("路径 + 调查性动词同时出现 → 触发", () => {
    expect(detectInvestigationContext("检查 docs/方案.md 里的规划是否在代码中落地")).toBe(true);
    expect(detectInvestigationContext("帮我核验 src/query/loop.ts 是否漏了重置")).toBe(true);
    expect(detectInvestigationContext("对照 docs/spec.md 排查 src/app.ts 的实现")).toBe(true);
  });

  test("形如 a/b.ext 的裸路径 + 动词 → 触发", () => {
    expect(detectInvestigationContext("定位一下 query/engine.ts 里的根因")).toBe(true);
  });
});

describe("detectInvestigationContext — 不误伤反例（单条件不触发）", () => {
  test("只有路径、无调查性动词 → 不触发（可能只是想读代码）", () => {
    expect(detectInvestigationContext("帮我看 src/app.ts")).toBe(false);
    expect(detectInvestigationContext("打开 docs/readme.md 给我讲讲")).toBe(false);
  });

  test("只有调查性动词、无路径 → 不触发（可能随口一说）", () => {
    expect(detectInvestigationContext("检查一下有没有 bug")).toBe(false);
    expect(detectInvestigationContext("帮我排查下这个问题")).toBe(false);
  });

  test("日常任务（翻译/修 typo/加功能/读函数）→ 不触发", () => {
    expect(detectInvestigationContext("把这段翻译成英文")).toBe(false);
    expect(detectInvestigationContext("这个函数是干嘛的")).toBe(false);
    expect(detectInvestigationContext("给登录加个记住密码功能")).toBe(false);
  });

  test("空串 / 无意义输入 → 不触发", () => {
    expect(detectInvestigationContext("")).toBe(false);
    expect(detectInvestigationContext("你好")).toBe(false);
  });
});

describe("detectInvestigationContext — 已知盲区（方案 Q2 正视，非 bug）", () => {
  test("无路径锚点的纯自然语言核查 → 不触发（由 system-prompt 常驻引导兜底）", () => {
    // "检查假设登记这套机制到底生效没有" 无 .ts/src/ 等路径特征 → AND 第一条件不满足。
    // 这是 AND 设计的固有代价，验收时记录为预期行为而非缺陷。
    expect(detectInvestigationContext("检查假设登记这套机制到底生效没有")).toBe(false);
  });
});

describe("buildHypothesisGuideReminder — 文本约束", () => {
  test("含 hypothesis_register 工具引导与证伪条件提示", () => {
    const r = buildHypothesisGuideReminder();
    expect(r).toContain("hypothesis_register");
    expect(r).toContain("证伪条件");
    expect(r).toContain("file:line");
  });

  test("是建议而非强制（保留模型裁量权）", () => {
    const r = buildHypothesisGuideReminder();
    expect(r).toContain("建议而非强制");
  });

  test("含 system-reminder 包裹与'请勿向用户复述'约束", () => {
    const r = buildHypothesisGuideReminder();
    expect(r).toContain("<system-reminder>");
    expect(r).toContain("请勿向用户");
  });
});
