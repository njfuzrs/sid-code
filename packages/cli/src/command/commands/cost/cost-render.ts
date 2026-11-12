/**
 * /cost 的渲染层（PR-B / D15）：`CostReport → string`。
 *
 * ## 与数据层的分工
 *
 * 取数全部在 core 的 `buildCostReport`（cost-report.ts），本文件只做排版：
 * 分区、对齐、千分位、颜色、窄列自适应。**这里不许再算任何指标** ——
 * 排版层重算指标正是 D9（/stats 用 stock÷flow 算出 4% 命中率）的根因。
 *
 * ## 版式规范依据
 *
 * `packages/cli/src/ui/CLAUDE.md` L1/L2：颜色走 theme 语义 token 且只点睛、
 * 数字千分位、标签缩进对齐成列（宽度用 stringWidth，中文占 2 列）、
 * 进度条用 figures.ts 的 PROGRESS_FILLED/EMPTY、说明文字放注释区不挤正文。
 *
 * ## 无头 / 管道输出必须无 ANSI（D15 规则 11）
 *
 * `/cost` 是 `headless: true` 的命令：`-p` 与管道输出走的就是这条路径，
 * 转义码会污染脚本解析。判据 `process.stdout.isTTY` —— 非 TTY 一律原样文本。
 */

import { stringWidth, applyColor } from "../../../ui/render-port/text.ts";
import { PROGRESS_FILLED, PROGRESS_EMPTY } from "../../../ui/constants/figures.ts";
import { themeManager } from "../../../ui/themes/theme-manager.ts";
import type { Color } from "@sid-code/shared/types/color.ts";
import type { CostReport } from "@sid-code/core/session/cost-report.ts";

/** 渲染选项。`useColor=false`（非 TTY / 测试）时全部着色函数退化为原样返回。 */
export interface RenderCostReportOptions {
  useColor: boolean;
  /** 终端列数。窄列（<80）去掉单价列与进度条，防换行挤乱表格。 */
  columns: number;
}

/** 千分位（en-US 分组）。不用 toLocaleString：ICU 差异会让测试在不同环境飘。 */
export function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** token 紧凑写法（byLabel 区用）：243,419 → 243k；不足 1k 原样。 */
export function fmtTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** 金额：面板统一 4 位小数（D15 数字规范——旧版 4 位/2 位混用）。 */
export function fmtUSD(n: number): string {
  return n.toFixed(4);
}

/** 单价（USD/百万）：4 位小数，去尾零不补（0.0055 / 1.0959）。 */
function fmtUnitPrice(n: number): string {
  return n.toFixed(4);
}

/** 时间格式化与 SessionState.formatDuration 同口径，这里再包一层是为了不把 core 类拖进纯渲染函数。 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

/** 价格来源 → 人话。source 是入账时记下的（`ModelPricing.source` 原值），不是渲染时再查。 */
export function pricingSourceLabel(source: string | undefined): string {
  switch (source) {
    case undefined:
      return "注册表";
    case "pricing":
      return "注册表";
    case "fallback":
      return "兜底价";
    case "local":
      return "本地（不计费）";
    default:
      // gateway:expr / gateway:legacy_ratio —— 保留 "gateway:" 后面的口径词
      if (source.startsWith("gateway:")) return `网关同步（${source.slice("gateway:".length)}）`;
      return source;
  }
}

