import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";

/**
 * /perf 命令实现（按需加载）。计算与渲染全在 `@sid-code/core/trace/perf-report.ts`，
 * 这里只做参数分派与取数。
 *
 * 用法：
 *   /perf                     当前会话（轨迹未落盘时回退到最近一次会话）
 *   /perf <id|前缀|latest>    指定会话
 *   /perf --days N            近 N 天 vs 前 N 天（读 ~/.sid-code/session-index.jsonl）
 *   /perf --by-version        按版本列出
 *   --json                    任一视图输出 JSON（给脚本 / 看板）
 *
 * 跨会话视图读的是会话索引而不是轨迹目录：轨迹会被 LRU 清掉，索引不会。
 */
const mod: LocalCommandModule = {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const json = tokens.includes("--json");
    const out = (obj: unknown, text: string): LocalCommandResult => ({
      type: "text",
      value: json ? JSON.stringify(obj, null, 2) : text,
    });

    const daysIdx = tokens.indexOf("--days");
    if (daysIdx >= 0 || tokens.includes("--by-version")) {
      const { readSessionIndex } = await import("@sid-code/core/trace/session-index.ts");
      const perf = await import("@sid-code/core/trace/perf-report.ts");
      const index = readSessionIndex();
      if (tokens.includes("--by-version")) {
        const report = perf.buildByVersion(index, 10);
        return out(report, perf.renderByVersion(report));
      }
      const raw = tokens[daysIdx + 1];
      // 严格解析：parseInt("7d") 静默得 7 会把错字当有效参数
      if (!raw || !/^\d+$/.test(raw) || parseInt(raw, 10) === 0) {
        return { type: "text", value: "--days 需要一个正整数，例如 /perf --days 7" };
      }
      const report = perf.buildTrend(index, {
        days: parseInt(raw, 10),
        nowSec: Math.floor(Date.now() / 1000),
      });
      return out(report, perf.renderTrend(report));
    }

    const { resolvePaths, listSessions, resolveSession, buildDigest } =
      await import("@sid-code/core/trace/digest.ts");
    const paths = resolvePaths();
    const sessions = listSessions(paths);
    if (sessions.length === 0) {
      return {
        type: "text",
        value: "本机还没有落盘的会话轨迹。跨会话趋势见 /perf --days 7。",
      };
    }
    const positional = tokens.filter((t) => !t.startsWith("--"));
    let target = positional[0];
    let note = "";
    if (!target) {
      if (ctx.sessionId && sessions.some((s) => s.id === ctx.sessionId)) {
        target = ctx.sessionId;
      } else {
        target = "latest";
        note = "（当前会话轨迹尚未落盘，改看最近一次会话）\n";
      }
    }
    const { ref, warning } = resolveSession(target, sessions);
    if (!ref) {
      return { type: "text", value: `未找到会话「${target}」。用 /trace --list 看可用会话。` };
    }
    const digest = buildDigest(ref, false, paths);
    if (!digest) {
      return { type: "text", value: `会话「${ref.id}」轨迹解析失败或为空。` };
    }

    // tok/s、工具耗时、上下文峰值由 collector 写在 session.traj 的 metadata 里，digest 不透传
    const { readFileSync } = await import("node:fs");
    let meta: Record<string, unknown> = {};
    try {
      meta = (JSON.parse(readFileSync(ref.trajPath, "utf8"))?.metadata ?? {}) as Record<
        string,
        unknown
      >;
    } catch {
      // 轨迹损坏时 digest 已有 anomaly；这里只是少几项，照常出报告
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

    const providers = digest.providerStats ?? [];
    const latencyByModel = Object.assign({}, ...providers.map((p) => p.latencyByModel ?? {}));
    // avgLatencyMs 是 Σ elapsed_ms ÷ requests 的四舍五入，乘回来误差 <1ms/轮
    const modelTimeMs = providers.reduce((a, p) => a + p.avgLatencyMs * p.requests, 0);

    const { buildSessionPerf, renderSessionPerf } =
      await import("@sid-code/core/trace/perf-report.ts");
    const report = buildSessionPerf({
      sessionId: digest.sessionId,
      model: digest.model,
      metrics: digest.sessionMetrics,
      latencyByModel,
      modelTimeMs: modelTimeMs > 0 ? modelTimeMs : undefined,
      tps: num(meta.output_tokens_per_sec),
      toolDurationMs: num(meta.total_tool_duration_ms),
      contextPeakRatio: num(meta.context_usage_peak_ratio),
      contextPeakTokens: num(meta.context_usage_peak_tokens),
    });
    const prefix = (warning ? `提示: ${warning}\n` : "") + note;
    return out(report, prefix + renderSessionPerf(report));
  },
};

export default mod;
