import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
// Bun text import：编译时把 md 原文内联进二进制，发布版无需运行时文件即可读到。
//
// 这两份 md 放在 `reference/`（紧贴使用方）而不是仓库根的 `api-reference/`：
// 后者已随内部研发文档整体迁出仓库（开源准备 P2-1），而它们是**编译期依赖**
// —— 删了就编译不过。所以按「被源码消费的资产属于源码」的判据留在 src/ 下。
import apiDoc from "./reference/anthropic-api.md" with { type: "text" };
import messagesDoc from "./reference/anthropic-messages-api.md" with { type: "text" };

/**
 * /claude-api 命令实现（按需加载）。对齐 claude-code §4.6。
 *
 * 把 Anthropic API 参考文档作为上下文注入对话，供后续"用 Claude API 写代码/答疑"参考。
 * CC 的 /claude-api 在导入 anthropic SDK 时自动触发；我们做成显式命令，语义等价。
 *
 * 用法：
 *   /claude-api            — 列出可加载的参考子文档
 *   /claude-api messages   — 注入 Messages API（流式 SSE 状态机）参考
 *   /claude-api api        — 注入核心 API（content blocks / tool use / thinking / caching）参考
 *   /claude-api all        — 注入全部参考
 */
const mod: LocalCommandModule = {
  async call(args: string, _ctx: CommandContext): Promise<LocalCommandResult> {
    const sub = args.trim().toLowerCase();

    if (!sub) {
      return {
        type: "text",
        value: [
          "Claude API 参考文档，可注入为对话上下文：",
          "",
          "  /claude-api api        核心 API（content blocks / tool use / 扩展思考 / prompt caching）",
          "  /claude-api messages   Messages API 流式 SSE 状态机",
          "  /claude-api all        注入全部",
          "",
          "注入后，可直接让我基于最新 API 规范帮你写/审代码。",
        ].join("\n"),
      };
    }

    let doc: string;
    let label: string;
    if (sub === "messages" || sub === "stream" || sub === "streaming") {
      doc = messagesDoc;
      label = "Anthropic Messages API（流式 SSE）";
    } else if (sub === "api" || sub === "core") {
      doc = apiDoc;
      label = "Anthropic 核心 API";
    } else if (sub === "all") {
      doc = `${apiDoc}\n\n---\n\n${messagesDoc}`;
      label = "Anthropic API 全量参考";
    } else {
      return {
        type: "text",
        value: `未知参数「${sub}」。用法: /claude-api [api|messages|all]`,
      };
    }

    const prompt = [
      `以下是「${label}」参考文档，请作为后续关于 Claude / Anthropic API 问答与写代码的权威依据`,
      `（我的训练数据可能滞后，以此文档为准）：`,
      "",
      doc,
    ].join("\n");

    return { type: "submit_prompt", prompt };
  },
};

export default mod;
