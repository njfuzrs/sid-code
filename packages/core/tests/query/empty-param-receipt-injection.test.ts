/**
 * 集成回归：截断/中断导致 input={} 时，下一轮必达"未落地"回执
 *
 * 背景（根治「git 快照冻结死循环」第二层·预防，见
 *   docs/bugfixes/todo/根治-git快照冻结死循环-以预防为主-对齐claude-code.md §5 第二层）：
 *   历史死循环的导火索——一个 7542 字符的超大 edit 在流式传输中被中断（用户 ESC /
 *   网络 abort / max_tokens 截断），参数 JSON 只传了一半 → 解析失败 → stream-processor
 *   静默把 input 降级成 {} → 这步 edit **没执行**。但模型"认知"里以为已发出"最后一步"，
 *   于是空转 ~40 轮反复 git status 确认"到底做完没有"。
 *
 * 本测试验证：任何因参数为空而未执行的 tool_use，queryLoop 都会在**下一轮**把一条
 *   明确的"未落地"回执注入历史（ctxMgr）——消除"以为已做"的幻觉。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse } from "@sid-code/core/llm/types.ts";

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 10 } as unknown as Config;
}

/**
 * 构造一个 loopConfig：processStream 由测试逐轮返回不同 response。
 * ctxMgr 暴露出来供断言历史里是否注入了"未落地"回执。
 *
 * opts 可选注入 abortController（模拟用户 ESC 中断流式输出——在第一轮 processStream
 * 返回 response 前触发 abort，复现"流式输出期间用户中断"的真实时序）与 sessionStore mock
 * （用于断言 abort 路径的 cancel result 是否落盘——"必达下一轮"的关键证据）。
 */
interface LoopOpts {
  abortController?: AbortController;
  sessionStore?: { appendMessage: (m: { role: string; content: unknown }) => void };
}

function makeLoopConfig(
  responses: AccumulatedResponse[],
  opts?: LoopOpts,
): { loopConfig: QueryLoopConfig; ctxMgr: ContextManager } {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "改一下文件" }] });

  let turn = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => (async function* () {})(),
    processStream: async () => {
      const r = responses[Math.min(turn, responses.length - 1)];
      // 模拟"流式输出期间用户 ESC"：在第一轮返回 response 前触发 abort，
      // 让 loop.ts:1447 的 A2 分支命中（复现真实死循环导火索时序）。
      if (turn === 0 && opts?.abortController) {
        opts.abortController.abort("user-esc");
      }
      turn++;
      return r;
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => opts?.abortController?.signal,
    abortCurrentRequest: () => {},
    uuid: () => "uuid-test",
    sessionStore:
      opts?.sessionStore as unknown as import("@sid-code/core/session/store.ts").SessionStore,
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

/** 从 ctxMgr 历史里收集所有 user 文本块内容，供断言回执是否注入。 */
function collectUserTexts(ctxMgr: ContextManager): string {
  const msgs = ctxMgr.getMessages();
  const parts: string[] = [];
  for (const m of msgs) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "text") parts.push(b.text);
      }
    }
  }
  return parts.join("\n");
}