/** 着色器：useColor=false 时全部原样返回（无头/管道输出无 ANSI 的唯一出口）。 */
function createPainter(useColor: boolean) {
  const sc = useColor
    ? themeManager.getSemanticColors()
    : {
        text: { primary: "", secondary: "" },
        ui: { active: "" },
        status: { warning: "", success: "", error: "" },
      };
  // wrap 的 color 形参声明为 string 再在调用处收窄成 Color：themeManager 的语义 token
  // 运行时都是合法 hex/ansi 色，但三元里的无色 fallback 对象（"" 字面量）把静态类型
  // 拉宽成了 string —— 在这一个点收窄，比给 fallback 对象编造 Color 类型标注干净。
  // useColor && 双重检查：sc 三元是唯一的门（useColor=false 给全空串），这里再拦一道
  // 是防御性冗余 —— 变异自证实测 wrap 单独改坏（去掉 useColor）行为等价、测试不红，
  // 门的位置在 sc，测试也锁在 sc（cost-render.test.ts 的 chalk.level 用例）。
  const wrap = (s: string, color: string) =>
    useColor && color ? applyColor(s, color as Color) : s;
  return {
    primary: (s: string) => wrap(s, sc.text.primary),
    secondary: (s: string) => wrap(s, sc.text.secondary),
    accent: (s: string) => wrap(s, sc.ui.active),
    warn: (s: string) => wrap(s, sc.status.warning),
    success: (s: string) => wrap(s, sc.status.success),
    // 总花费的强调档：颜色 + 粗体（L1「克制点睛」—— 只给首行总花费用）
    hero: (s: string) => (useColor ? `\x1b[1m${wrap(s, sc.text.primary)}\x1b[22m` : s),
  };
}

/** 按显示宽度右对齐（stringWidth：中文标签占 2 列，不能拿 .length 充数——L2.3）。 */
function padStartWidth(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : " ".repeat(width - w) + s;
}

/** 按显示宽度左对齐。 */
function padEndWidth(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** 进度条（10 格）：比例 0-1。窄列模式由调用方整体去掉这一列。 */
function progressBar(ratio: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)));
  return PROGRESS_FILLED.repeat(filled) + PROGRESS_EMPTY.repeat(10 - filled);
}

