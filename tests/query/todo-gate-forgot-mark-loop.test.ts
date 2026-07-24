/**
 * 错误 3 回归：todo 全做完却忘翻最后状态位 —— queryLoop 门禁消费端集成测试
 *
 * 背景（2026-07 迁移 skill 崩溃复盘）：模型把最后一项设为 in_progress、输出了完整迁移
 * 报告后 end_turn，却再没发 todo_write 把它标 completed。旧门禁只看 todo 状态位，续命
 * 耗尽后抛"仍有 1 项未完成"的红字警报——这是**假警报**：活其实干完了、报告也交付了，
 * 只是忘了翻状态位。它误导用户以为交付物有缺失。
 *
 * 本测试验证门禁的"误判自愈"：
 *   1. 模型每轮都产出实质内容（长报告）却不推进 writeVersion → 判定"忘标记" → 中性收尾，
 *      不抛"未完成"红字警报；
 *   2. 对照组：模型空手 end_turn（无实质产出）→ 判定"真没做完" → 仍如实警报。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "../../src/query/loop.ts";
import type { QueryLoopConfig } from "../../src/query/loop.ts";
import type { QueryDeps } from "../../src/query/types.ts";
import {
  MAX_TODO_GATE_RETRIES,
  TODO_GATE_PRODUCTIVE_TEXT_MIN,
} from "../../src/query/todo-reminder.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { SessionState } from "../../src/session/state.ts";
import type { Config } from "../../src/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "../../src/llm/types.ts";
import type { TodoItem } from "../../src/tool/todo-write.ts";

function makeConfig(): Config {
  return { model: "glm-5.2", provider: "openai", maxTurns: 20 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，此处不产事件 */
}

/** 有实质产出（长文本）但试图收尾的响应——模拟"输出了完整报告后 end_turn" */
function productiveResp(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 200 },
  } as AccumulatedResponse;
}

/** 空手收尾（无实质产出）——模拟"真没做完" */
function emptyResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "好的" }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 2 },
  } as AccumulatedResponse;
}

/**
 * 构造 loop 配置。getTodoState 返回一个**永不推进**的清单（writeVersion 恒定），
 * 模拟模型始终不翻最后一项状态位。
 */
function makeLoopConfig(
  responses: AccumulatedResponse[],
): { loopConfig: QueryLoopConfig; ctxMgr: ContextManager } {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "帮我迁移配置" }] });

  // 4 项完成 + 1 项卡在 in_progress（复刻 idx=14 的真实快照）。writeVersion 恒定=模型不再翻状态位。
  const todos: TodoItem[] = [
    { content: "复制 command", activeForm: "正在复制 command", status: "completed" },
    { content: "patch settings", activeForm: "正在 patch settings", status: "completed" },
    { content: "新建 .mcp.json", activeForm: "正在新建 .mcp.json", status: "completed" },
    { content: "更新状态文件", activeForm: "正在更新状态文件", status: "completed" },
    { content: "输出迁移报告", activeForm: "正在输出迁移报告", status: "in_progress" },
  ];

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = responses[call] ?? productiveResp("兜底".repeat(200));
      call++;
      return r;
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    // 关键：writeVersion 恒为 1，模拟模型始终不再更新清单
    getTodoState: () => ({ todos, writeVersion: 1 }),
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr };
}

describe("错误 3 回归 — todo 忘标记的门禁误判自愈", () => {
  test("每轮都有实质产出却不翻状态位 → 判定忘标记 → 中性收尾，不抛'未完成'假警报", async () => {
    // 全程输出长报告（超过实质产出阈值）+ end_turn，但清单 writeVersion 不变
    const longReport = "迁移报告：已完成用户级与项目级迁移，详见下表。".repeat(20);
    expect(longReport.length).toBeGreaterThanOrEqual(TODO_GATE_PRODUCTIVE_TEXT_MIN);
    const responses = Array.from({ length: 10 }, () => productiveResp(longReport));
    const { loopConfig } = makeLoopConfig(responses);

    const systemTexts: string[] = [];
    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    const joined = systemTexts.join("\n");
    // 续命提示会出现（MAX 次），但最终收尾不得抛"仍有 N 项未完成"的红字假警报
    expect(joined).not.toContain("项任务未完成");
    // 应走中性收尾出口（可核对）
    expect(joined).toContain("核对");
    // 正常交还控制权，不无限打转
    expect(kinds).toContain("done");
  });

  test("对照组：空手 end_turn（无实质产出）→ 判定真没做完 → 仍如实警报", async () => {
    const responses = Array.from({ length: 10 }, () => emptyResp());
    const { loopConfig } = makeLoopConfig(responses);

    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    const joined = systemTexts.join("\n");
    // 真没做完：续命耗尽后必须如实警报（保留"未完成"语义），不能被误当忘标记放过
    expect(joined).toContain("未完成");
    expect(joined).toContain(`${MAX_TODO_GATE_RETRIES}`);
  });
});