describe("空参数未落地回执：下一轮必达（截断/中断导火索根治）", () => {
  test("input={} 的 write（write 有必填参数）→ 下一轮历史注入「未落地」回执", async () => {
    const { loopConfig, ctxMgr } = makeLoopConfig([
      // 第一轮：模型声称调用 write 但参数为空（模拟被截断/中断落成 input={}）。
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "w1", name: "write", input: {} }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      // 第二轮：模型正常收尾（此时历史里应已被注入"未落地"回执）。
      {
        role: "assistant",
        content: [{ type: "text", text: "好的" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]);

    for await (const _ev of queryLoop(loopConfig)) {
      /* 消费到结束 */
    }

    const userTexts = collectUserTexts(ctxMgr);
    // ★核心：必须注入明确的"未落地"回执，而非静默降级。
    expect(userTexts).toContain("未执行");
    expect(userTexts).toContain("没有落地");
    // 覆盖中断/截断成因（abort 路径也要说清），并给重发引导。
    expect(userTexts).toContain("中断");
    expect(userTexts).toContain("重新发出这次调用");
  }, 15_000);

  test("stop_reason=max_tokens 的 edit → 回执走截断分支，含分段写入引导", async () => {
    const { loopConfig, ctxMgr } = makeLoopConfig([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "e1", name: "edit", input: {} }],
        stopReason: "max_tokens",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "好的" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]);

    for await (const _ev of queryLoop(loopConfig)) {
      /* 消费到结束 */
    }

    const userTexts = collectUserTexts(ctxMgr);
    expect(userTexts).toContain("未执行");
    expect(userTexts).toContain("截断");
    expect(userTexts).toContain("分段");
    // 截断分支明确点名 max_tokens，避免模型原样重发超大调用再次被截断。
    expect(userTexts).toContain("max_tokens");
  }, 15_000);

  // ★缺口 2+4 补强：abort 路径（用户 ESC 中断流式输出）的"未落地"回执必达链路。
  //
  // 历史死循环的导火索正是"超大 edit 被中断 → 模型误以为已执行 → 空转确认"。
  // loop.ts:1441-1482 的 A2 分支：检测到 abort 后，给 pending tool_uses 注入 cancel result
  // 并 sessionStore.appendMessage 落盘。本测试断言这条链路：
  //   (1) cancel result 措辞含"被中断/未执行/没有落地/分段写入"（消除"以为已做"的幻觉）；
  //   (2) cancel result 已通过 sessionStore 落盘——会话恢复时 history 重建必读，即"必达下一轮"
  //       在会话恢复语义下成立（abort 即结束本轮，无"同 generator 内下一轮"，恢复即下一轮）。
  test("abort 路径（用户 ESC 中断）→ cancel result 含「未落地」回执且已落盘（必达链路）", async () => {
    const appended: { role: string; content: unknown }[] = [];
    const sessionStore = {
      appendMessage: (m: { role: string; content: unknown }) => {
        appended.push(m);
      },
    };
    // 真实 AbortController：makeLoopConfig 会在第一轮 processStream 返回 response 前触发 abort，
    // 复现"流式输出期间用户 ESC"的真实时序（loop.ts:1447 的 A2 分支命中）。
    const abortController = new AbortController();
    const { loopConfig, ctxMgr } = makeLoopConfig(
      [
        // 第一轮：模型发出 write 调用（参数完整），但流式输出被用户 ESC 中断。
        // abortController 在 processStream 内 abort → 走 A2 分支，给 pending tool_use 注入 cancel result。
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "w1",
              name: "write",
              input: { file_path: "/a.ts", content: "x" },
            },
          ],
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      ],
      { abortController, sessionStore },
    );

    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
    }

    // (1) abort 路径必 yield done 结束（不留半截 generator）。
    expect(kinds).toContain("done");

    // (2) cancel result 已落盘 sessionStore（必达链路的核心证据）。
    //     assistant + cancel(user) 两条都应 appendMessage。
    const cancelMsg = appended.find((m) => m.role === "user");
    expect(cancelMsg).toBeDefined();
    const cancelText = JSON.stringify(cancelMsg!.content);
    expect(cancelText).toContain("被中断");
    expect(cancelText).toContain("未执行");
    expect(cancelText).toContain("没有落地");
    expect(cancelText).toContain("分段写入");

    // (3) ctxMgr 历史同样注入了 cancel result（内存 + 落盘双通道一致）。
    //     cancel result 是 tool_result 格式（content 为字符串），collectUserTexts 只收 text 块会漏，
    //     故序列化全量 user 消息以覆盖 tool_result.content。
    const allUserSerialized = JSON.stringify(ctxMgr.getMessages().filter((m) => m.role === "user"));
    expect(allUserSerialized).toContain("被中断");
    expect(allUserSerialized).toContain("没有落地");
  }, 15_000);
});
