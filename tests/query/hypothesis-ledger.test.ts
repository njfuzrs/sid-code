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
  collectEvidenceTexts,
  isEmptyResultText,
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

  test("英文 token 要求长度 ≥8（发现 2 收紧），过滤 pid/err/cpu 等易撞车短词", () => {
    // 2026-07-30 负收益防线审计 发现 2：阈值 5 → 8。
    // 旧阈值下 process(7) 会成为 cue；实测 config/output/tools/start 这类 5-7 字母词
    // 在真实 tool_result 上命中率 15%-31%，是 6 次注入全为假阳性的直接原因。
    const cues = extractCues("process_alive crashed pid err cpu");
    expect(cues).toContain("process_alive");
    expect(cues).not.toContain("crashed"); // 7 字母 → 收紧后不再纳入
    expect(cues).not.toContain("pid");
    expect(cues).not.toContain("err");
    expect(cues).not.toContain("cpu");
  });

  test("发现 2：泛化词 config/output/tools/start/length 不再成为 cue", () => {
    const cues = extractCues("若 config 的 output 里 tools 的 start 与 length 不符则推翻");
    for (const w of ["config", "output", "tools", "start", "length"]) {
      expect(cues).not.toContain(w);
    }
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

// ─── 负收益防线审计 发现 2（2026-07-30）：自触发 + 空结果 ───

describe("发现 2：剔除假设工具自身回执（自触发）", () => {
  const resolve = (m: Record<string, string>) => (id: string | undefined) => m[id ?? ""] ?? "";

  test("hypothesis_register 的回执不作为证据（回执逐字复述 falsifier，必然自命中）", () => {
    const results = [
      { type: "tool_result", tool_use_id: "t1", content: "已登记假设 H1。证伪条件: 若 enableSandbox 不存在则推翻" },
      { type: "tool_result", tool_use_id: "t2", content: "grep 输出：src/config.ts:12 enableSandbox" },
    ];
    const texts = collectEvidenceTexts(results, resolve({ t1: "hypothesis_register", t2: "grep" }));
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("grep 输出");
  });

  test("hypothesis_challenge 的回执同样剔除", () => {
    const results = [{ type: "tool_result", tool_use_id: "t1", content: "已裁决 H1 → refuted" }];
    expect(collectEvidenceTexts(results, resolve({ t1: "hypothesis_challenge" })).length).toBe(0);
  });

  test("端到端：register 回执经 collectEvidenceTexts 过滤后不再触发矛盾中断", () => {
    const ledger = new HypothesisLedger();
    const falsifier = "若 enable_sandbox_flag 不存在则假设被推翻";
    ledger.register({ statement: "沙箱开关在 config.ts", falsifier, turn: 1 });
    const receipt = `已登记假设 H1(状态 open)。\n证伪条件: ${falsifier}`;

    // 未过滤（旧行为）：回执命中自己的 cue —— 这正是审计实测到的 2 次自触发
    const unfiltered = new HypothesisLedger();
    unfiltered.register({ statement: "沙箱开关在 config.ts", falsifier, turn: 1 });
    expect(unfiltered.detectContradictions(receipt).length).toBe(1);

    // 过滤后：回执压根不进证据集，零命中
    const texts = collectEvidenceTexts(
      [{ type: "tool_result", tool_use_id: "t1", content: receipt }],
      resolve({ t1: "hypothesis_register" }),
    );
    expect(ledger.detectContradictions(texts).length).toBe(0);
  });

  test("非 tool_result 块与空内容被跳过", () => {
    const results = [
      { type: "text", tool_use_id: "t0", content: "含 alpha" },
      { type: "tool_result", tool_use_id: "t1", content: "" },
      { type: "tool_result", tool_use_id: "t2", content: "真证据" },
    ];
    expect(collectEvidenceTexts(results, resolve({ t2: "grep" }))).toEqual(["真证据"]);
  });
});

describe("发现 2：纯空结果不构成证据", () => {
  test("isEmptyResultText 识别常见空结果文案", () => {
    expect(isEmptyResultText("未找到匹配的内容")).toBe(true);
    expect(isEmptyResultText("  未找到匹配的文件 ")).toBe(true);
    expect(isEmptyResultText("No matches found")).toBe(true);
    // 带后续信息的输出不算空结果（保守判据：必须完全相等）
    expect(isEmptyResultText("未找到匹配的内容，但目录存在 foo.ts")).toBe(false);
    expect(isEmptyResultText("找到 3 处匹配")).toBe(false);
  });

  test("空结果不触发矛盾中断，真证据仍触发", () => {
    const ledger = new HypothesisLedger();
    ledger.register({ statement: "S", falsifier: "若出现 dump_tools_registry 则推翻", turn: 1 });
    expect(ledger.detectContradictions("未找到匹配的内容").length).toBe(0);
    expect(ledger.detectContradictions("代码里有 dump_tools_registry 调用").length).toBe(1);
  });
});

// ─── 负收益防线审计 发现 3（2026-07-30）：指纹伪碰撞致漏报 ───

describe("发现 3：证据指纹改全文 hash（消除前 120 字符伪碰撞）", () => {
  // 真实语料里的高频重复前缀，长度已超 120 字符
  const PREFIX =
    "文件已编辑: /Users/x/Code/person/sid-code/docs/reference/官网文档覆盖度核对报告.md（替换了 1 处）"
    + "该文件较长，仅展示改动附近内容以便核对上下文，请确认无误后再继续后续步骤，"
    + "如需回退可使用 undo 命令恢复到本次编辑之前的状态：";

  test("前 120 字符相同但内容不同 → 第二条的真矛盾不再被静默吞掉", () => {
    expect(PREFIX.length).toBeGreaterThan(120);
    const ledger = new HypothesisLedger();
    ledger.register({ statement: "S", falsifier: "若存在 index_of_end_raw 裸调用则推翻", turn: 1 });

    // 第 1 轮：同前缀、无矛盾
    expect(ledger.detectContradictions(PREFIX + "第一轮改的是标题层级，无关内容").length).toBe(0);
    // 第 2 轮：同前缀、含真矛盾。旧 slice(0,120) 指纹会判为"同一证据"直接跳过 → 漏报
    const hits = ledger.detectContradictions(PREFIX + "第二轮改的是 index_of_end_raw 裸调用处");
    expect(hits.length).toBe(1);
    expect(hits[0].matchedCue).toBe("index_of_end_raw");
  });

  test("真实重复的同一条证据仍被去重（不能改坏去重本意）", () => {
    const ledger = new HypothesisLedger();
    ledger.register({ statement: "S", falsifier: "若存在 index_of_end_raw 则推翻", turn: 1 });
    const same = "输出里有 index_of_end_raw";
    expect(ledger.detectContradictions(same).length).toBe(1);
    expect(ledger.detectContradictions(same).length).toBe(0);
    // 仅空白差异视为同一条
    expect(ledger.detectContradictions("输出里有   index_of_end_raw  ").length).toBe(0);
  });

  test("逐条数组入参：各条各算指纹，一条被去重不影响其它条", () => {
    const ledger = new HypothesisLedger();
    ledger.register({ statement: "S1", falsifier: "若存在 alpha_marker_long 则推翻", turn: 1 });
    ledger.register({ statement: "S2", falsifier: "若存在 beta_marker_long 则推翻", turn: 1 });
    const hits = ledger.detectContradictions(["含 alpha_marker_long", "含 beta_marker_long"]);
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.hypothesisId).sort()).toEqual(["H1", "H2"]);
  });

  test("同一轮内多条证据都撞同一假设 → 只产出一条命中（不重复打扰）", () => {
    const ledger = new HypothesisLedger();
    ledger.register({ statement: "S", falsifier: "若存在 alpha_marker_long 则推翻", turn: 1 });
    const hits = ledger.detectContradictions([
      "第一条含 alpha_marker_long",
      "第二条也含 alpha_marker_long",
    ]);
    expect(hits.length).toBe(1);
  });

  test("字符串入参向后兼容（视为单条证据）", () => {
    const ledger = new HypothesisLedger();
    ledger.register({ statement: "S", falsifier: "若存在 alpha_marker_long 则推翻", turn: 1 });
    expect(ledger.detectContradictions("含 alpha_marker_long").length).toBe(1);
  });
});
