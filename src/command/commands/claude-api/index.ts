import type { UnifiedCommand } from "../../types.ts";

/**
 * /claude-api 命令定义（轻量，启动时加载）。对齐 claude-code §4.6。
 *
 * 把 Anthropic API 参考文档注入对话，作为后续问答/写代码的依据。
 * 文档用 Bun text import 在编译时内联进二进制（发布版也能读到，不依赖运行时文件）。
 * 无参 → 列出可加载的参考子文档；带参 → 注入对应文档给模型。实现在 ./claude-api.ts。
 */
const claudeApi: UnifiedCommand = {
  type: "local",
  name: "claude-api",
  aliases: [],
  description: "加载 Claude API 参考文档作为对话上下文",
  argumentHint: "[messages|streaming|all]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./claude-api.ts").then((m) => m.default),
};

export default claudeApi;
