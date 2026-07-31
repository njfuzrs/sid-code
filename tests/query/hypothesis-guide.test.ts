/**
 * 假设纪律首轮引导单测（query/hypothesis-guide.ts，修复"防线零触发"）
 *
 * 覆盖三层判定逻辑：
 * - Layer 1: AND 条件（路径+动词同时满足）
 * - Layer 2: HIGH_SIGNAL_PHRASES 直接触发（无需路径）
 * - Layer 3: JSON title 提取后重新走 Layer 1+2
 * - 不误伤反例
 * - reminder 文本约束
 */

import { describe, test, expect } from "bun:test";
import {
  detectInvestigationContext,
  buildJudgmentGuideReminder,
  buildMinimalGuideReminder,
} from "../../src/query/hypothesis-guide.ts";

// ─── Layer 1: AND 条件（路径 + 调查性动词） ───

describe("Layer 1: AND 条件触发", () => {
  test("路径 + 中文调查性动词同时出现 → 触发", () => {
    expect(detectInvestigationContext("检查 docs/方案.md 里的规划是否在代码中落地")).toBe(true);
    expect(detectInvestigationContext("帮我核验 src/query/loop.ts 是否漏了重置")).toBe(true);
    expect(detectInvestigationContext("对照 docs/spec.md 排查 src/app.ts 的实现")).toBe(true);
  });

  test("形如 a/b.ext 的裸路径 + 动词 → 触发", () => {
    expect(detectInvestigationContext("定位一下 query/engine.ts 里的根因")).toBe(true);
  });

  test("路径 + 英文调查词 → 触发", () => {
    expect(detectInvestigationContext("audit the src/auth module for vulnerabilities")).toBe(true);
    expect(detectInvestigationContext("verify that tests/unit.test.ts covers the edge case")).toBe(true);
    expect(detectInvestigationContext("investigate root cause in src/query/loop.ts")).toBe(true);
    expect(detectInvestigationContext("scan src/ for deprecated API usage")).toBe(true);
    expect(detectInvestigationContext("trace the call chain from src/app.ts")).toBe(true);
    expect(detectInvestigationContext("diagnose why tests/integration.test.ts fails")).toBe(true);
  });

  test("路径 + 新增中文词（追踪/溯源/逐项/复盘）→ 触发", () => {
    expect(detectInvestigationContext("追踪 src/query/loop.ts 的调用链")).toBe(true);
    expect(detectInvestigationContext("溯源 docs/api.md 中的描述与实现的差异")).toBe(true);
    expect(detectInvestigationContext("逐项对 src/tool/ 下的工具做检查")).toBe(true);
    expect(detectInvestigationContext("复盘 tests/query/ 里的失败用例")).toBe(true);
  });

  test("API 关键词作为路径信号 + 动词 → 触发", () => {
    expect(detectInvestigationContext("检查 API 返回的数据格式是否正确")).toBe(true);
    expect(detectInvestigationContext("verify the API response schema")).toBe(true);
  });
});

describe("Layer 1: 单条件不触发（AND 的正确排除）", () => {
  test("只有路径、无调查性动词 → 不触发", () => {
    expect(detectInvestigationContext("帮我看 src/app.ts")).toBe(false);
    expect(detectInvestigationContext("打开 docs/readme.md 给我讲讲")).toBe(false);
    expect(detectInvestigationContext("重构 src/query/loop.ts 的错误处理")).toBe(false);
  });

  test("只有弱调查性动词、无路径 → 不触发（AND 盲区，由 Layer 2 部分覆盖）", () => {
    expect(detectInvestigationContext("检查一下有没有 bug")).toBe(false);
    expect(detectInvestigationContext("帮我定位下这个问题")).toBe(false);
  });
});

// ─── Layer 2: HIGH_SIGNAL_PHRASES 直接触发 ───

