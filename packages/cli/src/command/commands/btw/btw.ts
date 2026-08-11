import type { LocalCommandModule } from "../../types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/**
 * /btw（Side Question）命令实现（按需加载）
 *
 * 对标 cc `sideQuestion.ts`：fork 一个共享完整对话上下文的 agent 回答旁路问题。
 * - 共享主对话 system prompt + 消息历史（cache 友好）
 * - canUseTool 全部 deny（无工具权限，纯基于已有上下文回答）
 * - maxTurns=1（单次回答，不开循环）
 * - 结果直接以文本返回展示给用户，**不注入主对话**（一锤子买卖）
 *
 * 与 Session Memory / 记忆提取的区别：那两个会写文件、需要工具权限；side question
 * 是只读问答，因此无需注入 statefulTools（FileReadTracker 隔离对全 deny 场景是
 * no-op，但仍传一个空 tracker 重建的工具以防未来放开权限时回归缺口 A）。
 */
const mod: LocalCommandModule = {
  async call(args, ctx) {
    const question = args.trim();
    if (!question) {
      return {
        type: "text",
        value: "用法: /btw <你的问题>\n例如: /btw 刚才那个函数的返回值是什么类型?",
      };
    }

    const { runForkedAgent } = await import("@sid-code/core/agent/forked-agent.ts");
    const { createStatefulTools } = await import("@sid-code/core/tool/stateful-tools.ts");
    const { FileReadTracker } = await import("@sid-code/core/tool/file-read-tracker.ts");

    const messages = ctx.ctxMgr.getMessages();
    if (messages.length === 0) {
      return {
        type: "text",
        value: "当前还没有对话上下文，旁路提问需要基于已有对话。直接发消息提问即可。",
      };
    }

    const promptMessages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `<side-question>\n${question}\n</side-question>\n\n` +
              `上面是用户在等待时顺手问的一个旁路问题。请**仅基于当前对话已有的上下文**` +
              `简洁回答，不要调用任何工具，不要执行新任务。若上下文不足以回答，` +
              `直接说明缺少哪些信息即可。`,
          },
        ],
      },
    ];

    try {
      const result = await runForkedAgent(
        {
          systemPrompt: ctx.ctxMgr.getSystemPrompt(),
          messages,
          provider: ctx.provider,
          toolRegistry: ctx.toolRegistry,
          model: ctx.config.model,
          // 全 deny 场景下工具不会被执行，但仍注入独立 tracker 重建的工具，
          // 守住缺口 A 的隔离不变量（防未来放开权限时回归）。
          statefulTools: createStatefulTools(new FileReadTracker()),
        },
        {
          promptMessages,
          // 旁路问答不给任何工具权限——纯基于上下文回答。
          canUseTool: () => ({ behavior: "deny", message: "旁路提问不允许使用工具" }),
          maxTurns: 1,
          querySource: "side-question",
          timeoutMs: 60_000,
        },
      );

      // 取 forked agent 最后一条 assistant 消息的文本作为答案。
      const answer = extractAnswer(result.messages);
      if (!answer) {
        return { type: "text", value: "（旁路提问未返回内容，可能上下文不足或已超时）" };
      }
      return { type: "text", value: answer };
    } catch (err) {
      return {
        type: "text",
        value: `旁路提问失败: ${(err as Error)?.message ?? String(err)}`,
      };
    }
  },
};

/** 从 forked agent 返回的消息序列中倒序取最后一条有文本的 assistant 消息。 */
function extractAnswer(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

export default mod;
