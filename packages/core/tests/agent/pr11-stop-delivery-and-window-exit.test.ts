/**
 * PR11 二次修复回归：停止归因交付链 + 硬杀残卷 + 优雅停止超时退化
 *
 * 背景（方案 §6 PR11 / §8.2 的 G1 判据，2026-11-18 二次核验）：
 * 首版 PR11（#927）把代码写了一半、测试也没兜住，三处缺口：
 *
 *   1. **停止归因没接生产端**：`AgentTaskResult.stopAction` 在 `types.ts` 定义、
 *      `completeAgentTask` 也读它拼摘要，但 `sub-agent.ts` 构造 `AgentTaskResult`
 *      时没赋值 —— 后台完成通知的 `<summary>` 永远是「执行完成」，打满轮次 /
 *      被父代理停止 / 窗口耗尽三种可信度不同的结论在父代理眼里同形。
 *   2. **硬杀残卷落不了盘**：`killAgentTask` 先设 killed 终态，`failAgentTask`
 *      用 `!isTerminalStatus` 一刀切把残卷挡在外面 —— salvage 的确定性清单
 *      （读过的文件 / 最后 5 次调用）在 `force: true` 与 60 秒超时退化两条硬杀
 *      路径上收集了却永远写不进 `.output`。
 *   3. **超时退化零覆盖**：`requestAgentStop` 的 `AGENT_STOP_GRACEFUL_TIMEOUT_MS`
 *      到期必须硬杀，此前没有任何测试引用它（删除整段退化逻辑也全绿）。
 *
 * 本文件从**真实入口**驱动（`createAgentTask` / `killAgentTask` / `failAgentTask` /
 * `TaskStopTool.execute` / `requestAgentStop`），不做纯函数替身 —— 上一轮的教训正是
 * 「只测 `describeStopNotice` 纯函数」让生产端断链完全隐身。
 *
 * 落盘隔离：agent-task 会 `initTaskOutput` 写 `<SID_CONFIG_DIR>/tasks/`，按
 * CONTRIBUTING「测试约定」把 SID_CONFIG_DIR 指向 tmpdir（存/恢复原值，不无条件 delete）。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createAgentTask,
  completeAgentTask,
  failAgentTask,
  killAgentTask,
  requestAgentStop,
  appendAgentOutput,
} from "../../src/task/agent-task.ts";
import { clearAllTasks, getTask } from "../../src/task/registry.ts";
import { dequeuePendingNotifications } from "../../src/task/notification.ts";
import { TaskStopTool } from "../../src/tool/task-stop.ts";
import { describeStopNotice } from "../../src/agent/stop-notice.ts";
import { buildSalvageOutput, type SalvageSnapshot } from "../../src/agent/salvage.ts";
import { runAgentLoop } from "../../src/agent/agentic-loop.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { LoopDetector } from "../../src/agent/loop-detection.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";

let originalConfigDir: string | undefined;
let tmpHome = "";

beforeEach(() => {
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-pr11-delivery-"));
  process.env.SID_CONFIG_DIR = tmpHome;
  dequeuePendingNotifications(); // 清掉前面用例的残留通知
});

afterEach(() => {
  clearAllTasks();
  dequeuePendingNotifications();
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 建一个 running 状态的 Agent 任务（已注册 stop controller 与落盘文件） */
function makeRunningTask(description = "只读探查"): { id: string; outputFile: string } {
  const { taskState } = createAgentTask({
    agentType: "explore",
    prompt: "看看这个模块",
    description,
  });
  return { id: taskState.id, outputFile: taskState.outputFile };
}

/** 构造一份含确定性清单的残卷（模拟 sub-agent abort 后交给 failAgentTask 的正文） */
function makeSalvageText(finalText = "被硬杀前的结论"): string {
  const snap: SalvageSnapshot = {
    changedFiles: [],
    readFiles: [{ path: "packages/core/src/agent/loop.ts", ranges: ["1-120"] }],
    recentCalls: ["read: packages/core/src/agent/loop.ts", "grep: runAgentLoop"],
    findings: ["定位到三处空转"],
    toolEvidence: [],
    turns: 2,
    toolUseCount: 2,
    tokenCount: 100,
  };
  return buildSalvageOutput(snap, {
    reason: "aborted",
    readOnlyAgent: true,
    finalText,
  });
}

/** 轮询等待条件成立（bun 默认 5s 单测超时，这里留足余量但不等满） */
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

// ─── 缺口 1：停止归因进后台完成通知 ───────────────────────────────────────

