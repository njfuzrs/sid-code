import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { getLogger } from "../../../debug/logger.ts";

/**
 * /fork 命令实现（按需加载）。对齐 claude-code §4.1。
 *
 * 运行时真分叉不可行：restoreSession/doInit 是启动期一次性流程，当前进程已绑定
 * 一个 sessionId + currentFile，没有"就地重置会话到某点开新链"的运行时通道。
 * 已有的完整分叉能力（--fork-session）全绑在启动路径。
 *
 * 故做「引导型」命令：先 flush 当前会话历史落盘，再打印可复制的 --fork-session
 * 重启命令，由用户重启进程完成真分叉（新会话写 parentUuid=当前 id，源会话不动）。
 */
const mod: LocalCommandModule = {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const sid = ctx.sessionId;
    if (!sid) {
      return { type: "text", value: "当前没有可分叉的会话（会话 ID 未知）。" };
    }

    // 确保当前历史已落盘，重启 resume 时能读到完整上下文。
    try {
      const { flushPendingSessionWrites } = await import("../../../session/store.ts");
      flushPendingSessionWrites();
    } catch (e) {
      getLogger().warn("FORK", `flush 会话历史失败（不阻断）: ${(e as Error)?.message}`);
    }

    const cmd = `sid-code --resume ${sid} --fork-session`;
    return {
      type: "text",
      value: [
        "会话分叉（fork）",
        "",
        "运行时无法就地分叉，请重启进程完成——已确保当前历史落盘。",
        "复制下面的命令在新终端执行：",
        "",
        `  ${cmd}`,
        "",
        "新会话会保留当前完整历史并独立续写（记录 parentUuid 指向当前会话），",
        "源会话不受影响。若想指定新会话 ID，再加 --session-id <uuid>。",
      ].join("\n"),
    };
  },
};

export default mod;
