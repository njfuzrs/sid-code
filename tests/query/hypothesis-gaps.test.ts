/**
 * 八缺口修复的单测（docs/bugfixes/todo/20260731-hypothesis假设纪律-元认知外化六缺口修复设计.md）
 *
 * 分组对应设计文档的缺口编号：
 * - 缺口1：confirmed 曾是**单向吸收态**——`falsifier` 不可修改防的是"事后挪动靶子"，
 *   却没有任何机制防"提前宣布胜利"，而后者达到完全相同的效果（让未充分验证的判断
 *   免于审查）且更省事。修法：矛盾检测纳入 confirmed + reopen 出口 + 门禁第二道闸。
 * - 缺口2：三道机制全部作用在**登记表状态**上，没有一处看过模型实际写出的字。
 *   修法：交付物文本复用检查（层次1）+ 登记表中段空转的续期提醒（层次2）。
 * - 缺口3：引导注入绑死 turnCount===1（任务开头），而判断在第 10-30 轮才形成。
 *   修法：改为"刚写下断言"时事件驱动注入。
 * - 缺口4：`keep_open` **无条件** push 进 refuting——"有支持证据但不够定论"没有出口，
 *   三元裁决事实上二元化。修法：evidenceDirection + neutral 数组。
 * - 缺口5：cue 过了静态长度门槛不等于在本任务语境里够特异。修法：会话内词频抑制。
 * - 缺口7：`LoopState.turnCount` 每条用户消息归零，与会话累计的 AfterModel.index
 *   同以 `turn` 之名落盘，跨消息分析静默给出错误结论。修法：absoluteTurn + promptSeq。
 * - 缺口8：裁决此前**零埋点**，"confirm 时平均握有几条带 source 的证据"无法回答。
 */

import { test, expect, describe } from "bun:test";
import {
  HypothesisLedger,
  buildContradictionReminder,
  buildDeliveryGateReminder,
  buildRefutedReuseReminder,
  buildStaleLedgerReminder,
  detectRefutedReuse,
  refutedStatementIdentifiers,
  HYPOTHESIS_STALE_TURNS,
  MAX_REOPEN_CHALLENGES,
  SESSION_CUE_FREQ_THRESHOLD,
  isHypothesisEnabled,
} from "../../src/query/hypothesis-ledger.ts";
import {
  buildJudgmentGuideReminder,
  buildMinimalGuideReminder,
  detectInvestigateToEditTransition,
  detectUnregisteredJudgment,
  hasReadOnlyProbe,
} from "../../src/query/hypothesis-guide.ts";
import {
  appendDeliverableText,
  extractDeliverableText,
  getDeliverableText,
  isDeliverableTool,
  resetDeliverableText,
  DELIVERABLE_BUFFER_LIMIT,
} from "../../src/query/deliverable-text.ts";
import { SessionState } from "../../src/session/state.ts";

/** 造一条 cue 足够长、可稳定命中的假设（长度须过 MIN_EN_CUE_LENGTH=8 门槛）。 */
function registerWithCue(ledger: HypothesisLedger, cue: string, turn = 1) {
  return ledger.register({
    statement: `问题出在 ${cue} 这个函数`,
    falsifier: `若 ${cue} 未被调用则推翻`,
    falsifierCues: [cue],
    turn,
  });
}

// ─────────────────────── 缺口1：confirmed 可翻案 ───────────────────────