describe("停止归因进后台完成通知（D1 二次修复）", () => {
  test("stopAction=max_turns → summary 带「已达轮次上限」，不再是光秃秃的「执行完成」", async () => {
    const { id } = makeRunningTask("打满轮次的探查");

    await completeAgentTask(
      id,
      {
        output: "总结",
        totalToolUseCount: 3,
        totalTokens: 120,
        usage: { inputTokens: 80, outputTokens: 40 },
        stopAction: "max_turns",
      },
      true,
    );

    const notifs = dequeuePendingNotifications();
    expect(notifs).toHaveLength(1);
    const summary = notifs[0]!.structured!.summary;
    expect(summary).toContain("已达轮次上限");
    expect(summary).not.toBe('Agent "打满轮次的探查" 执行完成');
  });

  test("stopAction=stopped_by_parent → summary 带「被父代理停止」", async () => {
    const { id } = makeRunningTask("被叫停的探查");

    await completeAgentTask(
      id,
      {
        output: "停止前的总结",
        totalToolUseCount: 1,
        totalTokens: 60,
        usage: { inputTokens: 40, outputTokens: 20 },
        stopAction: "stopped_by_parent",
      },
      true,
    );

    const summary = dequeuePendingNotifications()[0]!.structured!.summary;
    expect(summary).toContain("被父代理停止");
  });

  test("对照组：缺省 stopAction（旧调用方 / 前台结果）不拼任何附注", async () => {
    const { id } = makeRunningTask("普通完成");

    await completeAgentTask(
      id,
      {
        output: "结论",
        totalToolUseCount: 1,
        totalTokens: 60,
        usage: { inputTokens: 40, outputTokens: 20 },
      },
      true,
    );

    const summary = dequeuePendingNotifications()[0]!.structured!.summary;
    expect(summary).toBe('Agent "普通完成" 执行完成');
  });

  test("生产端接线哨兵：sub-agent 必须把 stopAttribution.stop_action 传进 AgentTaskResult", () => {
    // 上一轮的缺口正是「字段定义了、消费写了、生产没赋值」——纯函数测试看不见。
    // 这里用源码哨兵锁住生产端：删掉那行赋值立刻红。
    const src = readFileSync(join(import.meta.dir, "../../src/agent/sub-agent.ts"), "utf-8");
    expect(src).toContain("stopAction: result.stopAttribution?.stop_action");
  });
});

// ─── 缺口 2：硬杀残卷必须落盘 ─────────────────────────────────────────────

describe("硬杀残卷交付（第 5 步的确定性清单）", () => {
  test("killed 之后 failAgentTask 仍把残卷追加进 .output，清单可读", async () => {
    const { id, outputFile } = makeRunningTask("被硬杀的子代理");

    killAgentTask(id);
    expect(getTask(id)?.status).toBe("killed");

    const salvage = makeSalvageText();
    await failAgentTask(id, salvage, true);

    const content = readFileSync(outputFile, "utf-8");
    expect(content).toContain("<partial-result>");
    expect(content).toContain("<read-files");
    // 行段在属性上，文件名在元素文本里（`<file ranges="1-120">packages/…</file>`）
    expect(content).toContain('<file ranges="1-120">packages/core/src/agent/loop.ts</file>');
    expect(content).toContain("<recent-calls");
    expect(content).toContain("<call>grep: runAgentLoop</call>");
    // 状态不被改写：仍然是 killed，不是 failed
    expect(getTask(id)?.status).toBe("killed");
    // 通知不重复：仍只有 kill 那一条
    const notifs = dequeuePendingNotifications();
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.structured!.status).toBe("killed");
  });

  test("completed 之后 failAgentTask 不追写（「已有结尾」的终态保护仍在）", async () => {
    const { id, outputFile } = makeRunningTask("已完成的任务");
    // 先落一行逐轮文本：没有任何输出时 `.output` 根本不会被创建，直接读会 ENOENT
    appendAgentOutput(id, "[轮次 1] 正常结论\n");

    await completeAgentTask(
      id,
      {
        output: "正常结论",
        totalToolUseCount: 1,
        totalTokens: 60,
        usage: { inputTokens: 40, outputTokens: 20 },
        stopAction: "finalize",
      },
      true,
    );

    await failAgentTask(id, "不应出现的残卷", true);

    const content = readFileSync(outputFile, "utf-8");
    expect(content).toContain("[轮次 1] 正常结论");
    expect(content).not.toContain("不应出现的残卷");
    expect(getTask(id)?.status).toBe("completed");
  });
});

// ─── 缺口 3：force 硬杀与超时退化 ─────────────────────────────────────────

