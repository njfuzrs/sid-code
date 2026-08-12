/**
 * todo 回注「无状态消息扫描」单测 + 回归哨兵
 *
 * 方案：docs/bugfixes/todo/20260801-todolist非实时更新-对标CC架构根治方案.md §8.1
 *
 * 这组测试锁的核心事实只有一条：**长任务停滞时，todo 回注通道必须持续响**。
 * 旧实现（LoopState 计数器 + 逐字节去重 + 封顶 2）在 60 轮停滞会话里只注入 1 次，
 * 通道等于废掉；`60 轮停滞至少注入 6 次` 那条就是防它长回去的哨兵。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getTodoReminderTurnCounts,
  shouldInjectTodoReminder,
  LAST_TODO_REMINDER_TURN_KEY,
} from "@sid-code/core/query/todo-reminder-scan.ts";
import { TODO_REMINDER_CONFIG } from "@sid-code/core/query/todo-reminder.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");

function assistantText(text = "继续干活"): Message {
  return { role: "assistant", content: [{ type: "text", text }] } as Message;
}

function assistantTodoWrite(): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "todo_write", input: { todos: [] } }],
  } as Message;
}

function assistantOtherTool(name = "read"): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "t2", name, input: {} }],
  } as Message;
}

function userText(text = "干活"): Message {
  return { role: "user", content: [{ type: "text", text }] } as Message;
}

const THRESHOLDS = {
  turnsSinceWrite: TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE,
  turnsBetweenReminders: TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS,
};

describe("getTodoReminderTurnCounts：倒序扫描正确性", () => {
  test("历史里从未出现 todo_write → Infinity（语义上必然到期）", () => {
    const msgs = [userText(), assistantText(), assistantOtherTool()];
    const c = getTodoReminderTurnCounts(msgs, { absoluteTurn: 3 });
    expect(c.turnsSinceLastTodoWrite).toBe(Number.POSITIVE_INFINITY);
    // 从未注入过 reminder 同样是 Infinity
    expect(c.turnsSinceLastReminder).toBe(Number.POSITIVE_INFINITY);
  });

  test("最后一条就是 todo_write → 距离 0（含它那轮本身不计）", () => {
    const msgs = [userText(), assistantTodoWrite()];
    const c = getTodoReminderTurnCounts(msgs, { absoluteTurn: 2 });
    expect(c.turnsSinceLastTodoWrite).toBe(0);
  });

  test("只数 assistant 轮，user 消息与 tool_result 不计入距离", () => {
    // todo_write 之后有 3 个 assistant 轮，其间夹杂 user 消息
    const msgs = [
      assistantTodoWrite(),
      assistantText(),
      userText("插一句"),
      assistantText(),
      userText("再插一句"),
      assistantText(),
    ];
    const c = getTodoReminderTurnCounts(msgs, { absoluteTurn: 10 });
    expect(c.turnsSinceLastTodoWrite).toBe(3);
  });

  test("别的工具调用不被误认成 todo_write", () => {
    const msgs = [assistantTodoWrite(), assistantOtherTool("read"), assistantOtherTool("edit")];
    const c = getTodoReminderTurnCounts(msgs, { absoluteTurn: 5 });
    expect(c.turnsSinceLastTodoWrite).toBe(2);
  });

  test("取**最近**一次 todo_write，不是最早那次", () => {
    const msgs = [
      assistantTodoWrite(), // 早期那次
      assistantText(),
      assistantText(),
      assistantTodoWrite(), // 最近那次 ← 应以此为基准
      assistantText(),
    ];
    const c = getTodoReminderTurnCounts(msgs, { absoluteTurn: 9 });
    expect(c.turnsSinceLastTodoWrite).toBe(1);
  });

  test("turnsSinceLastReminder 按 absoluteTurn 相减，且不为负", () => {
    const c = getTodoReminderTurnCounts([], { absoluteTurn: 20, lastReminderAbsoluteTurn: 12 });
    expect(c.turnsSinceLastReminder).toBe(8);
    // 防御：锚点比当前轮还大（理论上不该发生）时钳到 0，不产出负距离
    const weird = getTodoReminderTurnCounts([], { absoluteTurn: 5, lastReminderAbsoluteTurn: 99 });
    expect(weird.turnsSinceLastReminder).toBe(0);
  });

  test("压缩掉 todo_write 后，扫描自动算出「很久没写清单」", () => {
    // 模拟压缩：历史里 todo_write 的 tool_use 块已被删除
    const compacted = [userText("[对话摘要]"), assistantText(), assistantText()];
    const c = getTodoReminderTurnCounts(compacted, { absoluteTurn: 30 });
    expect(c.turnsSinceLastTodoWrite).toBe(Number.POSITIVE_INFINITY);
    // → 阈值判定必然放行（这就是"压缩后自动重注"的来源）
    expect(shouldInjectTodoReminder(c, THRESHOLDS)).toBe(true);
  });
});

describe("shouldInjectTodoReminder：两条件 AND 的纯节流", () => {
  test("两个距离都到期 → 注入", () => {
    const c = { turnsSinceLastTodoWrite: 8, turnsSinceLastReminder: 8 };
    expect(shouldInjectTodoReminder(c, THRESHOLDS)).toBe(true);
  });

  test("刚写过清单（距离 0）→ 不注入，避免刚写完就催", () => {
    const c = { turnsSinceLastTodoWrite: 0, turnsSinceLastReminder: 999 };
    expect(shouldInjectTodoReminder(c, THRESHOLDS)).toBe(false);
  });

  test("刚提醒过 → 不注入（防每轮刷屏）", () => {
    const c = { turnsSinceLastTodoWrite: 999, turnsSinceLastReminder: 1 };
    expect(shouldInjectTodoReminder(c, THRESHOLDS)).toBe(false);
  });

  test("TURNS_SINCE_WRITE 真正参与判定（旧实现里它是死常量，从未被引用）", () => {
    // 距上次 reminder 很久，但模型刚写过清单 → 必须不注入。
    // 若哪天有人把这个条件去掉，这条会红。
    const justWrote = { turnsSinceLastTodoWrite: 1, turnsSinceLastReminder: 999 };
    expect(shouldInjectTodoReminder(justWrote, THRESHOLDS)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 回归哨兵：60 轮停滞会话
// ────────────────────────────────────────────────────────────────────────────
describe("回归哨兵：60 轮停滞必须持续回注（旧实现只注 1 次）", () => {
  test("模型 60 轮不碰清单 → 注入次数 ≥ 6", () => {
    // 复刻缺陷现场：首轮建完清单后模型再也不调 todo_write，只反复用别的工具。
    const msgs: Message[] = [userText("干个长活"), assistantTodoWrite()];
    let lastReminderTurn: number | undefined;
    let injections = 0;
    const injectedAt: number[] = [];

    for (let turn = 1; turn <= 60; turn++) {
      msgs.push(assistantOtherTool("read")); // 模型干活但不碰清单
      const counts = getTodoReminderTurnCounts(msgs, {
        absoluteTurn: turn,
        lastReminderAbsoluteTurn: lastReminderTurn,
      });
      if (shouldInjectTodoReminder(counts, THRESHOLDS)) {
        injections++;
        injectedAt.push(turn);
        lastReminderTurn = turn;
      }
    }

    // 旧实现实测：注入轮次 [11]，共 1 次（去重从第 2 次起永久静音）。
    // 新实现应约每 TURNS_BETWEEN_REMINDERS 轮响一次 → 60/8 ≈ 7。
    // 断言 ≥6 留一点边界余量，但足以把"退回 1 次"钉死。
    expect(injections).toBeGreaterThanOrEqual(6);
    // 且必须是**均匀分布**而非前几轮挤在一起：最后一次注入应发生在会话后段。
    expect(injectedAt[injectedAt.length - 1]).toBeGreaterThan(50);
  });

  test("跨用户消息不失忆：新用户消息不会让节流重新开闸猛注", () => {
    // 旧实现的 LoopState 每条用户消息重建 → 计数器归零。锚点上移到 SessionState 后，
    // 新用户消息不影响"距上次 reminder 多少轮"的判定。
    const msgs: Message[] = [userText("第一条"), assistantTodoWrite()];
    for (let i = 0; i < 9; i++) msgs.push(assistantOtherTool());
    // 第 10 轮注入一次
    const first = getTodoReminderTurnCounts(msgs, { absoluteTurn: 10 });
    expect(shouldInjectTodoReminder(first, THRESHOLDS)).toBe(true);

    // 用户又发一条消息，紧接下一轮：锚点仍在（absoluteTurn 只 +1）→ 不该立刻再注
    msgs.push(userText("第二条"));
    msgs.push(assistantOtherTool());
    const afterNewPrompt = getTodoReminderTurnCounts(msgs, {
      absoluteTurn: 11,
      lastReminderAbsoluteTurn: 10,
    });
    expect(shouldInjectTodoReminder(afterNewPrompt, THRESHOLDS)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 结构哨兵：去重/封顶不得长回 todo 通道
// ────────────────────────────────────────────────────────────────────────────
describe("结构哨兵：todo 通道保持无去重、无封顶", () => {
  test("todo-reminder-scan.ts 不引用 decideNagInjection", () => {
    const src = readFileSync(
      join(REPO_ROOT, "packages/core/src/query/todo-reminder-scan.ts"),
      "utf8",
    );
    // 注释里提到"不加去重"是允许的，故只查是否真的 import 了那个模块
    expect(src).not.toContain('from "./reminder-throttle.ts"');
  });

  test("锚点键名走 SessionState（跨用户消息持久），不挂 LoopState", () => {
    const loopSrc = readFileSync(join(REPO_ROOT, "packages/core/src/query/loop.ts"), "utf8");
    expect(LAST_TODO_REMINDER_TURN_KEY).toBe("lastTodoReminderAbsoluteTurn");
    // 必须是 sessionState.set 而非 state.xxx =
    expect(loopSrc).toContain("sessionState.set(LAST_TODO_REMINDER_TURN_KEY");
  });
});
