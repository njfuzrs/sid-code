/**
 * D-07：回答规范 #8「接收确认开场白」的可观测信号 —— collector 侧计数。
 *
 * ## 防什么
 *
 * system prompt 的 #8 段自称「每一轮都生效、且这类开场白会自我强化」，但此前全仓没有
 * 任何度量：规则退化（某个版本改完 prompt 反而更容易写出开场白）不会有任何东西报错。
 * 这个测试守三条边界：
 *
 * 1. **判定必须保守**：只有「本轮 assistant 的第一条文本块」以接收确认句式开头才计数。
 *    正文中间出现不算 —— 宽一格就会把大量正常回复计进来，比例虚高后没人再看这个数。
 * 2. **分母必须是可判定轮次**：零文本块（纯 tool_use）与多段文本的轮次不进分母，
 *    否则「这条规则没生效」会被稀释成「这条规则没生效但分母很大」。
 * 3. **落盘三态**：索引行里分母为 0 时两个键都不写（缺失 ≠ 0 个开场白）。
 *
 * 所有落盘都重定向到 tmpdir（SID_CODE_SESSION_INDEX），不碰真实 ~/.sid-code/。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector, detectAckOpener } from "@sid-code/core/trace/collector.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { buildSessionIndexEntry } from "@sid-code/core/trace/session-index.ts";

const MODEL = "claude-sonnet-4-20250514";

/** 一回合的一轮：BeforeModel + AfterModel，content_blocks 由调用方给。 */
async function fireTurn(hs: HookSystem, blocks: unknown[]) {
  const messages = [{ role: "user", content: "hi" }];
  await hs.fireBeforeModelEvent({
    model: MODEL,
    messages: messages as any,
    raw_messages: messages,
  } as any);
  await hs.fireAfterModelEvent(
    { model: MODEL, messages: [], raw_messages: messages } as any,
    {
      content_blocks: blocks,
      stop_reason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    } as any,
  );
}

const text = (t: string) => ({ type: "text", text: t });

describe("D-07 · detectAckOpener 判定（保守）", () => {
  test("词表开头的接收确认 → 命中", () => {
    expect(detectAckOpener("收到，已阅读 CLAUDE.md")).toBe(true);
    expect(detectAckOpener("已收到，已阅读 CLAUDE.md、AGENTS.md")).toBe(true);
    expect(detectAckOpener("已载入项目规则文档，开始处理。")).toBe(true);
    expect(detectAckOpener("收到了，已阅读 CLAUDE.md")).toBe(true);
  });

  test("加粗 / 列表记号 / 前导空白不影响判定", () => {
    expect(detectAckOpener("**已收到**，开始处理。")).toBe(true);
    expect(detectAckOpener("- 已阅读 CLAUDE.md")).toBe(true);
    expect(detectAckOpener("\n  已收到，继续。")).toBe(true);
  });

  test("「收到」+ 注入文档名（B 段）→ 命中；「收到」+ 普通内容 → 不算", () => {
    expect(detectAckOpener("收到，已阅读 CLAUDE.md 与 AGENTS.md。")).toBe(true);
    expect(detectAckOpener("收到，我看一下这个文件。")).toBe(false);
    expect(detectAckOpener("收到。")).toBe(false);
  });

  test("正文中间出现 → 不算（只看开头）", () => {
    expect(detectAckOpener("我先读交接文档。已阅读 CLAUDE.md 后开始改代码。")).toBe(false);
    expect(detectAckOpener("这个函数返回 `已收到` 布尔值。")).toBe(false);
  });

  test("正常回复 → 不算", () => {
    expect(detectAckOpener("我先读交接文档。")).toBe(false);
    expect(detectAckOpener("检查完成：3 个缺陷。")).toBe(false);
  });
});

