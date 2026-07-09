/**
 * /debug 命令实现
 * 调试信息：上传当前轨迹快照、显示诊断数据、复制 Session ID
 */

import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";
import { getVersion } from "../../../version.ts";
import { getSessionMetrics } from "../../../debug/index.ts";
import { setClipboard } from "../../../ink/termio/osc.ts";
import { SessionState } from "../../../session/state.ts";

const mod: LocalCommandModule = {
  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const lines: string[] = [];
    const sep = "━".repeat(38);

    // ── 基础信息 ──
    const sessionId = ctx.sessionState.sessionId;
    const version = getVersion();
    const model = ctx.config.model || "(未配置)";
    const provider = ctx.config.provider || "(未配置)";
    const cwd = ctx.cwd || process.cwd();
    const elapsed = SessionState.formatDuration(ctx.sessionState.getElapsedMs());

    // ── Token 与费用 ──
    const usage = ctx.sessionState.getTotalUsage();
    const mainCost = ctx.sessionState.totalCostUSD;
    const sideCost = ctx.sessionState.sideCostUSD;
    const totalCost = ctx.sessionState.getEffectiveTotalCostUSD();
    const cacheRead = usage.cacheReadInputTokens ?? 0;

    // ── 交互统计 ──
    const metrics = getSessionMetrics().getMetrics();
    const promptCount = metrics.interaction.promptCount;
    const turnCount = metrics.interaction.turnCount;
    const subAgentCount = metrics.interaction.subAgentCount;
    const compactCount = metrics.context.compactCount;
    const peakTokens = metrics.context.peakTokens;

    // ── 工具统计 ──
    const toolTotal = metrics.tools.totalCalls;
    const toolSuccess = metrics.tools.totalSuccess;
    const toolFail = metrics.tools.totalFail;

    // ── 剪贴板 ──
    let clipboardOk = false;
    let oscSeq = "";
    try {
      oscSeq = await setClipboard(sessionId);
      if (oscSeq) process.stdout.write(oscSeq);
      clipboardOk = true;
    } catch { /* 静默 */ }

    // ── 格式化输出 ──
    lines.push(sep);
    lines.push("              调 试 信 息");
    lines.push(sep);
    lines.push(`Session ID : ${sessionId}${clipboardOk ? "  ✓ 已复制到剪贴板" : "  ⚠ 剪贴板写入失败，请手动复制"}`);
    lines.push(`版本       : ${version}`);
    lines.push(`模型       : ${model} (${provider})`);
    lines.push(`工作目录   : ${cwd}`);
    lines.push(`运行时长   : ${elapsed}`);
    lines.push(`对话轮次   : ${turnCount} 轮 (用户提问 ${promptCount} 次${subAgentCount > 0 ? ` / 子代理 ${subAgentCount}` : ""})`);
    lines.push(`Token 用量 : 入 ${fmtNum(usage.inputTokens)} / 出 ${fmtNum(usage.outputTokens)}${cacheRead > 0 ? ` (缓存命中 ${fmtNum(cacheRead)})` : ""}`);
    lines.push(`累计费用   : $${totalCost.toFixed(4)}${sideCost > 0 ? ` (主循环 $${mainCost.toFixed(4)} + 辅助 $${sideCost.toFixed(4)})` : ""}`);
    if (compactCount > 0) {
      lines.push(`上下文压缩 : ${compactCount} 次${peakTokens > 0 ? ` (峰值 ${fmtNum(peakTokens)} tokens)` : ""}`);
    }
    if (toolTotal > 0) {
      lines.push(`工具调用   : ${toolTotal} 次 (成功 ${toolSuccess}${toolFail > 0 ? ` / 失败 ${toolFail}` : ""})`);
    }

    // ── 轨迹上传 ──
    lines.push(sep);
    lines.push("              轨 迹 上 传");
    lines.push(sep);

    const traceCollector = ctx.traceCollector;
    if (!traceCollector) {
      lines.push("状态       : ⚠ 轨迹采集未启用");
    } else {
      const uploadUrl = traceCollector.getUploadUrl();
      if (!uploadUrl) {
        lines.push("状态       : ⚠ 上传未配置（仅本地保留）");
      } else {
        // 触发即时上传（最多等 5 秒）
        try {
          const result = await traceCollector.uploadSnapshot();
          if (result.uploaded) {
            lines.push("状态       : ✓ 已上传到云端");
          } else {
            lines.push(`状态       : ✗ 上传失败: ${result.error || "未知错误"}`);
            lines.push("            轨迹已保存在本地，会话结束后自动重试");
          }
        } catch (err: any) {
          lines.push(`状态       : ✗ 上传异常: ${err.message}`);
          lines.push("            轨迹已保存在本地，会话结束后自动重试");
        }
        lines.push(`平台地址   : ${uploadUrl}`);
      }
    }

    lines.push(sep);
    lines.push("提示：将 Session ID 发送给开发者即可远程排查");

    return { type: "text", value: lines.join("\n") };
  },
};

/** 数字千分位格式化 */
function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export default mod;
