import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";

/**
 * /statusline 命令实现（按需加载）。P1-5。
 *
 * 把用户脚本注册为自定义状态栏。状态经 ctx.setStatusLine 推到 TUIState.statusLine
 * → configValue → Footer 即时切换（配了脚本走脚本、否则内置）。
 * 持久化语义与 /vim、/theme 对齐：默认仅当前会话，加 -p 才写 settings.json。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    if (!ctx.setStatusLine) {
      return { type: "text", value: "当前环境不支持自定义状态栏（无 TUI）。" };
    }

    const raw = args.trim();

    // 无参：显示当前配置 + 数据协议说明。
    if (!raw) {
      const cur = ctx.getStatusLine?.();
      const lines: string[] = ["自定义状态栏（/statusline）:"];
      if (cur?.command) {
        lines.push(`  当前脚本: ${cur.command}`);
        if (cur.padding) lines.push(`  左侧留白: ${cur.padding}`);
      } else {
        lines.push("  当前: 内置聚合状态栏（未配置自定义脚本）");
      }
      lines.push(
        "",
        "用法:",
        "  /statusline <命令>      设置脚本（当前会话）",
        "  /statusline <命令> -p   设置并持久化到 settings.json",
        "  /statusline off         禁用，回退内置",
        "  /statusline off -p      禁用并从 settings.json 移除",
        "",
        "脚本协议: 经 stdin 收到 JSON（cwd/gitBranch/worktree/permissionMode/model/",
        "  inputTokens/outputTokens/contextPercent/costUSD/cacheHitRate/effort/thinking），",
        "  stdout 即状态栏内容（支持 ANSI 颜色）。超时 1s / 非零退出自动回退内置。",
        "",
        "示例: /statusline 'jq -r \"\\(.model) · \\(.gitBranch) · \\(.contextPercent)%\"'",
      );
      return { type: "text", value: lines.join("\n") };
    }

    // 解析 -p / --persist / save 持久化标志（从尾部剥离，其余是脚本命令）。
    const persistRe = /\s+(-p|--persist|save)\s*$/;
    const persist = persistRe.test(raw);
    const body = persist ? raw.replace(persistRe, "").trim() : raw;

    // 禁用：off / disable / none。
    if (/^(off|disable|none)$/i.test(body)) {
      ctx.setStatusLine(undefined, persist);
      const suffix = persist ? "，并已从 settings.json 移除" : "（仅当前会话）";
      return { type: "text", value: `已禁用自定义状态栏，回退内置${suffix}` };
    }

    // 设置脚本命令。去掉用户可能加的成对引号（一层）。
    const command = stripOuterQuotes(body);
    if (!command) {
      return { type: "text", value: "错误: 脚本命令为空。用法: /statusline <命令> [-p]" };
    }
    ctx.setStatusLine({ type: "command", command }, persist);
    const suffix = persist
      ? "，并已保存到 settings.json（跨会话生效）"
      : "（仅当前会话，加 -p 可持久化）";
    return { type: "text", value: `已设置自定义状态栏脚本: ${command}${suffix}` };
  },
};

/** 去掉字符串最外层的一对成对引号（' 或 "），无成对引号则原样返回。 */
function stripOuterQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return s.slice(1, -1);
    }
  }
  return s;
}

export default mod;