/** 渲染主入口。纯函数：同一份 CostReport + 同一份选项，输出逐字节确定。 */
export function renderCostReport(r: CostReport, opts: RenderCostReportOptions): string {
  const p = createPainter(opts.useColor);
  const narrow = opts.columns < 80;
  const cur = r.totals.fxConverted ? "≈$" : "$";
  const lines: string[] = [];

  // ── 首行：只放一个最重要的数（总花费），其余全部下放分区 ──
  // 窄列（<80）不带模型名：长网关名（origin-deepseek-v4-1-flash 28 列）会把首行顶过 70 列，
  // 折行后总花费就不是「第一眼」了。窄列下模型数在「费用构成」里仍可推导。
  const headParts = [fmtDuration(r.durations.wallMs), `${fmtInt(r.main.requests)} 次请求`];
  if (!narrow && r.byModel.length === 1) headParts.push(r.byModel[0]?.model ?? "");
  lines.push(
    `${p.primary("本次会话花费")}  ${p.hero(`${cur}${fmtUSD(r.totals.costUSD)}`)}   ${p.secondary(headParts.filter(Boolean).join(" · "))}`,
  );

  // 兜底价警告（D11）：黄警告必须出现且写明「估的」，不能和真实价混着展示。
  // 拆两行：合写一行 80+ 列（模型名 28 列 + 文案），70 列终端折行会拆散「模型」和「兜底价」的对应关系。
  for (const m of r.fallbackModels) {
    lines.push(
      p.warn(`⚠ 模型 ${m} 不在定价表中`),
      p.warn(`  费用按 $2/$10 兜底价估算，实际费用可能差很多（见下方单价来源）`),
    );
  }

  // 后台任务提示（D2）：数字还会变时必须说，否则用户拿冻结快照当终值。
  const pending = formatPendingTasksNotice(r.pending);
  if (pending) lines.push(p.secondary(pending));

  lines.push("");

  // ── 费用构成 ──
  lines.push(p.accent("费用构成"));
  const totalMain = Math.max(1e-12, r.totals.mainCostUSD + r.totals.sideCostUSD);
  const mainRatio = r.totals.mainCostUSD / totalMain;
  const sideRatio = r.totals.sideCostUSD / totalMain;
  const bar = (ratio: number) => (narrow ? "" : `  ${progressBar(ratio)}`);
  lines.push(
    `  ${padEndWidth("主循环", 12)}${padStartWidth(`${cur}${fmtUSD(r.totals.mainCostUSD)}`, 12)}  ${padStartWidth(`${Math.round(mainRatio * 100)}%`, 4)}${bar(mainRatio)}`,
  );
  if (r.side.calls > 0 || r.totals.sideCostUSD > 0) {
    // 占比偏高的警示（阈值常量，不按模型分档）：必须写原因 + 指路，不做无行动的告警。
    const SIDE_HIGH_SHARE = 0.3;
    const highNote = sideRatio >= SIDE_HIGH_SHARE ? `   ${p.warn("← 占比偏高，见下方明细")}` : "";
    lines.push(
      `  ${padEndWidth("辅助调用", 12)}${padStartWidth(`${cur}${fmtUSD(r.totals.sideCostUSD)}`, 12)}  ${padStartWidth(`${Math.round(sideRatio * 100)}%`, 4)}${bar(sideRatio)}${highNote}`,
    );
    // 按用途拆分（D14）：会话里 label 已带任务名（D10 修过 agent:fork 泛化标签）。
    for (const row of r.side.byLabel) {
      const durNote =
        row.durationCalls === row.calls && row.calls > 0
          ? ` · ${fmtDuration(row.durationMs)}`
          : row.durationCalls > 0
            ? ` · ≥${fmtDuration(row.durationMs)}（${row.durationCalls}/${row.calls} 次采集到耗时）`
            : "";
      lines.push(
        `    ${p.secondary(
          `${padEndWidth(row.label, 14)} ${row.calls} 次  ${cur}${fmtUSD(row.costUSD)}  ${fmtTokensCompact(row.tokensSent)} token${durNote}`,
        )}`,
      );
    }
  }

  lines.push("");

  // ── 主循环 token 与单价（D12/D11）──
  lines.push(p.accent("主循环 token 与单价"));
  // 单模型直接展示单价来源；多模型逐行带来源。
  const single = r.byModel.length === 1 ? r.byModel[0] : undefined;
  if (single) {
    // 单价币种用**原始价**的 currency（未折算）：网关 expr 价无 currency（USD）、注册表
    // DeepSeek 是 CNY。标题写死 USD 会把 CNY 单价冒充美元价，用户拿它乘 token 直接算错 7 倍。
    // 折算说明在注释区（「1 USD = 7.1 CNY」），这里只标币种。
    const unitCur = single.pricing?.currency ?? "USD";
    const srcNote = `单价 ${unitCur}/百万 · 来源 ${pricingSourceLabel(single.pricingSource)} · ${tierNote(single)}`;
    lines.push(`  ${p.secondary(srcNote)}`);
  }
  if (narrow) {
    lines.push(`  ${p.secondary("token / 费用 / 占比")}`);
    lines.push(
      `  ${padEndWidth("输入·未命中", 14)} ${fmtInt(r.main.uncachedTokens)}`,
      `  ${padEndWidth("输入·缓存命中", 14)} ${fmtInt(r.main.cacheHitTokens)}`,
      `  ${padEndWidth("输入·缓存写入", 14)} ${fmtInt(r.main.cacheWriteTokens)}`,
      `  ${padEndWidth("输出", 14)} ${fmtInt(r.main.outputTokens)}`,
    );
  } else {
    const c1 = padEndWidth("token", 12);
    const c2 = padEndWidth("单价", 10);
    const c3 = padEndWidth("费用", 11);
    lines.push(`  ${padEndWidth("", 14)} ${c1} ${c2} ${c3}${p.secondary("占比")}`);
    // 标签列宽取 14：「输入·缓存命中」显示宽度 13（stringWidth，·占 1 列），
    // 取 12 会让最长的标签不被 pad，金额列起点右移两格——对齐成列就断了。
    const tableRow = (
      label: string,
      tokens: number,
      unitPrice: number | undefined,
      usd: number,
      share: number,
    ) =>
      `  ${padEndWidth(label, 14)} ${padStartWidth(fmtInt(tokens), 12)} ${padStartWidth(unitPrice === undefined ? "—" : fmtUnitPrice(unitPrice), 10)} ${padStartWidth(`${cur}${fmtUSD(usd)}`, 11)}  ${Math.round(share * 100)}%`;
    const sumUSD = Math.max(1e-12, r.totals.mainCostUSD);
    // 单模型时单价来自那一条；多模型时该行是聚合值没有单一单价 → 显示 "—"
    lines.push(
      tableRow(
        "输入·未命中",
        r.main.uncachedTokens,
        single?.pricing?.input,
        single ? single.breakdown.uncachedUSD : 0,
        (single ? single.breakdown.uncachedUSD : 0) / sumUSD,
      ),
      tableRow(
        "输入·缓存命中",
        r.main.cacheHitTokens,
        single?.pricing?.cacheRead,
        single ? single.breakdown.hitUSD : 0,
        (single ? single.breakdown.hitUSD : 0) / sumUSD,
      ),
      tableRow(
        "输入·缓存写入",
        r.main.cacheWriteTokens,
        single?.pricing?.cacheWrite,
        single ? single.breakdown.writeUSD : 0,
        (single ? single.breakdown.writeUSD : 0) / sumUSD,
      ),
      tableRow(
        "输出",
        r.main.outputTokens,
        single?.pricing?.output,
        single ? single.breakdown.outputUSD : 0,
        (single ? single.breakdown.outputUSD : 0) / sumUSD,
      ),
    );
  }
  if (r.main.reasoningTokens > 0) {
    lines.push(
      `    ${p.secondary(`其中推理 ${fmtInt(r.main.reasoningTokens)}（输出的一部分，不另计费）`)}`,
    );
  }
  // 两个口径的桥（D3）：flow 与 stock 各一行 + 指向状态栏 ↑。
  // 两行而不是一行：合写一行约 119 显示列，70-118 列的终端全都会折行挤乱表格。
  lines.push(
    `  ${p.secondary(`累计发送 ${fmtInt(r.main.promptTotal)}（flow，每次请求的 prompt 都计入）`)}`,
    `  ${p.secondary(`当前上下文 ${fmtInt(r.main.contextNow)}（stock，末次请求；状态栏 ↑ 显示的就是它）`)}`,
  );

  lines.push("");

  // ── 缓存 ──
  if (r.main.cacheHitRate !== undefined || r.main.savingsUSD > 0) {
    lines.push(p.accent("缓存"));
    const rate = r.main.cacheHitRate !== undefined ? `${r.main.cacheHitRate}%` : "—";
    // 缓存断裂另起一行：并排写同一行约 75+ 显示列（断裂原因是人类可读句），70 列终端全折行。
    lines.push(
      `  命中率 ${p.primary(rate)}   省下 ${p.success(`${cur}${fmtUSD(r.main.savingsUSD)}`)}`,
    );
    if (r.cacheBreaks.count > 0 && r.cacheBreaks.latestReason) {
      lines.push(
        `  ${p.secondary(`缓存断裂 ${r.cacheBreaks.count} 次（${r.cacheBreaks.latestReason}）`)}`,
      );
    }
    // P2-2：openai 协议路径为服务端隐式缓存（cacheCreation 恒 0），命中率结构性上限
    // 约 60-70%，不同于 anthropic 族显式缓存的 90%+。对该族标注正常上限，避免用户把
    // 60-70% 误判为 harness bug。以协议路径为准，非按模型名单。
    //
    // 判据必须与命中率同源：上面的命中率是全会话跨模型聚合（buildCostReport 遍历
    // modelUsage），所以这里也遍历 byModel（同一批数据），按每条记账时的 provider 判断。
    // 不能用「当前模型」+ 全会话 cacheCreation：先 anthropic 后 /model 切 openai、或主模型
    // openai + anthropic 子代理时，anthropic 那部分的写入量会让条件恒假，提示要防的
    // 「60-70% 误判成 bug」恰好在多协议会话里重新暴露（见 cost-protocol-hint.test.ts）。
    // 写入量也只看 openai 族自己的那几条：该族恒 0（见 llm/openai-usage.ts），
    // 非 0 说明走了显式缓存，结构性上限的解释不再适用。
    const implicitCacheUsage = r.byModel.filter(
      (m) => m.provider === "openai" && m.cacheHitTokens > 0,
    );
    const hasImplicitOnly =
      implicitCacheUsage.length > 0 && implicitCacheUsage.every((m) => m.cacheWriteTokens === 0);
    if (hasImplicitOnly) {
      // 混了别的协议族时，整体命中率是两族加权的结果，不能直接拿 60-70% 去套。
      // 两版提示都拆成两行：合写一行约 76 列（混合版 96 列），70 列终端会折行挤乱。
      const mixed = r.byModel.some((m) => m.provider !== "openai" && m.cacheHitTokens > 0);
      const hintLines = mixed
        ? [
            "  （本会话混用多个协议族：openai 协议部分为隐式缓存，60-70% 属正常上限；",
            "  上面的命中率是各族加权结果，不能直接套单一族的标准）",
          ]
        : ["  （openai 协议为隐式缓存，60-70% 属正常上限；", "  90%+ 需 anthropic 族显式缓存）"];
      lines.push(...hintLines.map((s) => p.secondary(s)));
    }
  }

  lines.push("");

  // ── 单次请求（D13）──
  if (r.perRequest) {
    lines.push(p.accent("单次请求"));
    const pr = r.perRequest;
    lines.push(
      `  费用 p50 ${cur}${fmtUSD(pr.p50)} · p95 ${cur}${fmtUSD(pr.p95)} · 最高 ${cur}${fmtUSD(pr.max)}`,
    );
    for (const t of pr.top) {
      lines.push(
        `    ${p.secondary(
          `第 ${t.index} 次  ${cur}${fmtUSD(t.costUSD)}  prompt ${fmtInt(t.promptTokens)}  命中 ${fmtInt(t.cacheHit)}`,
        )}`,
      );
    }
    lines.push(
      `  ${p.secondary(`按本进程最近 ${pr.count} 次请求统计（resume 后只含本次启动的部分）`)}`,
    );
    lines.push("");
  }

  // ── 耗时（D8 文案锚点保持：三行独立，测试锁了行首与顺序）──
  lines.push(p.accent("耗时"));
  lines.push(`  API 耗时（主循环）: ${fmtDuration(r.durations.apiMainMs)}`);
  if (r.side.calls > 0) {
    if (r.durations.sideDurationCalls === 0) {
      lines.push(`  辅助调用耗时: —（本次启动后 ${r.side.calls} 次调用均未采集耗时）`);
    } else {
      const base = `  辅助调用耗时: ${fmtDuration(r.durations.sideApiMs)}`;
      lines.push(
        r.durations.sideDurationCalls < r.side.calls
          ? `${base}（本次启动后 ${r.durations.sideDurationCalls}/${r.side.calls} 次采集到耗时，其余未采集）`
          : `${base}（本次启动后 ${r.durations.sideDurationCalls} 次调用）`,
      );
    }
  }
  lines.push(`  工具耗时: ${fmtDuration(r.durations.toolMs)}`);

  // ── 有值才显示（D14）：预算 / 作废重发 ──
  if (r.budget) {
    lines.push(
      `  预算: ${cur}${fmtUSD(r.totals.costUSD)} / ${cur}${fmtUSD(r.budget.limitUSD)}（${Math.round(r.budget.ratio * 100)}%）`,
    );
  }
  if (r.main.discardedRequests > 0) {
    lines.push(
      `  ${p.warn(`作废重发 ${r.main.discardedRequests} 次（白烧 ${fmtInt(r.main.discardedPromptTokens)} token）`)}`,
    );
  }

  // ── 注释区：说明文字全部放这里，不挤正文（D15 文案规范）──
  // 每条拆成 ≤ 68 显示列的短行：注释区没有列对齐约束，拆行无代价；
  // 写成长行则 70-110 列的终端全部折行挤乱版面。
  lines.push("");
  lines.push(
    p.secondary("· 会话时长是墙钟：含思考与空闲；API 耗时只算主循环请求，"),
    p.secondary("  子代理与辅助调用不含在内"),
    p.secondary("· 辅助调用 = 标题生成、记忆抽取、权限分类、摘要等，"),
    p.secondary("  不经过主对话但同样计费；其按用途拆分仅含本次启动后的调用"),
  );
  if (r.totals.fxConverted) {
    const conv = r.totals.conversions
      .map((c) => `1 USD = ${Number(c.perUSD.toFixed(4))} ${c.currency}`)
      .join("，");
    if (conv) lines.push(p.secondary(`· 按固定汇率折算：${conv}；≈ 表示折算出的估算值`));
  }

  return lines.join("\n");
}