describe("缺口1：confirmed 不再是单向吸收态", () => {
  test("已 confirmed 的假设仍会被新证据挑战，并标记 afterConfirm", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({
      id: h.id,
      verdict: "confirm",
      evidence: { note: "读代码确认" },
      turn: 2,
    });
    expect(ledger.get(h.id)!.status).toBe("confirmed");

    const hits = ledger.detectContradictions(["日志显示 handleconnection 从未被调用"]);
    expect(hits.length).toBe(1);
    expect(hits[0]!.afterConfirm).toBe(true);
    // 事实必须留痕——它要进交付门禁文案
    expect(ledger.get(h.id)!.challengedAfterConfirm).toBe(1);
    // 状态本身不被自动改写：裁决权仍在模型手里（机制只负责逼它面对证据）
    expect(ledger.get(h.id)!.status).toBe("confirmed");
  });

  test("refuted 是终态，不再被挑战（避免翻来覆去不收敛）", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "refute", evidence: { note: "反证" }, turn: 2 });
    const hits = ledger.detectContradictions(["日志显示 handleconnection 从未被调用"]);
    expect(hits.length).toBe(0);
  });

  test("翻案中断有打扰上限，但 challengedAfterConfirm 事实继续累加", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 2 });

    // 每次用不同证据文本（否则会被指纹去重，测不到上限逻辑）
    for (let i = 0; i < MAX_REOPEN_CHALLENGES; i++) {
      const hits = ledger.detectContradictions([`第 ${i} 条反证：handleconnection 未调用`]);
      expect(hits.length).toBe(1);
    }
    expect(ledger.get(h.id)!.reopenChallengeCount).toBe(MAX_REOPEN_CHALLENGES);

    // 超预算后不再注入
    const extra = ledger.detectContradictions(["又一条反证：handleconnection 未调用"]);
    expect(extra.length).toBe(0);
    // 但已记录的事实不被抹掉
    expect(ledger.get(h.id)!.challengedAfterConfirm).toBe(MAX_REOPEN_CHALLENGES);
  });

  test("reopen 把 confirmed 退回 open，重新受交付门禁约束", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 2 });
    expect(ledger.hasUnsettled()).toBe(false); // confirmed 不算未结清

    ledger.challenge({ id: h.id, verdict: "reopen", evidence: { note: "新反证" }, turn: 3 });
    expect(ledger.get(h.id)!.status).toBe("open");
    expect(ledger.hasUnsettled()).toBe(true);
  });

  test("reopen 一条 refuted 假设被拒绝（终态不可翻案）", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "refute", evidence: { note: "反证" }, turn: 2 });
    expect(() =>
      ledger.challenge({ id: h.id, verdict: "reopen", evidence: { note: "想翻案" }, turn: 3 }),
    ).toThrow(/终态|不可翻案/);
  });

  test("门禁闸门：全部 confirmed 但有被挑战过的 → hasChallengedConfirmed 拦下", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 2 });
    expect(ledger.hasUnsettled()).toBe(false);
    expect(ledger.hasChallengedConfirmed()).toBe(false);

    ledger.detectContradictions(["反证：handleconnection 未调用"]);
    // hasUnsettled 口径刻意不变（否则每条确认假设都拦一道、误伤正常交付）
    expect(ledger.hasUnsettled()).toBe(false);
    // 第二道闸门负责拦它
    expect(ledger.hasChallengedConfirmed()).toBe(true);
    expect(ledger.challengedConfirmed().map((x) => x.id)).toEqual([h.id]);
  });

  test("翻案中断文案是「请确认结论仍成立」而非指责，且给出 reopen 出路", () => {
    const text = buildContradictionReminder([
      {
        hypothesisId: "H1",
        statement: "问题出在 A",
        falsifier: "若 B 则推翻",
        matchedCue: "bbbbbbbb",
        evidenceSnippet: "证据片段",
        afterConfirm: true,
      },
    ]);
    expect(text).toContain("已经确认过");
    expect(text).toContain("reopen");
    // 缺口6 同款纪律：不能是指责语气（会诱发自我批判、浪费推理预算）。
    // 措辞主动否掉"你错了"这层读解，并把默认归因给"词面撞车"而非模型失误。
    expect(text).toContain("这不是说你确认错了");
    expect(text).toContain("多半只是词面撞车");
    // 且必须给出"无需任何动作"的出路——复核后仍成立是最常见的结局
    expect(text).toContain("无需任何动作");
  });

  test("门禁文案包含「确认后被打脸 N 次」的事实", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 2 });
    ledger.detectContradictions(["反证：handleconnection 未调用"]);

    const text = buildDeliveryGateReminder([], ledger.challengedConfirmed());
    expect(text).toContain("H1");
    expect(text).toContain("1 条证据命中过它的证伪条件");
    expect(text).toContain("reopen");
  });

  test("两个条件都不满足时门禁文案为空串（不无谓打扰）", () => {
    expect(buildDeliveryGateReminder([], [])).toBe("");
  });
});

// ─────────────────────── 缺口4：keep_open 证据归属 ───────────────────────

describe("缺口4：keep_open 的证据按方向落位（原为无条件进 refuting）", () => {
  test("keep_open + supporting → 进 supporting，不再被错记成反驳", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({
      id: h.id,
      verdict: "keep_open",
      evidence: { note: "grep 到 3 处调用点符合预期，但没看到运行结果" },
      evidenceDirection: "supporting",
      turn: 2,
    });
    const got = ledger.get(h.id)!;
    expect(got.supporting.length).toBe(1);
    expect(got.refuting.length).toBe(0);
    expect(got.neutral.length).toBe(0);
    expect(got.status).toBe("open");
  });

  test("keep_open + refuting → 进 refuting（旧行为在此方向下仍正确）", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({
      id: h.id,
      verdict: "keep_open",
      evidence: { note: "没出现预期报错，倾向不成立" },
      evidenceDirection: "refuting",
      turn: 2,
    });
    expect(ledger.get(h.id)!.refuting.length).toBe(1);
    expect(ledger.get(h.id)!.neutral.length).toBe(0);
  });

  test("keep_open 不给方向 → 进 neutral，而不是硬塞进 refuting 伪造方向", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({
      id: h.id,
      verdict: "keep_open",
      evidence: { note: "读到相关代码但看不出是否影响该路径" },
      turn: 2,
    });
    const got = ledger.get(h.id)!;
    expect(got.neutral.length).toBe(1);
    expect(got.refuting.length).toBe(0);
    expect(got.supporting.length).toBe(0);
  });

  test("confirm/refute 的方向由 verdict 决定，evidenceDirection 不干扰", () => {
    const ledger = new HypothesisLedger();
    const h1 = registerWithCue(ledger, "handleconnection");
    ledger.challenge({
      id: h1.id,
      verdict: "confirm",
      evidence: { note: "确认" },
      evidenceDirection: "refuting", // 刻意给反方向，应被忽略
      turn: 2,
    });
    expect(ledger.get(h1.id)!.supporting.length).toBe(1);
    expect(ledger.get(h1.id)!.refuting.length).toBe(0);
  });

  test("keep_open 的 neutral 证据不污染连续推翻计数（换策略判据）", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "keep_open", evidence: { note: "存疑" }, turn: 2 });
    // 仍是 open，不该被算成"推翻"
    expect(ledger.consecutiveRefutations()).toBe(0);
  });
});

