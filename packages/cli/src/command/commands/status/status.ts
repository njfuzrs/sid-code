import type { LocalCommandModule, CommandContext } from "../../types.ts";
import {
  reasoningReplayEnabled,
  listReasoningReplayUnsupported,
} from "@sid-code/core/llm/reasoning-replay.ts";

/**
 * /status 命令实现（按需加载）
 *
 * 汇总当前会话状态，纯文本一屏概览。所有数据都来自 CommandContext 已有字段/回调，
 * 拿不到的项优雅降级为"未知/-"，绝不因缺字段崩溃。
 */
const mod: LocalCommandModule = {
  async call(_args: string, ctx: CommandContext) {
    const lines: string[] = ["会话状态:"];

    // ── 模型 + 推理强度 ──
    const model = ctx.config?.model || "未知";
    lines.push(`  模型: ${model}`);

    const effort = ctx.getEffortState?.();
    if (effort) {
      const label = effort.isAuto ? "auto" : (effort.applied ?? effort.runtime ?? "auto");
      const support = effort.capability?.supportsEffort ? "" : "（当前模型不支持切换）";
      lines.push(`  推理强度: ${label}${support}`);
    }

    // ── provider + fallback ──
    if (ctx.config?.provider) {
      lines.push(`  Provider: ${ctx.config.provider}`);
    }
    if (ctx.config?.fallbackModel) {
      lines.push(`  Fallback 模型: ${ctx.config.fallbackModel}`);
    }

    // ── Responses 推理链回放（发现 1）：网关拒绝回放时如实标注，不静默降级 ──
    if (!reasoningReplayEnabled()) {
      lines.push("  推理链回放: 已关闭（SID_CODE_RESPONSES_REASONING_REPLAY=0）");
    } else {
      const rejected = listReasoningReplayUnsupported();
      if (rejected.length > 0) {
        lines.push(`  推理链回放: 网关不支持，已停止回放（${rejected.join(", ")}）`);
      }
    }

    // ── 会话标识 + 目录 ──
    lines.push("", `  会话 ID: ${ctx.sessionId ?? "-"}`);
    lines.push(`  工作目录: ${ctx.cwd ?? process.cwd()}`);

    // ── 消息数 + token 用量 ──
    try {
      const msgCount = ctx.ctxMgr.messageCount();
      const used = ctx.ctxMgr.estimateTokens();
      const max = ctx.ctxMgr.getMaxTokens?.();
      lines.push("", `  消息数: ${msgCount}`);
      if (typeof max === "number" && max > 0) {
        const pct = Math.min(100, Math.round((used / max) * 100));
        const remaining = Math.max(0, max - used);
        lines.push(
          `  上下文: ~${fmt(used)} / ${fmt(max)} tokens（已用 ${pct}%，剩余 ~${fmt(remaining)}）`,
        );
        lines.push("  提示: /context 查看分类 token 拆解");
      } else {
        lines.push(`  上下文: ~${fmt(used)} tokens`);
      }
    } catch {
      // 上下文估算失败不影响其余状态展示
    }

    // ── 激活的 skills ──
    try {
      const skills = ctx.ctxMgr.getInvokedSkills?.() ?? [];
      if (skills.length > 0) {
        lines.push(
          "",
          `  已激活 Skills: ${skills.length}（${skills.map((s) => s.name).join(", ")}）`,
        );
      }
    } catch {
      // 忽略
    }

    // ── MCP 服务器 ──
    try {
      const statuses = ctx.mcpManager?.getStatus?.() ?? [];
      if (statuses.length > 0) {
        const connected = statuses.filter((s) => s.status === "connected").length;
        const tools = statuses.reduce((sum, s) => sum + (s.toolCount ?? 0), 0);
        lines.push(`  MCP 服务器: ${connected}/${statuses.length} 已连接，共 ${tools} 个工具`);
      }
    } catch {
      // 忽略
    }

    // ── 企业登录（只在配了 backend.url 时显示；不发网络请求）──
    try {
      const { collectLoginStatus, summarizeLoginStatus } =
        await import("@sid-code/core/identity/login-status.ts");
      const summary = summarizeLoginStatus(await collectLoginStatus());
      if (summary) lines.push("", `  企业登录: ${summary}`, "  提示: /whoami 查看详情");
    } catch {
      // 登录态读取失败不影响其余状态展示
    }

    return { type: "text", value: lines.join("\n") };
  },
};

/** 千分位格式化 token 数 */
function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export default mod;