/** 该模型的价格时段说明（D11）：高峰占比 / 全程高峰 / 无分时段。 */
function tierNote(row: NonNullable<CostReport["byModel"][number]>): string {
  if (!row.pricing?.peakWindows || row.pricing.peakWindows.length === 0) {
    return "无分时段";
  }
  if (row.peakShare >= 0.999) return "全程高峰时段";
  if (row.peakShare <= 0.001) return "全程空闲时段";
  return `高峰占比 ${Math.round(row.peakShare * 100)}%（其余空闲价）`;
}

/** 后台闸门状态里 /cost 关心的三个字段（窄接口，便于测试注入假状态）。 */
export interface PendingTasksView {
  busy: boolean;
  busyLabel: string | null;
  pendingLabels: string[];
}

/**
 * 后台任务仍在跑时的一行提示；空闲时返回 null（整段省略，不给正常路径加噪音）。
 *
 * ## 为什么需要这一行（D2）
 *
 * /cost 的输出交给 `CommandOutputDialog` 后是**静态文本**，打开那一刻的数字不会再变。
 * 实测同一会话里 /cost 显示 $0.1447、/debug 显示 $0.1501，差额全部来自两次打开之间
 * 入账的 5 次后台记忆 fork（逐笔对账见方案文档 2.3 节）。两者读的是同一个
 * `getEffectiveTotalCostUSD()`，但面板当时**没有告诉用户"还有后台调用在跑"**，
 * 用户只能怀疑两边是两套口径。
 *
 * ## 为什么不做实时刷新
 *
 * `CommandOutputDialog` 是通用组件，为一个纯展示命令加订阅机制不划算；
 * 给一行状态提示，用户重开一次就能拿到最新值。
 *
 * ## 为什么把 pending（排队）也算进来
 *
 * 闸门语义是串行：当前任务跑完后会接着跑排队的那一笔（见 `background-task-gate.ts`）。
 * 只报「进行中」而漏掉「排队中」，用户会以为当前这一笔结束数字就定了。
 */
export function formatPendingTasksNotice(view: PendingTasksView): string | null {
  const parts: string[] = [];
  if (view.busy) parts.push(`${view.busyLabel ?? "未知任务"} 进行中`);
  // 防御性去重：闸门不会让同一 label 同时处于「在跑」和「待补」，但这里不依赖它。
  const pending = view.pendingLabels.filter((label) => label !== view.busyLabel);
  if (pending.length > 0) parts.push(`${pending.join("、")} 排队中`);
  if (parts.length === 0) return null;
  return `⚠ 后台任务 ${parts.join("、")}；费用可能还会增加，稍后重开 /cost 查看最新数字`;
}