// ─────────────────────── 缺口5：会话内 cue 词频抑制 ───────────────────────

describe("缺口5：会话内高频泛化 cue 的命中抑制", () => {
  test("首次命中永远放行（一次都没提醒过就静音是不可接受的）", () => {
    const ledger = new HypothesisLedger();
    registerWithCue(ledger, "playwright");
    const hits = ledger.detectContradictions(["用 playwright 跑了一遍"]);
    expect(hits.length).toBe(1);
  });

  test("阈值取 6 而非 5：实测噪音峰值 onrender/playwright=5 一次都不被抑制", () => {
    expect(SESSION_CUE_FREQ_THRESHOLD).toBe(6);
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "playwright");
    // 模拟实测最坏噪音样本：本会话共 5 条证据含该词
    for (let i = 0; i < 5; i++) ledger.observeEvidence([`第 ${i} 次用 playwright`]);
    expect(ledger.cueFrequencySnapshot()["playwright"]).toBe(5);
    // 频次 5 不大于阈值 6 → 不抑制（刻意保守：只抑制比已知最坏情况还泛化的词）
    const hits = ledger.detectContradictions([`新证据：playwright 没跑 ${h.id}`]);
    expect(hits.length).toBe(1);
  });

  test("超过阈值后跳过命中，但 cue 本身不被删除（漏报是最怕的失效方向）", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "playwright");
    for (let i = 0; i < SESSION_CUE_FREQ_THRESHOLD + 1; i++) {
      ledger.observeEvidence([`第 ${i} 次提到 playwright`]);
    }
    const hits = ledger.detectContradictions(["又一条含 playwright 的输出"]);
    expect(hits.length).toBe(0);
    // 只跳过命中，cue 仍在登记表里
    expect(ledger.get(h.id)!.falsifierCues).toContain("playwright");
  });

  test("observeEvidence 按「含该词的证据条数」计，同一条里出现多次只算 1", () => {
    const ledger = new HypothesisLedger();
    registerWithCue(ledger, "playwright");
    ledger.observeEvidence(["playwright playwright playwright playwright"]);
    expect(ledger.cueFrequencySnapshot()["playwright"]).toBe(1);
  });

  test("只统计登记表在用的 cue，不为无关词无限增长", () => {
    const ledger = new HypothesisLedger();
    registerWithCue(ledger, "playwright");
    ledger.observeEvidence(["完全无关的一段 somethingelse 输出"]);
    expect(Object.keys(ledger.cueFrequencySnapshot())).toEqual([]);
  });

  test("空结果文本不计入频次（它本就不算证据）", () => {
    const ledger = new HypothesisLedger();
    registerWithCue(ledger, "playwright");
    ledger.observeEvidence(["未找到匹配的内容"]);
    expect(ledger.cueFrequencySnapshot()["playwright"]).toBeUndefined();
  });

  test("reset() 清空词频表（/clear 后旧语境不该继续静音某个 cue）", () => {
    const ledger = new HypothesisLedger();
    registerWithCue(ledger, "playwright");
    ledger.observeEvidence(["playwright"]);
    ledger.reset();
    expect(ledger.cueFrequencySnapshot()).toEqual({});
  });
});

// ─────────────────────── 缺口2：门禁与交付物挂钩 ───────────────────────