describe("Layer 2: 高信号短语直接触发（无需路径）", () => {
  test("'是否X落地/生效/实现/修复' 模式 → 触发", () => {
    expect(detectInvestigationContext("先跑 promptfoo 看 P0 修复是否生效")).toBe(true);
    expect(detectInvestigationContext("这个方案是否实现了")).toBe(true);
    expect(detectInvestigationContext("上次提的需求是否落地")).toBe(true);
    expect(detectInvestigationContext("那个 bug 是否修复完成")).toBe(true);
  });

  test("'根因' 裸词 → 触发", () => {
    expect(detectInvestigationContext("帮我找根因")).toBe(true);
    expect(detectInvestigationContext("这个问题的根因是什么")).toBe(true);
  });

  test("'审计' 裸词 → 触发", () => {
    expect(detectInvestigationContext("对这个模块做个审计")).toBe(true);
  });

  test("'复盘' 裸词 → 触发", () => {
    expect(detectInvestigationContext("我们来复盘一下上次的事故")).toBe(true);
  });

  test("'逐项检查/核验' 模式 → 触发", () => {
    expect(detectInvestigationContext("逐项检查所有配置项")).toBe(true);
    expect(detectInvestigationContext("逐项核验这些条目")).toBe(true);
    expect(detectInvestigationContext("逐项确认每个步骤")).toBe(true);
  });

  test("'对照X检查Y' 模式 → 触发", () => {
    expect(detectInvestigationContext("对照规范检查实现")).toBe(true);
    expect(detectInvestigationContext("对照设计稿核查代码")).toBe(true);
  });

  test("'排查X原因/问题' 模式 → 触发", () => {
    expect(detectInvestigationContext("排查超时原因")).toBe(true);
    expect(detectInvestigationContext("排查内存泄漏问题")).toBe(true);
    expect(detectInvestigationContext("排查这个 bug 的故障点")).toBe(true);
  });

  test("'链路追踪/排查' 模式 → 触发", () => {
    expect(detectInvestigationContext("链路追踪一下消息传递过程")).toBe(true);
    expect(detectInvestigationContext("对消息链路排查")).toBe(true);
  });

  test("英文 'root cause' → 触发", () => {
    expect(detectInvestigationContext("find the root cause of this failure")).toBe(true);
    expect(detectInvestigationContext("Root Cause Analysis")).toBe(true);
  });

  test("英文 'audit' 裸词 → 触发", () => {
    expect(detectInvestigationContext("do a security audit")).toBe(true);
    expect(detectInvestigationContext("Audit the permissions system")).toBe(true);
  });
});

// ─── Layer 3: JSON title 提取 ───

describe("Layer 3: JSON title 提取后重新检测", () => {
  test("JSON title 含调查词+路径 → 触发（Layer 1 on title）", () => {
    expect(detectInvestigationContext('{"title": "检查 src/query 模块是否落地"}')).toBe(true);
    expect(detectInvestigationContext('{"title":"核验 docs/spec.md 的规划"}')).toBe(true);
  });

  test("JSON title 含高信号短语 → 触发（Layer 2 on title）", () => {
    expect(detectInvestigationContext('{"title": "检查设计文档落地实现情况"}')).toBe(true);
    expect(detectInvestigationContext('{"title": "排查超时问题"}')).toBe(true);
    expect(detectInvestigationContext('{"title": "逐项核验所有缺陷"}')).toBe(true);
    expect(detectInvestigationContext('{"title": "复盘上线事故"}')).toBe(true);
  });

  test("JSON title 无调查信号 → 不触发", () => {
    expect(detectInvestigationContext('{"title": "新建用户模块"}')).toBe(false);
    expect(detectInvestigationContext('{"title": "实现登录功能"}')).toBe(false);
    expect(detectInvestigationContext('{"title": "重构代码结构"}')).toBe(false);
  });
});

// ─── 不误伤反例 ───

