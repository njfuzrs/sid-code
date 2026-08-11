import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";

/**
 * /insights 命令实现（按需加载）。对齐 claude-code §4.6。
 *
 * 复用 trace/digest.ts 已导出的分析链路（与 /debug、scripts/trace-digest.ts 同源），
 * 把会话轨迹嚼碎成结构化报告：模型/耗时/API 调用/成本/token/工具序列/异常/子代理。
 *
 * 用法：
 *   /insights            — 分析当前会话（用 ctx.sessionId 定位）
 *   /insights latest     — 分析最近一个会话
 *   /insights <id|前缀>  — 分析指定会话
 *
 * 只读展示，不改任何轨迹数据。进行中会话部分字段（如 cost）可能尚未落盘为 0，
 * renderHuman 已优雅降级，不崩。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const { resolvePaths, listSessions, resolveSession, buildDigest, renderHuman } = await import(
      "@sid-code/core/trace/digest.ts"
    );

    const paths = resolvePaths();
    const sessions = listSessions(paths);
    if (sessions.length === 0) {
      return {
        type: "text",
        value: "暂无可分析的会话轨迹（轨迹采集可能未开启，或本机还没有落盘的会话）。",
      };
    }

    // 无参用当前会话 id 定位；显式参数走 id/前缀/latest。
    const arg = args.trim() || ctx.sessionId;
    const { ref, warning } = resolveSession(arg, sessions);
    if (!ref) {
      return {
        type: "text",
        value:
          `未找到会话「${arg}」。\n` +
          `可用 /insights latest 分析最近会话，或 /debug --list 查看会话列表。`,
      };
    }

    const digest = buildDigest(ref, false, paths);
    if (!digest) {
      return { type: "text", value: `会话「${ref.id}」轨迹解析失败或为空。` };
    }

    const report = renderHuman(digest, { noColor: true, invocation: "/insights" });
    const prefix = warning ? `提示: ${warning}\n\n` : "";
    return { type: "text", value: prefix + report };
  },
};

export default mod;