describe("D-07 · collector 计数与落盘", () => {
  let tmp: string;
  let indexFile: string;
  let prevIndexEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sid-ack-opener-"));
    indexFile = join(tmp, "session-index.jsonl");
    prevIndexEnv = process.env.SID_CODE_SESSION_INDEX;
    process.env.SID_CODE_SESSION_INDEX = indexFile;
  });

  afterEach(() => {
    // 存/恢复原值而不是 delete：bun test 同批多文件在同一进程里跑，直接删会抹掉
    // preload 的兜底（见 CONTRIBUTING「测试落盘隔离」第 1 条）。
    if (prevIndexEnv === undefined) delete process.env.SID_CODE_SESSION_INDEX;
    else process.env.SID_CODE_SESSION_INDEX = prevIndexEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function makeCollector(sid: string) {
    const hs = new HookSystem();
    hs.setSessionId(sid);
    const c = new TraceCollector({ outputDir: tmp });
    c.registerHooks(hs);
    await hs.fireSessionStartEvent("startup", { model: MODEL });
    return { hs, c };
  }

  test("验收：以「收到，已阅读 CLAUDE.md」开头的回复 +1，正常回复不变", async () => {
    const { hs, c } = await makeCollector("sess-ack-1");
    await fireTurn(hs, [text("收到，已阅读 CLAUDE.md")]);
    expect(c.getAckOpenerStats()).toEqual({ turns: 1, totalTurns: 1 });

    await fireTurn(hs, [text("我先读交接文档。")]);
    expect(c.getAckOpenerStats()).toEqual({ turns: 1, totalTurns: 2 });
  });

  test("正文中间出现开场白句式不计数（只看第一条文本块的开头）", async () => {
    const { hs, c } = await makeCollector("sess-ack-2");
    await fireTurn(hs, [text("先说明背景。已阅读 CLAUDE.md，现在开始。")]);
    expect(c.getAckOpenerStats()).toEqual({ turns: 0, totalTurns: 1 });
  });

  test("零文本块（纯 tool_use）与多段文本轮次不进分母", async () => {
    const { hs, c } = await makeCollector("sess-ack-3");
    await fireTurn(hs, [{ type: "tool_use", id: "t1", name: "read", input: {} }]);
    expect(c.getAckOpenerStats()).toEqual({ turns: 0, totalTurns: 0 });

    await fireTurn(hs, [{ type: "thinking", thinking: "先看看。" }, text("我先读交接文档。")]);
    expect(c.getAckOpenerStats()).toEqual({ turns: 0, totalTurns: 1 });

    // 两段文本：首块是短提示、不是整段接收确认 → 不计入可判定轮次
    await fireTurn(hs, [text("我先读交接文档。"), text("读完了。")]);
    expect(c.getAckOpenerStats()).toEqual({ turns: 0, totalTurns: 1 });
  });

  test("首块是 thinking 不开场 → 不看后面的文本块（永远只看第一条文本）", async () => {
    const { hs, c } = await makeCollector("sess-ack-4");
    await fireTurn(hs, [
      { type: "thinking", thinking: "用户给了文件。" },
      text("已收到，已阅读 CLAUDE.md。"),
    ]);
    // thinking 不是文本块；它之后的唯一文本块就是「第一条文本块」→ 命中
    expect(c.getAckOpenerStats()).toEqual({ turns: 1, totalTurns: 1 });
  });

  test("/clear 换会话时计数归零（上个会话的比例不串过来）", async () => {
    const { hs, c } = await makeCollector("sess-ack-5");
    await fireTurn(hs, [text("收到，已阅读 CLAUDE.md")]);
    expect(c.getAckOpenerStats().turns).toBe(1);

    // /clear 会触发第二次 SessionStart(clear)，collector 在这一步重建会话状态
    c.registerHooks(hs);
    await hs.fireSessionStartEvent("clear", {
      model: MODEL,
      parent_session_id: "sess-ack-5",
    } as any);
    expect(c.getAckOpenerStats()).toEqual({ turns: 0, totalTurns: 0 });
  });
});

describe("D-07 · session-index 三态落盘", () => {
  test("成对落盘：传了分母才写两个键", () => {
    const row = buildSessionIndexEntry(
      { session_id: "s" },
      { ts: 1, ack_opener_turns: 3, ack_opener_total_turns: 10 },
    );
    expect(row.ack_opener_turns).toBe(3);
    expect(row.ack_opener_total_turns).toBe(10);
  });

  test("分母为 0 / 未传时两个键都不落（缺失 ≠ 0 个开场白）", () => {
    const zero = buildSessionIndexEntry(
      { session_id: "s" },
      { ts: 1, ack_opener_turns: 0, ack_opener_total_turns: 0 },
    );
    expect("ack_opener_turns" in zero).toBe(false);
    expect("ack_opener_total_turns" in zero).toBe(false);

    const none = buildSessionIndexEntry({ session_id: "s" }, { ts: 1 });
    expect("ack_opener_turns" in none).toBe(false);
  });
});
