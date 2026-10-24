/**
 * 2026-10-24 计划生命周期缺陷回归（对照 docs-research §4「计划的生命周期」逐项核对后发现的 5 个缺陷）
 *
 *   D1 执行阶段被用户回合边界清掉 —— 压缩重注入 / 计划文件放行 / Recovery / fidelity 一起失效
 *   D2 取消、拒绝超限后模型被告知「已审批通过」—— 用户否决的计划带着恢复后的写权限被执行
 *   D3 步骤计数：否定词表追不上模型的开放标题集（本机 7/7 真实计划虚高 3–5 倍）+ 代码围栏未隔离
 *   D4 压缩重注入只给正文不给路径、超长截断无取回指引；紧急截断路径根本不重注入
 *   D5 计划文件去重靠 existsSync —— 并发会话同分钟同主题撞名、后写覆盖前写
 *
 * 外加可观测性：PlanTransition 事件（每个跃迁带 reason）、PlanReattach、digest 的生命周期行
 * 与旧口径步数重算。真实计划来自公司仓库不能入库，下面的夹具按其章节结构合成。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PlanModeManager,
  PLAN_STEP_PARSER_VERSION,
  type PlanModeEvent,
} from "@sid-code/core/plan/state.ts";
import {
  buildPlanCancelledMessage,
  buildPlanRejectLimitMessage,
  buildPlanReattachBody,
  PLAN_REATTACH_MAX_CHARS,
} from "@sid-code/core/plan/prompt.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { REATTACH_PLAN_PREFIX } from "@sid-code/core/query/compact/reattach-markers.ts";
import { FileReadTracker } from "@sid-code/core/tool/file-read-tracker.ts";
import { WriteTool } from "@sid-code/core/tool/write.ts";
import {
  aggregatePlanLifecycle,
  aggregatePlanFidelity,
  recountPlanStepsWithCurrentParser,
} from "@sid-code/core/trace/digest.ts";
import { cleanupEmptyPlanPlaceholders } from "@sid-code/core/config/startup-housekeeping.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";

const managers: PlanModeManager[] = [];
const tmpDirs: string[] = [];
function mgr(): PlanModeManager {
  const m = new PlanModeManager();
  managers.push(m);
  return m;
}
afterEach(() => {
  // 作废所有未收尾的计划，让占位文件被回收（测试 SID 主目录由 preload 隔离）
  for (const m of managers.splice(0)) m.forceExit();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function approved(m: PlanModeManager): void {
  m.enter("default");
  m.submitForApproval();
  m.approve();
}

// ─────────────────────────────────────────────────────────────
// D1：执行阶段只有三个出口，回合边界不是出口
// ─────────────────────────────────────────────────────────────
describe("D1 执行阶段的生命周期", () => {
  test("approve 后执行阶段持续，直到显式出口；路径一直可寻址", () => {
    const m = mgr();
    approved(m);
    const path = m.getPlanFilePath();
    // 状态机里不再存在「回合开始就清执行阶段」的入口
    expect((m as unknown as Record<string, unknown>).endExecution).toBeUndefined();
    expect(m.isExecuting()).toBe(true);
    expect(m.getPlanFilePath()).toBe(path);
    expect(m.recordPlanFileWrite()).toBe(true);
  });

  test("三个出口：enter（新计划取代）/ forceExit（取消、清空）/ completeExecution（做完）", () => {
    const a = mgr();
    approved(a);
    a.enter("default");
    expect(a.isExecuting()).toBe(false);
    expect(a.isPlanning()).toBe(true);

    const b = mgr();
    approved(b);
    b.forceExit("clear");
    expect(b.isExecuting()).toBe(false);
    expect(b.getLastOutcome()).toBe("cleared");

    const c = mgr();
    approved(c);
    expect(c.completeExecution()).toBe(true);
    expect(c.isExecuting()).toBe(false);
    expect(c.getPlanFilePath()).toBeNull();
    expect(c.getLastOutcome()).toBe("completed");
  });

  test("源码哨兵：app.ts 的回合入口不再调 endExecution()", () => {
    const src = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf-8");
    expect(src).not.toMatch(/planManager\??\.endExecution\(/);
    // 执行阶段被 todo 全部完成收尾、/clear 作废——两个出口都必须接上
    expect(src).toMatch(/planManager\.completeExecution\(\)/);
    expect(src).toMatch(/forceExit\("clear"/);
  });
});

// ─────────────────────────────────────────────────────────────
// D2：取消 / 拒绝超限的如实告知
// ─────────────────────────────────────────────────────────────
describe("D2 取消与拒绝超限", () => {
  test("拒绝超限记 rejected_limit，取消记 cancelled", () => {
    const a = mgr();
    a.enter("default");
    for (let i = 0; i < a.getMaxRejections(); i++) {
      a.submitForApproval();
      a.reject();
    }
    expect(a.isActive()).toBe(false);
    expect(a.getLastOutcome()).toBe("rejected_limit");

    const b = mgr();
    b.enter("default");
    b.submitForApproval();
    b.forceExit();
    expect(b.getLastOutcome()).toBe("cancelled");
  });

  test("取消 / 超限消息：明确未批准、不要执行；超限带上最后一次修改意见", () => {
    const c = buildPlanCancelledMessage("/p/a.md");
    expect(c).toContain("没有被批准");
    expect(c).toContain("不要执行");
    const r = buildPlanRejectLimitMessage("/p/a.md", 5, "改用方案 B");
    expect(r).toContain("没有被批准");
    expect(r).toContain("改用方案 B");
    expect(buildPlanRejectLimitMessage("/p/a.md", 5, "")).not.toContain("修改意见");
  });

  test("源码哨兵：app.ts 的取消 / 超限分支注入对应消息（修复前返回 null）", () => {
    const src = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf-8");
    expect(src).toMatch(/buildPlanCancelledMessage\(planPath\)/);
    expect(src).toMatch(/buildPlanRejectLimitMessage\(planPath,/);
    expect(src).not.toMatch(/用户取消：退出 plan mode，不注入任何 followup/);
  });
});

// ─────────────────────────────────────────────────────────────
// D3：步骤计数口径
// ─────────────────────────────────────────────────────────────
/** 按本机 7 份真实计划的章节结构合成（「缺陷单只读分析」形态） */
const REAL_SHAPE_PLAN = [
  "## 结论",
  "按钮点击后状态未刷新。",
  "## 根因",
  "- store 未订阅",
  "- 缓存键错误",
  "## 修改方案",
  "1. 改 src/store.ts 订阅逻辑",
  "2. 改 src/cache.ts 缓存键",
  "3. 补 src/store.test.ts",
  "## 影响面",
  "- 列表页",
  "- 详情页",
  "- 导出",
  "## 自测方式",
  "1. 打开列表页",
  "2. 点击按钮",
  "3. 观察状态",
  "4. 刷新页面",
  "## 置信度",
  "高",
  "## 需要补充",
  "- 复现账号",
  "- 浏览器版本",
].join("\n");

