import { errorText } from "../../result.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

/**
 * /trace 命令 —— 把当前/指定会话的轨迹嚼碎成结构化排查摘要。
 * 与 scripts/trace-digest.ts 共用 src/trace/digest.ts 核心逻辑。
 *
 *   /trace            分析当前正在跑的会话(ctx.sessionId,比 mtime 猜测准)
 *   /trace latest     分析最近一次结束的历史会话
 *   /trace <id>       指定会话(支持前缀)
 *   /trace --list     列出最近 20 个会话(异常会话优先排查)
 *   /trace --full     附带更多思维链/参数细节
 */
export class TraceCommand implements LocalCommandModule {
  async call(args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const { resolvePaths, listSessions, resolveSession, buildDigest, renderHuman, renderList } =
      await import("@sid-code/core/trace/digest.ts");

    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const flags = new Set(tokens.filter((t) => t.startsWith("--")));
    const positional = tokens.filter((t) => !t.startsWith("--"));
    const full = flags.has("--full");
    // 命令面板渲染纯文本,固定无 ANSI 颜色码
    const renderOpts = { noColor: true, invocation: "/trace" };

    // T15.5：/trace --health 展示 Provider 健康度看板（跨会话聚合，独立于单会话轨迹）。
    // 支持 --period 1h|24h|7d（默认 24h）与 --provider NAME 过滤。
    if (flags.has("--health")) {
      const { aggregateProviderHealth, renderHealthText } =
        await import("@sid-code/core/telemetry/provider-health.ts");
      const periodTok = positional.find((t) => /^(1h|24h|7d)$/.test(t));
      const periodMs =
        periodTok === "1h" ? 3600_000 : periodTok === "7d" ? 86400_000 * 7 : 86400_000; // 默认 24h
      // --provider 后跟的值（positional 里排除周期 token 后的第一个）
      const provTok = positional.find((t) => t !== periodTok);
      const report = aggregateProviderHealth({ periodMs, provider: provTok });
      return { type: "text", value: renderHealthText(report) };
    }

    // P2-4：跨会话缓存视图（命中率 / 省钱 / 中断归因 / 渠道可信度）。
    //
    // 此前 renderCacheSection 的唯一调用方是 scripts/trace-digest.ts —— 能力做完了
    // 却只能在仓库里跑脚本才看得到，产品内不可达。用户手上只有二进制，没有仓库。
    //
    // 必须放在下面 "no sessions" 早退**之前**：账本与 cache-breaks 是独立数据源
    //（~/.sid-code/usage-ledger.jsonl），trajectories 被 LRU 清掉后账本仍在，
    // 而那恰恰是最需要这个视图的时刻。与脚本侧的分支顺序刻意一致。
    if (flags.has("--cache")) {
      const { renderCacheSection } = await import("@sid-code/core/trace/cache-report.ts");
      // --days N 限定窗口（不传 = 全部历史）
      const daysIdx = tokens.indexOf("--days");
      const daysRaw = daysIdx >= 0 ? tokens[daysIdx + 1] : undefined;
      const days = daysRaw && /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : undefined;
      // 命令面板固定纯文本（renderOpts.noColor 同源），避免 ANSI 码污染
      return {
        type: "text",
        value: renderCacheSection({ noColor: true, sinceDays: days }),
      };
    }

    // --prune-index N：手动裁剪会话索引，只保留最近 N 行。
    //
    // pruneSessionIndex 刻意不自动调用（索引 10 万会话 ≈ 50MB，自动清理正是 P0-2
    // 要治的病），所以它必须有一个手动入口，否则就是死函数 —— 此前方案承诺了这个
    // 入口却从未接线，函数全仓零生产调用点。
    //
    // 与 --cache 同理，必须放在下面 "未找到任何会话轨迹" 早退**之前**：索引是独立
    // 数据源（~/.sid-code/session-index.jsonl），trajectories 被 LRU 清掉后索引仍在，
    // 而那恰恰是最需要裁剪它的时刻。
    if (flags.has("--prune-index")) {
      const { pruneSessionIndex, sessionIndexPath } =
        await import("@sid-code/core/trace/session-index.ts");
      // existsSync 走分支内动态 import：本文件顶层刻意零 fs 依赖（命令模块只做分派），
      // 为一个分支引入顶层 fs 会让所有命令都背上这个依赖
      const { existsSync } = await import("node:fs");
      const idx = tokens.indexOf("--prune-index");
      const raw = idx >= 0 ? tokens[idx + 1] : undefined;
      // 用正则而非 parseInt：parseInt("5x") 会静默得到 5，把用户的错字当成有效参数，
      // 而这个参数决定删掉多少行数据，宽容解析在这里是危险的
      if (!raw || !/^\d+$/.test(raw)) {
        return errorText("--prune-index 需要一个非负整数");
      }
      const n = parseInt(raw, 10);
      // 先判文件是否存在：pruneSessionIndex 对"索引不存在"和"裁剪后剩 0 行"都返回 0,
      // 两者对用户是完全不同的事实（没数据 vs 全删了），不能渲染成同一句话
      const path = sessionIndexPath();
      if (!existsSync(path)) {
        return { type: "text", value: `会话索引不存在 (${path})，无需裁剪。` };
      }
      const kept = pruneSessionIndex(n);
      return {
        type: "text",
        value:
          kept >= 0
            ? `会话索引已裁剪，保留最近 ${kept} 行 (${path})`
            : `会话索引裁剪失败（文件不可写?）: ${path}`,
      };
    }

    const paths = resolvePaths();
    const all = listSessions(paths);

    if (all.length === 0) {
      return {
        type: "text",
        value: `未找到任何会话轨迹 (${paths.sessionsDir})。可能还没产生轨迹,或 SID_CONFIG_DIR / SID_CODE_HOME 指向了别处。`,
      };
    }

    if (flags.has("--list")) {
      return { type: "text", value: renderList(all, renderOpts) };
    }

    // 目标选择:显式参数优先;否则默认当前会话(进程内可靠拿到 ctx.sessionId,
    // 避免脚本 latest 的 mtime 猜测在并发时选错)。当前会话轨迹还没落盘时回退到 latest。
    let target = positional[0];
    let note = "";
    if (!target) {
      const hasCurrent = ctx.sessionId && all.some((s) => s.id === ctx.sessionId);
      if (hasCurrent) {
        target = ctx.sessionId;
      } else {
        target = "latest";
        note = ctx.sessionId
          ? `(当前会话 ${ctx.sessionId} 轨迹尚未落盘,改看最近一次历史会话;要指定用 /trace <id>)`
          : "";
      }
    }

    const { ref, warning } = resolveSession(target, all);
    if (!ref) {
      return {
        type: "text",
        value: `未找到 session "${target}"。用 /trace --list 看可用会话。`,
      };
    }

    const digest = buildDigest(ref, full, paths);
    if (!digest) {
      return { type: "text", value: `无法解析 ${ref.trajPath}(文件损坏?)` };
    }

    const parts: string[] = [];
    if (note) parts.push(note);
    if (warning) parts.push(`⚠ ${warning}`);
    parts.push(renderHuman(digest, renderOpts));
    return { type: "text", value: parts.join("\n") };
  }
}