describe("缺口2 层次1：交付物复用已推翻说法的检查", () => {
  test("交付物里出现 refuted 假设的具体标识符 → 命中", () => {
    const ledger = new HypothesisLedger();
    const h = ledger.register({
      statement: "根因是 renderloopscheduler 里的重复调度",
      falsifier: "若该调度只发生一次则推翻",
      turn: 1,
    });
    ledger.challenge({ id: h.id, verdict: "refute", evidence: { note: "只调度一次" }, turn: 2 });

    const hits = detectRefutedReuse(
      ledger.refutedItems(),
      "## 根因\n经排查，问题出在 renderloopscheduler 的重复调度。",
    );
    expect(hits.length).toBe(1);
    expect(hits[0]!.hypothesisId).toBe(h.id);
    expect(hits[0]!.matchedIdentifier).toBe("renderloopscheduler");
  });

  test("交付物不含相关标识符 → 不命中（不误报）", () => {
    const ledger = new HypothesisLedger();
    const h = ledger.register({
      statement: "根因是 renderloopscheduler 里的重复调度",
      falsifier: "若该调度只发生一次则推翻",
      turn: 1,
    });
    ledger.challenge({ id: h.id, verdict: "refute", evidence: { note: "反证" }, turn: 2 });
    expect(detectRefutedReuse(ledger.refutedItems(), "完全无关的交付物内容")).toEqual([]);
  });

  test("statement 里的泛化短词不作为匹配依据（复用 sanitizeExplicitCues 门槛）", () => {
    const h = {
      id: "H1",
      statement: "the config is bad",
      falsifier: "x",
      falsifierCues: [],
      status: "refuted" as const,
      supporting: [],
      refuting: [],
      neutral: [],
      createdTurn: 1,
      updatedTurn: 1,
      challengedFingerprints: [],
      challengedAfterConfirm: 0,
      reopenChallengeCount: 0,
      challengesAcknowledged: 0,
    };
    // config(6) 短于 MIN_EN_CUE_LENGTH=8，不该成为标识符——否则任何提到 config
    // 的交付物都会命中，纯误报
    expect(refutedStatementIdentifiers(h)).not.toContain("config");
    expect(detectRefutedReuse([h], "我改了 config 文件")).toEqual([]);
  });

  test("空交付物 / 无 refuted 假设 → 直接返回空", () => {
    expect(detectRefutedReuse([], "任意内容")).toEqual([]);
  });

  test("每条假设最多一条命中（不刷屏）", () => {
    const ledger = new HypothesisLedger();
    const h = ledger.register({
      statement: "renderloopscheduler 和 handleconnection 都有问题",
      falsifier: "若都正常则推翻",
      turn: 1,
    });
    ledger.challenge({ id: h.id, verdict: "refute", evidence: { note: "反证" }, turn: 2 });
    const hits = detectRefutedReuse(
      ledger.refutedItems(),
      "renderloopscheduler 和 handleconnection 都被我写进了结论",
    );
    expect(hits.length).toBe(1);
  });

  test("复用提醒用疑问句，不断言模型写错了", () => {
    const text = buildRefutedReuseReminder([
      { hypothesisId: "H1", statement: "根因是 X", matchedIdentifier: "xxxxxxxxx" },
    ]);
    expect(text).toContain("可能只是词面重合");
    expect(text).toContain("请自查");
    // 明确容许"如实标注已证伪"这一正确做法
    expect(text).toContain("已如实标注");
  });
});

describe("缺口2 层次2：登记表中段空转的续期提醒", () => {
  test("空登记表不提醒（89.7% 的会话不用这套机制，不该被打扰）", () => {
    const ledger = new HypothesisLedger();
    expect(ledger.claimStaleNag(100, HYPOTHESIS_STALE_TURNS)).toBe(false);
  });

  test("未达空转阈值不提醒", () => {
    const ledger = new HypothesisLedger();
    registerWithCue(ledger, "handleconnection", 10);
    expect(ledger.claimStaleNag(10 + HYPOTHESIS_STALE_TURNS - 1, HYPOTHESIS_STALE_TURNS)).toBe(false);
  });

  test("达到阈值提醒，且会话级只给一次", () => {
    const ledger = new HypothesisLedger();
    registerWithCue(ledger, "handleconnection", 10);
    expect(ledger.claimStaleNag(10 + HYPOTHESIS_STALE_TURNS, HYPOTHESIS_STALE_TURNS)).toBe(true);
    // 一次性：判据+置位原子，避免调用方漏置位导致每轮刷屏
    expect(ledger.claimStaleNag(999, HYPOTHESIS_STALE_TURNS)).toBe(false);
  });

  test("假设全部结清后仍会提醒——那正是风险最高的阶段", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection", 5);
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 6 });
    // 判据刻意不要求"有未结清假设"：实测假设集中在会话前 1/4 结清，
    // 之后 32-65 轮空转，而那正是改代码+写交付物的阶段
    expect(ledger.claimStaleNag(6 + HYPOTHESIS_STALE_TURNS, HYPOTHESIS_STALE_TURNS)).toBe(true);
  });

  test("lastActivityTurn 取 created/updated 的最大值", () => {
    const ledger = new HypothesisLedger();
    registerWithCue(ledger, "handleconnection", 3);
    const h2 = registerWithCue(ledger, "renderscheduler", 7);
    ledger.challenge({ id: h2.id, verdict: "confirm", evidence: { note: "x" }, turn: 12 });
    expect(ledger.lastActivityTurn()).toBe(12);
  });

  test("续期提醒文案说明「不登记则三道机制看不到」，并允许忽略", () => {
    const text = buildStaleLedgerReminder(25, 3);
    expect(text).toContain("25");
    expect(text).toContain("3");
    expect(text).toContain("忽略本提醒");
    expect(text).toContain("只出现一次");
  });
});