describe("D3 步骤计数", () => {
  test("真实计划形态：只数「修改方案」（修复前 14 步，真实修改项 3 步）", () => {
    const m = mgr();
    const steps = m.parsePlanFromMarkdown(REAL_SHAPE_PLAN);
    expect(steps.map((s) => s.description)).toEqual([
      "改 src/store.ts 订阅逻辑",
      "改 src/cache.ts 缓存键",
      "补 src/store.test.ts",
    ]);
    expect(m.getPlanStepSource()).toBe("step_sections");
  });

  test("代码围栏隔离：围栏里的列表项不计，围栏里的 # 注释不改写章节归属", () => {
    const m = mgr();
    const md = [
      "## 实施步骤",
      "1. 改 a.ts",
      "```yaml",
      "- name: x",
      "- name: y",
      "```",
      "## 风险",
      "```bash",
      "# 回滚命令",
      "git revert HEAD",
      "```",
      "- 风险一",
      "- 风险二",
    ].join("\n");
    expect(m.parsePlanFromMarkdown(md).map((s) => s.description)).toEqual(["改 a.ts"]);
  });

  test("步骤词优先于弱非步骤词，强非步骤词优先于步骤词", () => {
    const m = mgr();
    // 修复前：「目标」命中否定词表，整节被跳过 → 0 步
    expect(m.parsePlanFromMarkdown("## 实施步骤与目标\n1. a\n2. b\n3. c\n")).toHaveLength(3);
    // 「替代方案」含「方案」，但它不是要执行的方案
    expect(m.parsePlanFromMarkdown("## 修改方案\n1. a\n\n## 替代方案\n- b\n- c\n")).toHaveLength(1);
  });

  test("没有步骤类标题时退回排除口径；无标题时全数", () => {
    const m = mgr();
    expect(m.parsePlanFromMarkdown("## 背景\n- x\n\n## 做法\n1. a\n2. b\n")).toHaveLength(2);
    expect(m.getPlanStepSource()).toBe("excluding_non_step");
    expect(m.parsePlanFromMarkdown("1. a\n2. b\n")).toHaveLength(2);
    expect(m.getPlanStepSource()).toBe("flat");
  });

  test("执行期修订计划后，已发生的调用按新步骤重新对齐", () => {
    const m = mgr();
    approved(m);
    m.parsePlanFromMarkdown("## 实施步骤\n1. 读 package.json\n");
    m.recordActualToolCall("read", { file_path: "src/cli.ts" });
    expect(m.getFidelityReport().offPlanCount).toBe(1);
    // 失败守则：先改计划再继续 → 新计划里有了这一步，旧调用不该还算计划外
    m.parsePlanFromMarkdown("## 实施步骤\n1. 读 package.json\n2. 读 src/cli.ts\n");
    const r = m.getFidelityReport();
    expect(r.planStepCount).toBe(2);
    expect(r.offPlanCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// D4：压缩重注入带路径、截断有取回指引、紧急截断也重注入
// ─────────────────────────────────────────────────────────────
function pushRounds(ctx: ContextManager, n: number): void {
  const pad = "x".repeat(400);
  for (let i = 0; i < n; i++) {
    ctx.addMessage({ role: "user", content: [{ type: "text", text: `请求 ${i} ${pad}` }] });
    ctx.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { k: pad } }],
    });
    ctx.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `结果 ${pad}` }],
    });
  }
}

