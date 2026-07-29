/**
 * 负收益防线审计修复哨兵（docs/bugfixes/todo/负收益防线审计-发现清单.md，2026-07-30）
 *
 * 这些测试锁的不是"函数算得对"（各自的单测已覆盖），而是**审计结论本身不被静默回退**。
 * 五项修复各有一条容易在后续重构里被无声推翻的性质：
 *   发现 2（批次 A）：RL-006 只有"禁止"没有"合法例外" → 模型无法结案，反复自证烧 60.8% 输出预算。
 *   发现 3（批次 B）：todo / work-log 共用一个封顶计数器 → 先到的一方吃掉另一方全部额度。
 *   发现 4（批次 B）：permission mode 提醒 34 次注入逐字节相同却没接去重。
 *   发现 5（批次 C）：thinking 阈值 20000 拍在 reasoning_content bug 时代的数据上，实测 max=17490 → 恒不触发。
 *   发现 6（批次 D）：源码裸 NUL 让 grep 把整个文件当二进制静默跳过。
 *
 * 每条都写明"若断言失败意味着什么"，避免后人只看到红灯而不知道它在保护什么。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideNagInjection,
  MAX_NO_PROGRESS_NAGS,
} from "../../src/query/reminder-throttle.ts";
import {
  THINKING_DIVERGENCE_LEN,
  isThinkingDiverging,
  isThinkingDivergenceDetectionEnabled,
} from "../../src/query/thinking-divergence.ts";
import { makeSignature } from "../../src/query/repeated-readonly-guard.ts";
import { buildPermissionModeReminder } from "../../src/query/permission-reminder.ts";
import { buildSystemPrompt } from "../../src/config/system-prompt.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

// ────────────────────────────────────────────────────────────────────────────
// 发现 2 / 批次 A：RL-006 必须同时给出"禁止"与"合法例外"
// ────────────────────────────────────────────────────────────────────────────
describe("发现 2：RL-006 合法例外出口", () => {
  test("system prompt 里 RL-006 同时含禁止与例外两半", () => {
    // buildSystemPrompt 是同步的，且必须给 tools（内部要算工具身份缓存键）。
    const prompt = buildSystemPrompt({ tools: [] } as any);
    // 前提：红线段本身仍在（否则下面的断言是空转的假绿灯）
    expect(prompt).toContain("RL-006");

    // 取 RL-006 那一段（到下一条红线 RL-007 为止）单独检查，避免命中别处的同类措辞。
    const start = prompt.indexOf("RL-006");
    const end = prompt.indexOf("RL-007", start);
    expect(end).toBeGreaterThan(start);
    const rl006 = prompt.slice(start, end);

    // 禁止那一半：不能为了让 CI 变绿去改预期值。
    expect(rl006).toContain("禁止");
    // 例外那一半（本次修复新增）：契约被合法变更时修正测试前提不算违反。
    // 若这条失败 = 例外出口被删回"只有禁止"的旧表述，模型将重新陷入
    // 20260728-173546 那样的六轮自我辩论（thinking 53420 字符 / output 27727 tokens）。
    expect(rl006).toContain("反向边界");
    expect(rl006).toMatch(/契约/);
    // 必须明确"不要反复自证"，这是负收益的直接成因。
    expect(rl006).toMatch(/不要反复自证|无需反复自证/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 发现 3 / 批次 B：两条催促通道的封顶预算必须彼此独立
// ────────────────────────────────────────────────────────────────────────────
describe("发现 3：todo / work-log 封顶计数器互不饿死", () => {
  test("一方注满 cap 后，另一方首次注入仍必须放行", () => {
    // 模拟修复后的调用形态：两条通道各读自己的计数器。
    const todoNagCount = MAX_NO_PROGRESS_NAGS; // todo 已注满
    const progressNagCount = 0; // work-log 一次都没注过

    const workLog = decideNagInjection({
      candidate: "工作日志摘要（首次）",
      lastInjectedText: undefined, // 从未注入过 → 绝无重复可能
      noProgressNagCount: progressNagCount,
    });

    // 若这条失败 = 计数器又被合并成一个共享字段：work-log 首次注入就被抑制，
    // 它一次都没注过就已经没额度了（审计发现 3 的饿死复现）。
    expect(workLog.inject).toBe(true);

    // 反面对照：读到被占满的那个计数器时确实应当抑制——证明抑制逻辑本身没坏，
    // 问题只在"读谁的计数器"。
    const wrongBudget = decideNagInjection({
      candidate: "工作日志摘要（首次）",
      lastInjectedText: undefined,
      noProgressNagCount: todoNagCount,
    });
    expect(wrongBudget.inject).toBe(false);
  });

  test("LoopState 暴露两个独立字段，且不再保留共享的 noProgressNagCount", () => {
    // 用源码文本做结构哨兵：类型字段无法在运行时反射，但字段名被改回去时这条会红。
    const typesSrc = readFileSync(join(REPO_ROOT, "src/query/types.ts"), "utf8");
    expect(typesSrc).toMatch(/^\s*todoNagCount\?:/m);
    expect(typesSrc).toMatch(/^\s*progressNagCount\?:/m);
    // 旧的共享字段声明必须消失（注释里作为历史说明提到它是允许的，故只查声明行）。
    expect(typesSrc).not.toMatch(/^\s*noProgressNagCount\?:/m);
  });

  test("loop.ts 两条通道各读各的计数器，且有进展时同时清零", () => {
    const loopSrc = readFileSync(join(REPO_ROOT, "src/query/loop.ts"), "utf8");
    // 各自读自己的预算
    expect(loopSrc).toContain("noProgressNagCount: state.todoNagCount ?? 0");
    expect(loopSrc).toContain("noProgressNagCount: state.progressNagCount ?? 0");
    // writeVersion 变化（有进展）时两个都要清零——漏清任何一个会让那条通道提前哑掉。
    expect(loopSrc).toContain("state.todoNagCount = 0");
    expect(loopSrc).toContain("state.progressNagCount = 0");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 发现 3 / 批次 B：催促注入必须落成结构化事件（否则修复效果无法在现网验证）
// ────────────────────────────────────────────────────────────────────────────
describe("发现 3 附带：催促注入埋点", () => {
  test("两条通道都发 NoProgressNagInjected，且用 kind 区分", () => {
    const loopSrc = readFileSync(join(REPO_ROOT, "src/query/loop.ts"), "utf8");
    expect(loopSrc).toContain('event: "NoProgressNagInjected"');
    expect(loopSrc).toContain('kind: "todo"');
    expect(loopSrc).toContain('kind: "work-log"');
    // 埋点绝不能反过来阻断主循环
    expect(loopSrc).toContain("if (!deps.traceAppendEvent) return;");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 发现 4 / 批次 B：permission mode 周期性重述接入去重，切换那次仍强注入
// ────────────────────────────────────────────────────────────────────────────
describe("发现 4：permission mode 提醒去重", () => {
  test("同一 mode 的周期性重述文案逐字节恒定（故去重 100% 适用）", () => {
    const a = buildPermissionModeReminder("dangerously-skip-permissions", false);
    const b = buildPermissionModeReminder("dangerously-skip-permissions", false);
    expect(a).not.toBeNull();
    // 恒定是"可以去重"的前提。若哪天文案里嵌了轮次/时间戳，这条会红——
    // 那意味着必须改走 context-pressure 那种 cadence 节流，而非逐字节去重。
    expect(a).toBe(b);
  });

  test("切换那一轮文案与周期性重述不同 → changed=true 能被识别为新信息", () => {
    const changed = buildPermissionModeReminder("acceptEdits", true);
    const periodic = buildPermissionModeReminder("acceptEdits", false);
    expect(changed).not.toBe(periodic);
    expect(changed).toContain("已切换");
  });

  test("loop.ts 对周期性重述做了逐字节去重，且 changed 时绕过", () => {
    const loopSrc = readFileSync(join(REPO_ROOT, "src/query/loop.ts"), "utf8");
    // 去重字段被写入与比较
    expect(loopSrc).toContain("state.lastInjectedPermissionModeText");
    // 判据必须含 !changed —— 缺了它会把"刚切换"也去重掉，丢失真实时机价值。
    expect(loopSrc).toMatch(/const isDuplicate = !changed/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 发现 5 / 批次 C：thinking 阈值落在"只命中真阳性"的实测区间
// ────────────────────────────────────────────────────────────────────────────
describe("发现 5：thinking-divergence 阈值", () => {
  test("阈值落在实测反事实区间 12000–17000", () => {
    // 反事实扫描（481 轮真实轨迹）：8000→6 次含误伤、10000→3 次仍偏多、
    // 12000–17000→仅 1 次且是真阳性、20000→0 次（漏掉唯一一次真实分析瘫痪）。
    expect(THINKING_DIVERGENCE_LEN).toBeGreaterThanOrEqual(12_000);
    expect(THINKING_DIVERGENCE_LEN).toBeLessThanOrEqual(17_000);
  });

  test("真实分析瘫痪样本 [3273→6247→17490] 现在能被判为发散", () => {
    // 20260728-173546-0cbf5198 t25：审计里唯一有实证的分析瘫痪（该会话 t23–t28
    // 烧掉 60.8% 输出预算）。旧阈值 20000 差 2510 字符恰好漏掉它。
    expect(isThinkingDiverging([3273, 6247, 17490])).toBe(true);
  });

  test("实测 p99 量级（10132）的正常深推理仍不误伤", () => {
    // 下界保护：阈值若被下探到 10000 以下，正常深推理会开始被误判。
    expect(isThinkingDiverging([2000, 5000, 10132])).toBe(false);
  });

  test("仍保持默认关闭（本批次刻意不改开关，先验证真阳性率）", () => {
    const saved = {
      td: process.env.SID_ENABLE_THINKING_DIVERGENCE,
      ld: process.env.SID_ENABLE_LOOP_DETECTION,
    };
    delete process.env.SID_ENABLE_THINKING_DIVERGENCE;
    delete process.env.SID_ENABLE_LOOP_DETECTION;
    try {
      expect(isThinkingDivergenceDetectionEnabled()).toBe(false);
    } finally {
      if (saved.td !== undefined) process.env.SID_ENABLE_THINKING_DIVERGENCE = saved.td;
      if (saved.ld !== undefined) process.env.SID_ENABLE_LOOP_DETECTION = saved.ld;
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 发现 6 / 批次 D：源码不得含裸 NUL 字节（否则 grep 对整个文件失明）
// ────────────────────────────────────────────────────────────────────────────
describe("发现 6：源码裸 NUL 字节", () => {
  const NUL = String.fromCharCode(0);

  test("两个历史命中文件已清干净", () => {
    for (const rel of [
      "src/query/repeated-readonly-guard.ts",
      "src/ui/components/CodeColorizer.tsx",
    ]) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      // 若这条失败 = 裸 \0 又被写回源码：grep 会把整个文件当二进制静默跳过
      // （exit=1 与"真的没匹配"不可区分），排查时极易把活代码误判成死代码。
      expect(src.includes(NUL)).toBe(false);
    }
  });

  test("makeSignature 运行时行为不变：分隔符仍能区分命令/输出边界", () => {
    // 换分隔符不能带来语义回退：不同的 (命令,输出) 切分必须产生不同签名，
    // 否则止损阀会把不同情形当成"完全相同的探查又跑了一遍"。
    expect(makeSignature("git status", "a b")).not.toBe(makeSignature("git status a", "b"));
    // 同命令同输出仍稳定相等（这是止损阀计数的基础）。
    expect(makeSignature("git status", "clean")).toBe(makeSignature("git status", "clean"));
    // 空白折叠仍生效（尾随换行不该造成伪差异）。
    expect(makeSignature("git  status\n", " clean ")).toBe(makeSignature("git status", "clean"));
  });

  test("pre-commit 有裸 NUL 门禁，且不用会被 shell 剥空的 grep 写法", () => {
    const hook = readFileSync(join(REPO_ROOT, "scripts/git-hooks/pre-commit.sh"), "utf8");
    expect(hook).toContain("裸 NUL 字节");
    // 检测必须走 tr -d + 字节数差：`grep "$(printf '\000')"` 是陷阱——命令替换剥掉 NUL
    // 后模式退化成空串，判定完全反转（匹配所有干净文件、漏掉真含 NUL 的）。
    expect(hook).toContain("tr -d '\\000'");
    expect(hook).not.toMatch(/grep\s+-qU\s+"\$\(printf/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 发现 1 / 批次 E：唯一能强制掐断任务的止损阀必须可观测
// ────────────────────────────────────────────────────────────────────────────
describe("发现 1：repeated-readonly-guard 触发埋点", () => {
  test("remind 与 terminate 两个分支都发事件并区分 action", () => {
    const loopSrc = readFileSync(join(REPO_ROOT, "src/query/loop.ts"), "utf8");
    expect(loopSrc).toContain('event: "RepeatedReadonlyGuardTriggered"');
    expect(loopSrc).toContain('action: "remind"');
    expect(loopSrc).toContain('action: "terminate"');
  });

  test("terminate 的埋点排在 yield done 之前（否则永远不会执行）", () => {
    const loopSrc = readFileSync(join(REPO_ROOT, "src/query/loop.ts"), "utf8");
    const emitIdx = loopSrc.indexOf('action: "terminate"');
    expect(emitIdx).toBeGreaterThan(-1);
    // 从埋点往后找最近的 yield done —— 必须存在，即埋点在它前面。
    const doneIdx = loopSrc.indexOf("yield { kind: \"done\"", emitIdx);
    expect(doneIdx).toBeGreaterThan(emitIdx);
  });
});