// ─────────────────────── 缺口2：交付物文本采集 ───────────────────────

describe("缺口2：交付物文本采集（deliverable-text）", () => {
  test("只认写类工具，读类工具的内容是输入而非模型主张", () => {
    expect(isDeliverableTool("write")).toBe(true);
    expect(isDeliverableTool("edit")).toBe(true);
    expect(isDeliverableTool("Write")).toBe(true); // 大小写不敏感
    expect(isDeliverableTool("read")).toBe(false);
    expect(isDeliverableTool("grep")).toBe(false);
    expect(isDeliverableTool("bash")).toBe(false);
  });

  test("提取 write 的 content / edit 的 new_string", () => {
    expect(extractDeliverableText({ file_path: "a.md", content: "结论内容" })).toBe("结论内容");
    expect(
      extractDeliverableText({ file_path: "a.ts", old_string: "旧", new_string: "新" }),
    ).toBe("新");
  });

  test("不提取路径字段——路径里的标识符不是模型的主张", () => {
    const text = extractDeliverableText({
      file_path: "src/query/renderloopscheduler.ts",
      content: "无关内容",
    });
    expect(text).not.toContain("renderloopscheduler");
  });

  test("edit 只取 new_string，不取被替换掉的 old_string", () => {
    const text = extractDeliverableText({ old_string: "被删的旧结论", new_string: "新内容" });
    expect(text).not.toContain("被删的旧结论");
  });

  test("multi_edit 汇总各条 new_string", () => {
    const text = extractDeliverableText({
      edits: [{ new_string: "第一段" }, { new_string: "第二段" }],
    });
    expect(text).toContain("第一段");
    expect(text).toContain("第二段");
  });

  test("非对象入参 / 无内容字段 → 空串（采集尽力而为，不抛错）", () => {
    expect(extractDeliverableText(null)).toBe("");
    expect(extractDeliverableText("字符串")).toBe("");
    expect(extractDeliverableText({ file_path: "只有路径" })).toBe("");
  });

  test("追加与读取；非写类工具被跳过", () => {
    const ss = new SessionState("s1");
    appendDeliverableText(ss, "write", { content: "第一段" });
    appendDeliverableText(ss, "read", { content: "不该进来" });
    appendDeliverableText(ss, "edit", { new_string: "第二段" });
    const buf = getDeliverableText(ss);
    expect(buf).toContain("第一段");
    expect(buf).toContain("第二段");
    expect(buf).not.toContain("不该进来");
  });

  test("超限丢头保尾（最终结论通常写在最后）", () => {
    const ss = new SessionState("s1");
    appendDeliverableText(ss, "write", { content: "开头标记" + "x".repeat(DELIVERABLE_BUFFER_LIMIT) });
    appendDeliverableText(ss, "write", { content: "结尾标记" });
    const buf = getDeliverableText(ss);
    expect(buf.length).toBeLessThanOrEqual(DELIVERABLE_BUFFER_LIMIT);
    expect(buf).toContain("结尾标记");
    expect(buf).not.toContain("开头标记");
  });

  test("reset 清空缓冲", () => {
    const ss = new SessionState("s1");
    appendDeliverableText(ss, "write", { content: "内容" });
    resetDeliverableText(ss);
    expect(getDeliverableText(ss)).toBe("");
  });
});

// ─────────────────────── 缺口3：引导注入时机 ───────────────────────