function reattachText(ctx: ContextManager): string | undefined {
  for (const m of ctx.getMessages()) {
    for (const b of m.content as Array<{ type: string; text?: string }>) {
      if (b.type === "text" && b.text?.startsWith(REATTACH_PLAN_PREFIX)) return b.text;
    }
  }
  return undefined;
}

describe("D4 压缩重注入", () => {
  test("正文带路径与阶段；超长时注明截断位置与取回方式", () => {
    const short = buildPlanReattachBody("/p/a.md", "1. a", "executing");
    expect(short.truncated).toBe(false);
    expect(short.text).toContain("/p/a.md");
    expect(short.text).toContain("执行阶段");
    const long = buildPlanReattachBody(
      "/p/a.md",
      "y".repeat(PLAN_REATTACH_MAX_CHARS + 10),
      "planning",
    );
    expect(long.truncated).toBe(true);
    expect(long.text).toContain("read 读取 /p/a.md");
  });

  test("compactWithSummary：重注入含路径，观察者收到统计", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    pushRounds(ctx, 12);
    ctx.setPlanContentProvider(() => ({ path: "/p/a.md", phase: "executing", content: "1. a" }));
    const seen: unknown[] = [];
    ctx.setPlanReattachObserver((s) => seen.push(s));
    expect(ctx.compactWithSummary("【摘要】").success).toBe(true);
    expect(reattachText(ctx)).toContain("计划文件：/p/a.md");
    expect(seen).toEqual([
      {
        planFilePath: "/p/a.md",
        phase: "executing",
        planChars: 4,
        truncated: false,
        source: "summary",
      },
    ]);
  });

  test("emergencyTruncate 也重注入计划（修复前完全不注入）", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    pushRounds(ctx, 12);
    ctx.setPlanContentProvider(() => ({ path: "/p/b.md", phase: "executing", content: "1. b" }));
    const seen: Array<{ source: string }> = [];
    ctx.setPlanReattachObserver((s) => seen.push(s));
    expect(ctx.emergencyTruncate().success).toBe(true);
    expect(reattachText(ctx)).toContain("/p/b.md");
    expect(seen.map((s) => s.source)).toEqual(["emergency"]);
  });

  test("没有压动（无切点）时不上报", () => {
    const ctx = new ContextManager({ maxTokens: 100_000 });
    ctx.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    ctx.setPlanContentProvider(() => ({ path: "/p/c.md", phase: "executing", content: "1. c" }));
    const seen: unknown[] = [];
    ctx.setPlanReattachObserver((s) => seen.push(s));
    expect(ctx.compactWithSummary("【摘要】").success).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// D5：原子占位防并发撞名
// ─────────────────────────────────────────────────────────────
describe("D5 计划文件原子占位", () => {
  test("两个实例同分钟同主题进入规划：路径不同，且都已占位", () => {
    const a = mgr();
    const b = mgr();
    a.enter("default", "同一个主题");
    b.enter("default", "同一个主题");
    const pa = a.getPlanFilePath()!;
    const pb = b.getPlanFilePath()!;
    expect(pa).not.toBe(pb);
    expect(statSync(pa).size).toBe(0);
    expect(statSync(pb).size).toBe(0);
    expect(PlanModeManager.hasPlanContent(pa)).toBe(false);
  });

  test("写过内容的计划文件退出后保留；从未写入的占位被回收", () => {
    const a = mgr();
    a.enter("default", "保留");
    const kept = a.getPlanFilePath()!;
    writeFileSync(kept, "1. a\n");
    a.forceExit();
    expect(existsSync(kept)).toBe(true);

    const b = mgr();
    b.enter("default", "回收");
    const empty = b.getPlanFilePath()!;
    b.forceExit();
    expect(existsSync(empty)).toBe(false);
    rmSync(kept, { force: true });
  });

  test("write 工具：0 字节占位按新建处理，无需先 read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-placeholder-"));
    tmpDirs.push(dir);
    const f = join(dir, "plan.md");
    writeFileSync(f, "");
    const res = await new WriteTool(new FileReadTracker()).execute({
      file_path: f,
      content: "## 实施步骤\n1. a\n",
    });
    expect(res.isError).not.toBe(true);
    expect(readFileSync(f, "utf-8")).toContain("实施步骤");
  });

  test("启动清理只回收超过 1 天的 0 字节占位，不碰有内容的计划", () => {
    const dir = join(sidPaths.plans(), "housekeeping-probe");
    mkdirSync(dir, { recursive: true });
    const oldEmpty = join(dir, "old-empty.md");
    const freshEmpty = join(dir, "fresh-empty.md");
    const oldFull = join(dir, "old-full.md");
    writeFileSync(oldEmpty, "");
    writeFileSync(freshEmpty, "");
    writeFileSync(oldFull, "1. a\n");
    const twoDaysAgo = Date.now() / 1000 - 2 * 86400;
    utimesSync(oldEmpty, twoDaysAgo, twoDaysAgo);
    utimesSync(oldFull, twoDaysAgo, twoDaysAgo);
    expect(cleanupEmptyPlanPlaceholders(Date.now())).toBe(1);
    expect(existsSync(oldEmpty)).toBe(false);
    expect(existsSync(freshEmpty)).toBe(true);
    expect(existsSync(oldFull)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────
// 可观测性：PlanTransition 事件 + digest 生命周期行 + 旧口径重算
// ─────────────────────────────────────────────────────────────
describe("可观测性", () => {
  test("每个跃迁带 reason / executing 前后值 / 拒绝次数", () => {
    const m = mgr();
    const events: PlanModeEvent[] = [];
    m.onStateChange((e) => events.push(e));
    m.enter("default");
    m.submitForApproval();
    m.reject({ source: "tui", feedbackChars: 6 });
    m.submitForApproval();
    m.approve({ source: "tui" });
    m.completeExecution();
    expect(events.map((e) => e.reason)).toEqual([
      "enter",
      "submit",
      "reject",
      "submit",
      "approve",
      "todos_completed",
    ]);
    const approve = events[4]!;
    expect([approve.executingBefore, approve.executingAfter]).toEqual([false, true]);
    expect(events[2]!.meta).toEqual({ source: "tui", feedbackChars: 6 });
    expect(events[2]!.rejectionCount).toBe(1);
    // 退出类跃迁带退出前的路径，监听方知道结束的是哪份计划
    expect(events[5]!.planFilePath).toBe(events[0]!.planFilePath);
  });

  test("监听方抛错不打断状态机", () => {
    const m = mgr();
    m.onStateChange(() => {
      throw new Error("boom");
    });
    expect(m.enter("default")).toBe(true);
    expect(m.isPlanning()).toBe(true);
  });

  test("digest 生命周期：执行阶段跨回合数、结局、重注入次数", () => {
    const t = (reason: string, execAfter: boolean, extra: Record<string, unknown> = {}) => ({
      event: "PlanTransition",
      data: { plan_file: "/p/a.md", reason, executing_after: execAfter, ...extra },
    });
    const rows = aggregatePlanLifecycle([
      t("enter", false),
      t("submit", false),
      t("approve", true),
      { event: "UserPromptSubmit", data: {} },
      { event: "PlanReattach", data: { plan_file: "/p/a.md", truncated: true } },
      { event: "UserPromptSubmit", data: {} },
      t("todos_completed", false),
      { event: "UserPromptSubmit", data: {} },
    ]);
    expect(rows).toEqual([
      {
        planFile: "/p/a.md",
        reasons: ["enter", "submit", "approve", "todos_completed"],
        rejections: 0,
        outcome: "todos_completed",
        executingTurns: 2,
        reattachCount: 1,
        reattachTruncated: 1,
      },
    ]);
  });

  test("取消结局可被看见（修复前取消路径零痕迹）", () => {
    const rows = aggregatePlanLifecycle([
      { event: "PlanTransition", data: { plan_file: "/p/x.md", reason: "enter" } },
      { event: "PlanTransition", data: { plan_file: "/p/x.md", reason: "submit" } },
      { event: "PlanTransition", data: { plan_file: "/p/x.md", reason: "cancel" } },
    ]);
    expect(rows[0]!.outcome).toBe("cancel");
  });

  test("旧口径（v1，无版本字段）的步数可按当前口径重算", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-recount-"));
    tmpDirs.push(dir);
    const f = join(dir, "plan.md");
    writeFileSync(f, REAL_SHAPE_PLAN);
    const [row] = aggregatePlanFidelity([
      { event: "PlanFidelity", data: { plan_file: f, plan_step_count: 14 } },
    ]);
    expect(row!.stepParserVersion).toBeUndefined();
    expect(recountPlanStepsWithCurrentParser(f)).toBe(3);
    expect(recountPlanStepsWithCurrentParser(join(dir, "gone.md"))).toBeNull();
    expect(PLAN_STEP_PARSER_VERSION).toBe(2);
  });
});