describe("task_stop 的两条硬杀路径（G1 第 2 条）", () => {
  test("force:true → 立即硬杀，不回「优雅停止」", async () => {
    const { id } = makeRunningTask("跑偏的子代理");

    const out = await new TaskStopTool().execute({ task_id: id, force: true });

    expect(out.isError).toBeFalsy();
    expect(getTask(id)?.status).toBe("killed");
    expect(out.output).toContain("已终止");
  });

  test("requestAgentStop 超时未等到终态 → 退化为硬杀 killed", async () => {
    const { id } = makeRunningTask("不配合收尾的子代理");

    // 先确认优雅通道存在（否则会直接走 killAgentTask，测不到退化）
    expect(requestAgentStop(id, { timeoutMs: 10 })).toBe(true);

    // 子代理不理会停止信号：定时器到期后必须硬杀
    await waitFor(() => (getTask(id)?.status === "killed" ? true : undefined));
    expect(getTask(id)?.status).toBe("killed");
  });

  test("硬杀后残卷含确定性清单（缺口 2 与 G1 第 2 条的交点）", async () => {
    const { id, outputFile } = makeRunningTask("超时退化的子代理");

    killAgentTask(id);
    await failAgentTask(id, makeSalvageText("超时前的结论"), true);

    const content = readFileSync(outputFile, "utf-8");
    expect(content).toContain("超时前的结论");
    expect(content).toContain("<read-files");
    expect(content).toContain("<recent-calls");
  });
});

// ─── 小瑕疵：max_tokens_exhausted 的文案 ─────────────────────────────────

describe("stop_action 文案完整性", () => {
  test("max_tokens_exhausted 有专属中文文案，不落兜底的英文枚举名", () => {
    const notice = describeStopNotice("max_tokens_exhausted");
    expect(notice).toBeDefined();
    expect(notice).not.toContain("max_tokens_exhausted");
    expect(notice).toContain("续写");
  });
});

// ─── G1 第 3 条：窗口耗尽出口的收尾 ───────────────────────────────────────

async function* textStream(text: string, stopReason: string): AsyncIterable<StreamEvent> {
  yield { type: "message_start", message: { usage: { inputTokens: 10, outputTokens: 0 } } } as any;
  yield { type: "content_block_start", index: 0, content_block: { type: "text" } } as any;
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as any;
  yield { type: "content_block_stop", index: 0 } as any;
  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { outputTokens: 5 },
  } as any;
}

function makeScriptedProvider(scripted: Array<() => AsyncIterable<StreamEvent>>) {
  const calls: SendParams[] = [];
  const provider = {
    name: () => "mock",
    defaultModel: () => "mock-model",
    sendMessageStream: (params: SendParams) => {
      const idx = calls.length;
      calls.push(params);
      return scripted[Math.min(idx, scripted.length - 1)]!();
    },
  } as unknown as Provider;
  return { provider, calls };
}

describe("G1 第 3 条：窗口耗尽出口先腾空间再收尾", () => {
  test("常规压缩压不动、紧急截断腾出空间 → 强制总结并按 success:true 交回", async () => {
    const { provider, calls } = makeScriptedProvider([
      () => textStream("撞到窗口上限", "model_context_window_exceeded"),
      () => textStream("总结：三处空转，建议从 loop.ts:120 继续", "end_turn"),
    ]);

    // 4 条消息：reactiveCompact 的 <=4 守卫直接判「消息太少」→ 压不动；
    // 长文本放在**最后一条**上，累计字符到 i=3 才越过 70% 阈值，切点因此落在 3
    // （若长文本在 tool_result 里，切点会落到 1，切掉 1 条抵不过 2 条摘要前缀，
    //  emergencyTruncate 会以 no_reduction 失败 —— 实测口径见 PR 正文）。
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "看看 loop" }] });
    ctxMgr.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "a.ts" } }],
    });
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "short" }],
    });
    ctxMgr.addMessage({
      role: "assistant",
      content: [{ type: "text", text: "看到一些线索".repeat(100) }],
    });

    const result = await runAgentLoop({
      provider,
      model: "mock-model",
      ctxMgr,
      tools: new ToolRegistry(),
      maxTurns: 10,
      signal: new AbortController().signal,
      loopDetector: new LoopDetector(),
      permissionChecker: undefined,
    } as any);

    expect(result.success).toBe(true);
    expect(result.stopAction).toBe("context_window_exhausted");
    expect(result.lastTextOutput).toContain("总结：三处空转");
    // 两次请求：撞窗口那次 + 收尾轮；收尾轮不带 tools
    expect(calls.length).toBe(2);
    expect(((calls[1] as any).tools ?? []) as unknown[]).toHaveLength(0);
  });
});
