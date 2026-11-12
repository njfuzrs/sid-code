import type { LocalCommandModule, LocalCommandResult, CommandContext } from "../../types.ts";

/**
 * /perf 命令实现（按需加载）。三层：取数在这里；报告模型与瓶颈判定在
 * `@sid-code/core/trace/perf-report.ts`（纯函数）；渲染在同目录 `render.ts`（string-width + 颜色）。
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

    const render = await import("./render.ts");
    const env = renderEnv(ctx);

    const daysIdx = tokens.indexOf("--days");
    if (daysIdx >= 0 || tokens.includes("--by-version")) {
      const { readSessionIndex } = await import("@sid-code/core/trace/session-index.ts");
      const perf = await import("@sid-code/core/trace/perf-report.ts");
      const index = readSessionIndex();
      if (tokens.includes("--by-version")) {
        const report = perf.buildByVersion(index, 10);
        return out(report, render.renderByVersion(report, env));
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
      return out(report, render.renderTrend(report, env));
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
    // 缓存分桶按 provider 分；多 provider 时不汇总（跨路由的命中/未命中不可比）
    const ttftByCache = providers.length === 1 ? providers[0]!.ttftByCache : undefined;

    const { buildSessionPerf } = await import("@sid-code/core/trace/perf-report.ts");
    // PR-A（A4）：会话进行中 session.traj 是中途快照。新版 builder 已在快照里写 tok/s，
    // 但旧二进制写出的快照没有 —— 用同一个公式现算兜底，避免「索引里有 tps、面板上没有」。
    const { deriveOutputTps, deriveReasoningShare } =
      await import("@sid-code/core/trace/builder.ts");
    const report = buildSessionPerf({
      sessionId: digest.sessionId,
      model: digest.model,
      // 进行中判据与 digest 同源：没收尾 = durationInProgress（快照值）
      ended: !digest.durationInProgress,
      snapshotAt: typeof meta.snapshot_at === "string" ? meta.snapshot_at : undefined,
      wallMs: digest.durationMs,
      metrics: digest.sessionMetrics,
      latencyByModel,
      ttftByCache,
      detail: digest.perfDetail,
      tps:
        num(meta.output_tokens_per_sec) ??
        deriveOutputTps({
          total_tokens_received: num(meta.total_tokens_received),
          total_gen_elapsed_ms: num(meta.total_gen_elapsed_ms),
        }),
      reasoningShare: deriveReasoningShare({
        total_tokens_received: num(meta.total_tokens_received),
        total_reasoning_tokens: num(meta.total_reasoning_tokens),
      }),
      contextPeakRatio: num(meta.context_usage_peak_ratio),
      contextPeakTokens: num(meta.context_usage_peak_tokens),
      contextWindow: num(meta.context_window_at_peak),
    });
    const prefix = (warning ? `提示: ${warning}\n` : "") + note;
    return out(report, prefix + render.renderSessionPerf(report, env));
  },
};

/**
 * 渲染环境。颜色只在交互 TUI 里开：无头（`-p` / stream-json / Bridge）的 stdout 是给下游解析的，
 * 混进 ANSI 会破坏它；`NO_COLOR` 按约定一律关。宽度取终端列数减去面板左右内边距（paddingX=1 ×2）。
 */
function renderEnv(ctx: CommandContext): { width: number; color: boolean } {
  const headless = ctx.config?.print === true;
  const color = !headless && !process.env.NO_COLOR && process.stdout.isTTY === true;
  // 非 TTY（管道 / 无头）时 columns 为 undefined：退到 COLUMNS，再退到 100
  const cols = process.stdout.columns ?? parseInt(process.env.COLUMNS ?? "", 10);
  return { width: Number.isFinite(cols) && cols > 0 ? cols - 4 : 100, color };
}

export default mod;
