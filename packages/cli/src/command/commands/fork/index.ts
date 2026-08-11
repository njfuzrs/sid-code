import type { UnifiedCommand } from "../../types.ts";

/**
 * /fork 命令定义（轻量，启动时加载）。对齐 claude-code §4.1。
 *
 * 从当前会话分叉出一个新会话（保留历史，新链独立续写，源会话不动）。
 * 运行时进程无法就地重置会话链，故本命令做「引导型」：flush 当前历史落盘后，
 * 打印可复制的 --fork-session 重启命令，由用户重启完成真分叉。实现在 ./fork.ts。
 */
const fork: UnifiedCommand = {
  type: "local",
  name: "fork",
  aliases: [],
  description: "分叉当前会话为独立新会话（打印重启命令）",
  source: "builtin",
  userInvocable: true,
  disableModelInvocation: true,
  immediate: true,
  load: () => import("./fork.ts").then((m) => m.default),
};

export default fork;