describe("缺口3：事件驱动的引导注入判据", () => {
  test("识别中文因果/结论断言", () => {
    const long = "。".repeat(40);
    expect(detectUnregisteredJudgment(`根因是 ctxMgr 没有清理缓存${long}`)).toBe(true);
    expect(detectUnregisteredJudgment(`问题出在这个函数的早退分支${long}`)).toBe(true);
    expect(detectUnregisteredJudgment(`这说明缓存并没有生效${long}`)).toBe(true);
    expect(detectUnregisteredJudgment(`结论是：该逻辑从未执行${long}`)).toBe(true);
  });

  test("识别英文断言", () => {
    const long = ".".repeat(40);
    expect(detectUnregisteredJudgment(`The root cause is a stale cache${long}`)).toBe(true);
    expect(detectUnregisteredJudgment(`This proves the handler never runs${long}`)).toBe(true);
  });

  test("不确定表述不触发——那正是健康的、无需提醒的说法", () => {
    const long = "。".repeat(40);
    expect(detectUnregisteredJudgment(`可能是缓存问题，我再看看具体实现${long}`)).toBe(false);
    expect(detectUnregisteredJudgment(`我先读一下这个文件的内容再判断${long}`)).toBe(false);
  });

  test("过短输出不触发（承载不了判断，且省正则开销）", () => {
    expect(detectUnregisteredJudgment("根因是缓存")).toBe(false);
    expect(detectUnregisteredJudgment("")).toBe(false);
  });

  test("引导文案指向「刚才那句结论」，并允许已有充分证据时忽略", () => {
    const text = buildJudgmentGuideReminder();
    expect(text).toContain("hypothesis_register");
    expect(text).toContain("证伪条件");
    expect(text).toContain("忽略本提醒");
  });

  // ── 信号 B：从"查"转入"改"（覆盖判断性表述正则抓不到的情形）──

  test("只读探查识别：read/grep/glob/ls 是「查」阶段的标志", () => {
    expect(hasReadOnlyProbe(["read"])).toBe(true);
    expect(hasReadOnlyProbe(["grep", "bash"])).toBe(true);
    expect(hasReadOnlyProbe(["Read"])).toBe(true); // 大小写不敏感
    expect(hasReadOnlyProbe(["bash", "write"])).toBe(false);
  });

  test("有过探查 + 本轮出现 edit/write → 命中（模型可以不写一句解释就开始改）", () => {
    expect(detectInvestigateToEditTransition(["edit"], true)).toBe(true);
    expect(detectInvestigateToEditTransition(["write"], true)).toBe(true);
    expect(detectInvestigateToEditTransition(["multi_edit"], true)).toBe(true);
  });

  test("没有前置探查 → 不命中（一上来就写文件不代表在排查）", () => {
    expect(detectInvestigateToEditTransition(["write"], false)).toBe(false);
  });

  test("仍在只读阶段 → 不命中（还没转入「改」）", () => {
    expect(detectInvestigateToEditTransition(["read", "grep"], true)).toBe(false);
  });

  test("turn-1 兜底已降级为极简：篇幅显著短于完整的判断时引导", () => {
    // 缺口3 修复项2 的核心是"把篇幅让给时机"，不是"两处都发一遍完整引导"
    expect(buildMinimalGuideReminder().length).toBeLessThan(
      buildJudgmentGuideReminder().length,
    );
    // 但极简版仍须点到工具名与证伪条件，否则兜底就失去意义
    expect(buildMinimalGuideReminder()).toContain("hypothesis_register");
    expect(buildMinimalGuideReminder()).toContain("证伪条件");
  });

  test("原 turn-1 引导的两条配套习惯挪到了判断时引导里（一条不丢）", () => {
    const text = buildJudgmentGuideReminder();
    expect(text).toContain("file:line");
    expect(text).toContain("先 read 该文件");
  });
});

// ─────────────────────── 缺口7：turn 三口径 ───────────────────────

describe("缺口7：会话累计轮次与用户消息序号", () => {
  test("absoluteTurn 单调递增，不随用户消息重置", () => {
    const ss = new SessionState("s1");
    expect(ss.getAbsoluteTurn()).toBe(0);
    expect(ss.nextAbsoluteTurn()).toBe(1);
    expect(ss.nextAbsoluteTurn()).toBe(2);
    // 模拟新一条用户消息：promptSeq 前进，但 absoluteTurn 继续累加而非归零
    expect(ss.nextPromptSeq()).toBe(1);
    expect(ss.nextAbsoluteTurn()).toBe(3);
    expect(ss.getAbsoluteTurn()).toBe(3);
  });

  test("promptSeq 从 1 开始逐条递增，可还原 turn 的回绕", () => {
    const ss = new SessionState("s1");
    expect(ss.getPromptSeq()).toBe(0);
    expect(ss.nextPromptSeq()).toBe(1);
    expect(ss.nextPromptSeq()).toBe(2);
    expect(ss.getPromptSeq()).toBe(2);
  });
});

// ─────────────────────── 持久化：新字段回灌 ───────────────────────

