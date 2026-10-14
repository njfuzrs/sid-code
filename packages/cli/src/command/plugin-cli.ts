/**
 * `plugin` CLI 子命令（对齐 claude-code `claude plugin ...`）
 *
 * 无头 CLI 入口管理插件，供脚本 / CI 使用：不启动 App、不调模型、退出码确定。
 * 修复前 CI 想装插件只能写 `-p "/plugin install x@market"`，而 -p 不分发斜杠命令，
 * 那句话被原样当成提示词交给模型（实测模型去翻二进制，110s 未结束）。
 *
 * 实现**完全复用** `/plugin` 斜杠命令（PluginCommand.execute）：TUI 与 CLI 两个入口，
 * 一套解析、一套市场/安装逻辑。子命令与参数同 `/plugin`：
 *   plugin list | market [关键词] [--market <名>] | marketplaces | info <name>
 *   plugin install <name>@<市场> | <本地目录> [--no-copy]
 *   plugin update [name] | uninstall <name> [--delete] [--force]
 *   plugin enable <name> | disable <name> [--force]
 *
 * `/plugin` 的子命令只读写插件目录与插件状态文件，从不读 AppContext（toggle 的 ctx 参数未使用），
 * 所以这里传一个空上下文是安全的。若将来某个子命令开始依赖 ctx，这里会在调用时抛错，而不是静默半生效。
 */

import type { AppContext } from "./types.ts";

const USAGE = `用法: sid-code plugin <子命令> [参数]
  list                               列出已安装插件
  market [关键词] [--market <名>]     浏览插件市场
  marketplaces                       列出已注册的市场
  info <name>                        查看插件详情
  install <name>@<市场> | <目录>      安装插件（--no-copy 本地目录不复制）
  update [name]                      更新插件
  uninstall <name> [--delete] [--force]
  enable <name> | disable <name> [--force]`;

/**
 * 执行一条 plugin 子命令，返回进程退出码（0 成功 / 1 失败）。
 *
 * 不在这里 `process.exit`：bootstrap 快速路径负责退出，单测注入 `out` 观测输出与退出码。
 */
export async function handlePluginCommand(
  args: string[],
  out: { log: (s: string) => void; error: (s: string) => void } = console,
): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    out.log(USAGE);
    return sub ? 0 : 1;
  }
  const { PluginCommand } = await import("./plugin.ts");
  // 参数按空格重新拼回：PluginCommand 自己按空白切分（含 --market=x / --market x 两种写法）
  const result = await new PluginCommand().execute(args.join(" "), {} as AppContext);
  // CLI 下没有 /reload-plugins 这一步：下次启动 sid-code 即重新加载，把 TUI 专用提示换掉
  const message = (result.message ?? "").replace(
    /提示: 运行 \/reload-plugins 使其生效/g,
    "提示: 下次启动 sid-code 时生效（已在运行的 TUI 会话里执行 /reload-plugins）",
  );
  if (result.kind === "error") {
    out.error(message);
    return 1;
  }
  out.log(message);
  return 0;
}
