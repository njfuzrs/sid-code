import type { UnifiedCommand } from "../../types.ts";

/**
 * /statusline 命令定义（轻量，启动时加载）。P1-5，对标 claude-code。
 *
 * 配置一个 shell 脚本作为自定义状态栏：脚本经 stdin 收 JSON 会话数据，stdout 即
 * 状态栏内容（支持 ANSI）。未配置时走内置聚合状态栏。
 *
 * 用法：
 *   /statusline <command>       — 设置状态栏脚本（当前会话生效）
 *   /statusline <command> -p    — 设置并持久化到 settings.json（跨会话生效）
 *   /statusline off             — 禁用，回退内置状态栏
 *   /statusline off -p          — 禁用并从 settings.json 移除
 *   /statusline                 — 显示当前配置 + 数据协议说明
 */
const statusline: UnifiedCommand = {
  type: "local",
  name: "statusline",
  aliases: [],
  description: "配置自定义状态栏脚本（stdin JSON → stdout 状态栏，对齐 CC）",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./statusline.ts").then((m) => m.default),
};

export default statusline;
