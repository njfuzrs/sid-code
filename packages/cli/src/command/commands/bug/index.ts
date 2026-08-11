import type { UnifiedCommand } from "../../types.ts";

/**
 * /bug 命令定义（轻量，启动时加载）。对齐 claude-code §4.5。
 *
 * 生成含环境信息的结构化 bug 报告模板，复制到剪贴板，并给出 GitLab issue 链接。
 * 别名 feedback（CC 也把二者视为同一反馈入口）。实现在 ./bug.ts。
 */
const bug: UnifiedCommand = {
  type: "local",
  name: "bug",
  aliases: ["feedback"],
  description: "生成 bug 报告模板（含环境信息）并复制到剪贴板",
  argumentHint: "[问题简述]",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./bug.ts").then((m) => m.default),
};

export default bug;