describe("不误伤反例", () => {
  test("日常任务 → 不触发", () => {
    expect(detectInvestigationContext("把这段翻译成英文")).toBe(false);
    expect(detectInvestigationContext("这个函数是干嘛的")).toBe(false);
    expect(detectInvestigationContext("给登录加个记住密码功能")).toBe(false);
    expect(detectInvestigationContext("帮我修个 typo")).toBe(false);
  });

  test("空串 / 无意义输入 → 不触发", () => {
    expect(detectInvestigationContext("")).toBe(false);
    expect(detectInvestigationContext("你好")).toBe(false);
    expect(detectInvestigationContext("继续")).toBe(false);
  });

  test("未加入的泛词不触发（分析/梳理/确认/check）", () => {
    expect(detectInvestigationContext("分析一下这段代码的时间复杂度")).toBe(false);
    expect(detectInvestigationContext("帮我梳理下目录结构")).toBe(false);
    expect(detectInvestigationContext("确认一下你理解对了")).toBe(false);
    expect(detectInvestigationContext("check this out")).toBe(false);
    expect(detectInvestigationContext("let me check the code")).toBe(false);
  });

  test("路径 + 无关动词 → 不触发", () => {
    expect(detectInvestigationContext("重构 src/utils.ts")).toBe(false);
    expect(detectInvestigationContext("给 docs/readme.md 加个目录")).toBe(false);
    expect(detectInvestigationContext("删除 tests/old.test.ts")).toBe(false);
  });

  test("含 'audit' 但在非独立词位置 → 不触发", () => {
    // \baudit\b 用 word boundary，不匹配 auditorium
    expect(detectInvestigationContext("visit the auditorium")).toBe(false);
  });
});

// ─── 残余盲区（文档化为预期行为） ───

describe("残余盲区（预期行为，非 bug）", () => {
  test("无路径+无高信号短语的泛泛调查 → 不触发（由 system-prompt 常驻引导兜底）", () => {
    // "检查一下有没有 bug" 没有路径也没命中 HIGH_SIGNAL_PHRASES 组合模式
    expect(detectInvestigationContext("帮我检查一下有没有内存泄漏")).toBe(false);
  });

  test("纯中性描述的复杂任务 → 不触发（无调查信号，靠模型自觉）", () => {
    expect(detectInvestigationContext("I'll start by scanning the source code structure")).toBe(false);
    expect(detectInvestigationContext("让我来看看这个项目的整体架构")).toBe(false);
  });
});

// ─── reminder 文本约束 ───

// 缺口3：原 buildHypothesisGuideReminder（turn-1 完整引导）已删除，内容一分为二：
//   - "该用这套机制"一句 → buildMinimalGuideReminder（turn-1 兜底，极简）;
//   - "先 read 再下结论"/"附 file:line" → buildJudgmentGuideReminder（紧贴判断形成的时机）。
// 原三条断言在此按新归属逐条保留，一条不丢。
describe("buildMinimalGuideReminder — turn-1 降级兜底的文本约束", () => {
  test("含 hypothesis_register 工具引导与证伪条件提示", () => {
    const r = buildMinimalGuideReminder();
    expect(r).toContain("hypothesis_register");
    expect(r).toContain("证伪条件");
  });

  test("含 system-reminder 包裹与'请勿向用户复述'约束", () => {
    const r = buildMinimalGuideReminder();
    expect(r).toContain("<system-reminder>");
    expect(r).toContain("请勿向用户");
  });

  test("确实是「极简」——显著短于完整引导，篇幅让给真正用得上的时机", () => {
    // 降级的意义在于篇幅：turn-1 只留一句，完整引导交给 judgment 通道。
    // 若哪天有人把内容加回来，这条会失败并提醒他先读缺口3 的时机论证。
    expect(buildMinimalGuideReminder().length).toBeLessThan(
      buildJudgmentGuideReminder().length,
    );
  });
});

describe("buildJudgmentGuideReminder — 事件驱动引导的文本约束", () => {
  test("含 hypothesis_register 工具引导与证伪条件提示", () => {
    const r = buildJudgmentGuideReminder();
    expect(r).toContain("hypothesis_register");
    expect(r).toContain("证伪条件");
  });

  test("承接原 turn-1 引导的两条配套习惯（含 file:line 证据指针）", () => {
    const r = buildJudgmentGuideReminder();
    expect(r).toContain("file:line");
    expect(r).toContain("先 read 该文件");
  });

  test("是建议而非强制（保留模型裁量权）", () => {
    expect(buildJudgmentGuideReminder()).toContain("建议而非强制");
  });

  test("含 system-reminder 包裹与'请勿向用户复述'约束", () => {
    const r = buildJudgmentGuideReminder();
    expect(r).toContain("<system-reminder>");
    expect(r).toContain("请勿向用户");
  });
});