describe("新字段的序列化与回灌", () => {
  test("neutral / challengedAfterConfirm 往返保真", () => {
    const a = new HypothesisLedger();
    const h = registerWithCue(a, "handleconnection");
    a.challenge({ id: h.id, verdict: "keep_open", evidence: { note: "存疑" }, turn: 2 });
    a.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 3 });
    a.detectContradictions(["反证：handleconnection 未调用"]);

    const b = new HypothesisLedger();
    b.hydrate(JSON.parse(JSON.stringify(a.serialize())));
    const got = b.get(h.id)!;
    expect(got.neutral.length).toBe(1);
    expect(got.challengedAfterConfirm).toBe(1);
    expect(b.hasChallengedConfirmed()).toBe(true);
  });

  test("旧快照（缺 neutral/challengedAfterConfirm）安全降级，不凭空造拦截", () => {
    const ledger = new HypothesisLedger();
    ledger.hydrate({
      seq: 1,
      items: [
        {
          id: "H1",
          statement: "旧假设",
          falsifier: "若X则推翻",
          status: "confirmed",
          falsifierCues: ["xxxxxxxx"],
          supporting: [],
          refuting: [],
          createdTurn: 1,
          updatedTurn: 1,
          challengedFingerprints: [],
        } as any,
      ],
    });
    const got = ledger.get("H1")!;
    expect(got.neutral).toEqual([]);
    expect(got.challengedAfterConfirm).toBe(0);
    // 降级方向：宁可漏一次提醒，不要凭空造出一次拦截
    expect(ledger.hasChallengedConfirmed()).toBe(false);
  });

  test("reopenChallengeCount 不从快照恢复——resume 是新一段排查，重新给足预算", () => {
    const a = new HypothesisLedger();
    const h = registerWithCue(a, "handleconnection");
    a.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 2 });
    for (let i = 0; i < MAX_REOPEN_CHALLENGES; i++) {
      a.detectContradictions([`第 ${i} 条反证 handleconnection`]);
    }
    expect(a.get(h.id)!.reopenChallengeCount).toBe(MAX_REOPEN_CHALLENGES);

    const b = new HypothesisLedger();
    b.hydrate(JSON.parse(JSON.stringify(a.serialize())));
    expect(b.get(h.id)!.reopenChallengeCount).toBe(0);
    // 事实仍在
    expect(b.get(h.id)!.challengedAfterConfirm).toBe(MAX_REOPEN_CHALLENGES);
  });

  test("staleNagged 随快照走（否则 -c 恢复后重复提醒，而文案写明只出现一次）", () => {
    const a = new HypothesisLedger();
    registerWithCue(a, "handleconnection", 1);
    expect(a.claimStaleNag(1 + HYPOTHESIS_STALE_TURNS, HYPOTHESIS_STALE_TURNS)).toBe(true);

    const b = new HypothesisLedger();
    b.hydrate(JSON.parse(JSON.stringify(a.serialize())));
    expect(b.claimStaleNag(999, HYPOTHESIS_STALE_TURNS)).toBe(false);
  });
});

// ───────────── 2026-08-01 成本收益实测：交付门禁永久武装 + 空转裁决 ─────────────
//
// 实测会话 20260801-120158-d91920a0（68 轮）：假设机制占 31.4% input token、31.1%
// API 墙钟；26 次裁决里 11 次（42%）是"绕一圈回到同一结论"的空转；末尾 turn 64/66
// 连续两次被交付门禁拦截、turn 65/67 把三条已 confirmed 假设原地重 confirm，
// 4 轮零新增结论。根因是 challengedAfterConfirm 只增不减，而门禁闸门读的正是它。

describe("交付门禁：确认即复核，闸门不再永久武装", () => {
  /** 让一条已 confirmed 的假设被证据打脸一次（走真实的 detectContradictions 路径）。 */
  function confirmThenSlap(ledger: HypothesisLedger, cue: string) {
    const h = registerWithCue(ledger, cue);
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 2 });
    const hits = ledger.detectContradictions([`日志显示 ${cue} 其实走到了这里`]);
    expect(hits.length).toBe(1);
    expect(hits[0]!.afterConfirm).toBe(true);
    return h;
  }

  test("被打脸后门禁武装；模型复核（重新 confirm）后闸门放下", () => {
    const ledger = new HypothesisLedger();
    const h = confirmThenSlap(ledger, "handleconnection");
    // 打脸后：门禁该拦——这是缺口1 的原有防线，必须保持。
    expect(ledger.hasChallengedConfirmed()).toBe(true);
    expect(ledger.challengedConfirmed().map((c) => c.id)).toEqual([h.id]);

    // 模型复核并重新确认 → 闸门放下。旧实现这里仍为 true，于是每次收尾都再拦一遍。
    ledger.challenge({
      id: h.id,
      verdict: "confirm",
      evidence: { note: "复核后仍成立", source: "src/x.ts:10" },
      turn: 5,
    });
    expect(ledger.hasChallengedConfirmed()).toBe(false);
    expect(ledger.challengedConfirmed()).toEqual([]);
    // 事实必须留痕（门禁文案要用），只是不再武装闸门。
    expect(ledger.get(h.id)!.challengedAfterConfirm).toBe(1);
    expect(ledger.get(h.id)!.challengesAcknowledged).toBe(1);
  });

  test("复核后又来新证据 → 闸门重新武装（防线未被削弱）", () => {
    const ledger = new HypothesisLedger();
    const h = confirmThenSlap(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "复核" }, turn: 5 });
    expect(ledger.hasChallengedConfirmed()).toBe(false);

    // 不同证据文本 → 新指纹 → 再次命中（reopenChallengeCount 预算内）。
    const hits = ledger.detectContradictions([`另一处调用栈里 handleconnection 也执行了`]);
    expect(hits.length).toBe(1);
    expect(ledger.hasChallengedConfirmed()).toBe(true);
    expect(ledger.get(h.id)!.challengedAfterConfirm).toBe(2);
    expect(ledger.get(h.id)!.challengesAcknowledged).toBe(1);
  });

  test("reopen 不推进复核水位（退回 open 是重新取证，不是复核结论）", () => {
    const ledger = new HypothesisLedger();
    const h = confirmThenSlap(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "reopen", evidence: { note: "证据不足" }, turn: 5 });
    expect(ledger.get(h.id)!.challengesAcknowledged).toBe(0);
    // reopen 后 status=open，此时该由 hasUnsettled() 那道闸门接管。
    expect(ledger.hasUnsettled()).toBe(true);
  });

  test("复核水位随快照走（否则 resume 后凭空多出一次拦截）", () => {
    const a = new HypothesisLedger();
    const h = confirmThenSlap(a, "handleconnection");
    a.challenge({ id: h.id, verdict: "confirm", evidence: { note: "复核" }, turn: 5 });
    expect(a.hasChallengedConfirmed()).toBe(false);

    const b = new HypothesisLedger();
    b.hydrate(JSON.parse(JSON.stringify(a.serialize())));
    expect(b.get(h.id)!.challengesAcknowledged).toBe(1);
    expect(b.hasChallengedConfirmed()).toBe(false);
  });

  test("手改快照造出的负差值被 clamp（acknowledged 不得超过事实次数）", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "确认" }, turn: 2 });
    const snap = JSON.parse(JSON.stringify(ledger.serialize()));
    snap.items[0].challengedAfterConfirm = 1;
    snap.items[0].challengesAcknowledged = 99;
    const b = new HypothesisLedger();
    b.hydrate(snap);
    expect(b.get(h.id)!.challengesAcknowledged).toBe(1);
    expect(b.hasChallengedConfirmed()).toBe(false);
  });
});

