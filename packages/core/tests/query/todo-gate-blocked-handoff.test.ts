/**
 * 回归：清单剩余项都在等用户（sudo）时，end_turn 兜底反复拦截 → 模型同义重复 7 次
 *
 * 缺陷现场（会话 20261005-233851-9b91e1b7，glm-5.2）：5 项清单，2 项已完成，剩余 3 项都需要
 * sudo 密码（bash 工具无 tty）。模型如实停下来等用户，兜底却：
 *   1. 只数 pending/in_progress，分不清"偷懒收尾"与"在等用户"→ 每次收尾都拦；
 *   2. 只改措辞的 todo_write（completed 仍 2/5）把预算清零 → 同一条消息拦了 4 次（上限 3）；
 *   3. 预算挂每条消息重建的 LoopState → 用户追问一句又拦满 3 次 + 红字警告。
 *
 * 本文件锁住三条修复：blocked 不拦且只说一次 / 预算按完成数复位 / 预算跨用户消息持久。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { MAX_TODO_GATE_RETRIES } from "@sid-code/core/query/todo-reminder.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";
import type { TodoItem } from "@sid-code/core/tool/todo-write.ts";

function makeConfig(): Config {
  return { model: "glm-5.2", provider: "openai", maxTurns: 20 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

/** 短答复收尾——复刻现场"剩余三步需要 sudo，请执行后贴输出"那类几十字的回复 */
function shortResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "剩余步骤需要 sudo 密码，请在终端执行上面的命令后把输出贴回来。" },
    ],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 30 },
  } as AccumulatedResponse;
}

const done = (c: string): TodoItem => ({ content: c, activeForm: c, status: "completed" });
const item = (c: string, status: TodoItem["status"]): TodoItem => ({
  content: c,
  activeForm: c,
  status,
});

interface Harness {
  run: () => Promise<{ systemTexts: string[]; llmCalls: number }>;
  sessionState: SessionState;
  setTodos: (t: TodoItem[], bumpVersion?: boolean) => void;
}

function makeHarness(initial: TodoItem[]): Harness {
  const sessionState = new SessionState("test-session");
  let todos = initial;
  let writeVersion = 1;
  return {
    sessionState,
    setTodos(t, bump = true) {
      todos = t;
      if (bump) writeVersion++;
    },
    async run() {
      const ctxMgr = new ContextManager({ maxTokens: 200000 });
      ctxMgr.setSystemPrompt("test");
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: "请你告诉我该执行什么命令" }],
      });
      let llmCalls = 0;
      const deps: QueryDeps = {
        sendWithRetry: () => emptyStream(),
        processStream: async () => {
          llmCalls++;
          return shortResp();
        },
        executeTools: async () => ({ results: [] }),
        autoCompact: async () => {},
        handleContextOverflow: () => null,
        getAbortSignal: () => undefined,
        uuid: () => "uuid-test",
        getTodoState: () => ({ todos, writeVersion }),
      };
      const loopConfig: QueryLoopConfig = {
        config: makeConfig(),
        ctxMgr,
        toolRegistry: new ToolRegistry(),
        sessionState,
        fallback: new ModelFallback(),
        deps,
      };
      const systemTexts: string[] = [];
      for await (const ev of queryLoop(loopConfig)) {
        if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
      }
      return { systemTexts, llmCalls };
    },
  };
}

const BLOCKED_TODOS: TodoItem[] = [
  done("实时探测 DoH 数据源"),
  done("修改 ppchat-route 脚本"),
  item("同步脚本到守护进程副本 —— 需 sudo", "blocked"),
  item("执行 sync 更新 hosts —— 需 sudo", "blocked"),
  item("验证修复结果 —— 等用户执行后贴输出", "blocked"),
];

describe("todo gate — blocked 项交给用户，不拦截", () => {
  test("剩余项全为 blocked → 一次 LLM 调用即收尾，无续推、无红字，只给一条等你操作说明", async () => {
    const h = makeHarness(BLOCKED_TODOS);
    const { systemTexts, llmCalls } = await h.run();
    expect(llmCalls).toBe(1);
    const joined = systemTexts.join("\n");
    expect(joined).not.toContain("继续推进");
    expect(joined).not.toContain("项任务未完成");
    expect(joined).toContain("3 项在等你操作");
  });

  test("同一批 blocked 项跨用户消息只说明一次", async () => {
    const h = makeHarness(BLOCKED_TODOS);
    await h.run();
    const second = await h.run();
    expect(second.llmCalls).toBe(1);
    expect(second.systemTexts.join("\n")).not.toContain("在等你操作");
  });

  test("仍有可推进项时照常拦截（blocked 不会让真没做完的项漏网）", async () => {
    const h = makeHarness([done("A"), item("B", "in_progress"), item("C 需 sudo", "blocked")]);
    const { systemTexts, llmCalls } = await h.run();
    expect(llmCalls).toBe(1 + MAX_TODO_GATE_RETRIES);
    expect(systemTexts.join("\n")).toContain("1 项任务未完成");
  });
});

describe("todo gate — 续命预算按真实推进复位、跨用户消息持久", () => {
  const STALLED: TodoItem[] = [
    done("A"),
    done("B"),
    item("C", "in_progress"),
    item("D", "pending"),
    item("E", "pending"),
  ];

  test("新的一条用户消息、清单未变 → 不再重新拦满一轮，也不重复红字", async () => {
    const h = makeHarness(STALLED);
    const first = await h.run();
    expect(first.llmCalls).toBe(1 + MAX_TODO_GATE_RETRIES);
    expect(first.systemTexts.join("\n")).toContain("项任务未完成");

    const second = await h.run();
    expect(second.llmCalls).toBe(1);
    expect(second.systemTexts.join("\n")).not.toContain("项任务未完成");
  });

  test("只改措辞的 todo_write（writeVersion 变、完成数不变）不复位预算", async () => {
    const h = makeHarness(STALLED);
    await h.run();
    // 复刻现场第 4 次写入：只给剩余项追加「需 sudo」备注，completed 仍 2/5
    h.setTodos([
      done("A"),
      done("B"),
      item("C —— 需 sudo", "in_progress"),
      item("D —— 需 sudo", "pending"),
      item("E —— 等用户", "pending"),
    ]);
    const second = await h.run();
    expect(second.llmCalls).toBe(1);
  });

  test("完成数增长 → 预算复位，兜底重新生效", async () => {
    const h = makeHarness(STALLED);
    await h.run();
    h.setTodos([done("A"), done("B"), done("C"), item("D", "in_progress"), item("E", "pending")]);
    const second = await h.run();
    expect(second.llmCalls).toBe(1 + MAX_TODO_GATE_RETRIES);
  });
});