describe("空转裁决：同结论重复裁决被识别", () => {
  test("对已 confirmed 假设用同一条证据再 confirm → redundant", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    const ev = { note: "读了 src/x.ts:10 确认", source: "src/x.ts:10" };
    const first = ledger.challenge({ id: h.id, verdict: "confirm", evidence: ev, turn: 2 });
    expect(first.redundant).toBe(false);

    const again = ledger.challenge({ id: h.id, verdict: "confirm", evidence: ev, turn: 9 });
    expect(again.redundant).toBe(true);
  });

  test("状态变更不算空转", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    const r = ledger.challenge({
      id: h.id,
      verdict: "keep_open",
      evidence: { note: "存疑" },
      turn: 2,
    });
    expect(r.redundant).toBe(false);
    // open → confirmed 是实质进展
    const c = ledger.challenge({
      id: h.id,
      verdict: "confirm",
      evidence: { note: "存疑" },
      turn: 3,
    });
    expect(c.redundant).toBe(false);
  });

  test("带新证据的重复 confirm 不算空转（证据是新的就有信息量）", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: { note: "证据甲" }, turn: 2 });
    const r = ledger.challenge({
      id: h.id,
      verdict: "confirm",
      evidence: { note: "证据乙（另一处）", source: "src/y.ts:20" },
      turn: 5,
    });
    expect(r.redundant).toBe(false);
  });

  test("有待复核打脸时的 confirm 是复核动作，不算空转", () => {
    const ledger = new HypothesisLedger();
    const h = registerWithCue(ledger, "handleconnection");
    const ev = { note: "确认" };
    ledger.challenge({ id: h.id, verdict: "confirm", evidence: ev, turn: 2 });
    ledger.detectContradictions([`日志显示 handleconnection 其实走到了这里`]);
    // 证据同上一条（指纹已存在）、状态也不变，但有待复核打脸 → 必须放行
    const r = ledger.challenge({ id: h.id, verdict: "confirm", evidence: ev, turn: 6 });
    expect(r.redundant).toBe(false);
    expect(ledger.hasChallengedConfirmed()).toBe(false);
  });
});

describe("机制总开关：SID_ENABLE_HYPOTHESIS", () => {
  test("默认关闭；设为 1 时显式开启", () => {
    const saved = process.env.SID_ENABLE_HYPOTHESIS;
    try {
      delete process.env.SID_ENABLE_HYPOTHESIS;
      expect(isHypothesisEnabled()).toBe(false);
      process.env.SID_ENABLE_HYPOTHESIS = "1";
      expect(isHypothesisEnabled()).toBe(true);
      // 只认 "1"，避免 SID_ENABLE_HYPOTHESIS=true 之类的写法被误读成开启
      process.env.SID_ENABLE_HYPOTHESIS = "true";
      expect(isHypothesisEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SID_ENABLE_HYPOTHESIS;
      else process.env.SID_ENABLE_HYPOTHESIS = saved;
    }
  });
});
