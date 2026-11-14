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
import type { CostReport, CacheBreakEvidence } from "@sid-code/core/session/cost-report.ts";

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

/**
 * 辅助调用明细里的金额（CP-10c）：真实发生过花费、但小于 $0.0001 的显示成 `<$0.0001`。
 *
 * 为什么不直接改 `fmtUSD`：表格里的费用列必须能验算（`token × 均价 ÷ 1e6` 与显示值
 * 一致），把它变成 `<$0.0001` 会让验算无从比对。而明细行是**自由文本**，那里的
 * `$0.0000` 只有一个后果 —— 用户以为这次调用免费，实际它在累加。两种场景的诉求相反，
 * 所以刻意分成两个函数，而不是加一个全局开关。
 */
function fmtSideUSD(n: number): string {
  return n > 0 && n < 0.0001 ? "<$0.0001" : `$${fmtUSD(n)}`;
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
  //
  // CP-5：请求数必须拆成**主循环 + 辅助调用**两个数，且辅助那半边带作用域标注。
  //
  // 旧写法只有一个 `31 次请求`，取自 `r.main.requests`（会话级快照，resume 后含历史）；
  // 而 `/cost` 里其他所有辅助调用数字（费用、耗时、按用途拆分）都来自进程级单例，
  // **只含本次启动**。同一个面板里两个数一个含历史、一个不含，用户把它们加起来
  // 或做除法就得到错的比例。合成一个数会把这个口径差藏起来，拆开加标注才看得出来。
  const sideCalls = r.side.calls;
  const headParts = [fmtDuration(r.durations.wallMs)];
  if (narrow) {
    // 70 列放不下「主循环 N 次 · 辅助 M 次（本进程）」：用 a+b 的形式保住信息量，
    // 作用域在注释区统一说明（「辅助调用 = 本次启动后」）。
    headParts.push(`请求 ${fmtInt(r.main.requests)}+${fmtInt(sideCalls)}`);
  } else {
    headParts.push(
      sideCalls > 0
        ? `主循环 ${fmtInt(r.main.requests)} 次 · 辅助 ${fmtInt(sideCalls)} 次（本次启动后）`
        : `主循环 ${fmtInt(r.main.requests)} 次请求`,
    );
  }
  // 模型名阈值从 80 提到 100：首行多了「辅助 N 次（本次启动后）」约 20 列，
  // 80-99 列终端会折行把总花费挤到第二行。100 列以上放得下两段信息。
  if (opts.columns >= 100 && r.byModel.length === 1) headParts.push(r.byModel[0]?.model ?? "");
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
      // CP-10d：token 列标成「发送」并附命中率。`tokensSent` 是 input 累计，
      // `cacheReadTokens` 是其中命中缓存的部分，两者同源（同一次调用的 usage），
      // 所以这里的比例与模型命中率可比。不显示的话用户只看到「325k token」，
      // 完全看不出这 325k 里有九成按缓存价计费。
      const hitNote =
        row.tokensSent > 0 && row.cacheReadTokens > 0
          ? `（命中 ${Math.round((row.cacheReadTokens / row.tokensSent) * 100)}%）`
          : "";
      lines.push(
        `    ${p.secondary(
          `${padEndWidth(row.label, 14)} ${row.calls} 次  ${fmtSideUSD(row.costUSD)}  ${fmtTokensCompact(row.tokensSent)} token${hitNote}${durNote}`,
        )}`,
      );
    }
  }

  lines.push("");

  // ── 主循环 token 与单价（D12/D11）──
  lines.push(p.accent("主循环 token 与单价"));
  // 单模型直接展示来源；多模型逐行带来源。
  const single = r.byModel.length === 1 ? r.byModel[0] : undefined;
  if (single) {
    // CP-4：这两行说的是**两件不同的事**，必须分开写：
    //   ① 首行 = 实际均价（费用反推）+ 来源 + 时段；
    //   ② 次行 = 牌价（`pricing` 的四个数字，高峰价；空闲由系数派生）。
    //
    // 旧实现只写 ①（但标成「单价」用的是牌价），于是全空闲会话里表格费用列是牌价的一半，
    // 「token × 单价」永远算不出费用。把牌价移到这里之后，它仍然是用户最关心的
    // 价目信息（「这一档多少钱」），只是不再冒充用来验算的那个数。
    //
    // 币种：均价固定 USD（费用是 USD），牌价用原始价的 currency —— 网关 expr 无 currency
    // （USD）、注册表 DeepSeek 是 CNY。混成一个币种会让用户拿 CNY 单价乘 token 算错 7 倍。
    const unitCur = single.pricing?.currency ?? "USD";
    lines.push(
      `  ${p.secondary(`主循环均价 USD/百万 · 来源 ${pricingSourceLabel(single.pricingSource)} · ${tierNote(single)}`)}`,
    );
    const priceLine = formatPriceLine(single, unitCur, narrow);
    if (priceLine) lines.push(`  ${p.secondary(priceLine)}`);
  }
  if (r.main.breakdownCarried === false) {
    // 旧快照回灌：四段费用是 0 而总额非 0。**不拿 0 冒充**，整段降级说明。
    lines.push(`  ${p.warn("四段费用不可用（该快照早于分桶记账，只有总额可信）")}`);
  }
  if (narrow) {
    lines.push(`  ${p.secondary("token / 费用 / 占比")}`);
    // 0 值的命中/写入行整行省略（D5 的既有契约）：0 不参与加法，用户照样能验算；
    // 每行都列一遍 0 会让面板被无成本项填满，反而盖住真正的成本来源。
    lines.push(`  ${padEndWidth("输入·未命中", 14)} ${fmtInt(r.main.uncachedTokens)}`);
    if (r.main.cacheHitTokens > 0) {
      lines.push(`  ${padEndWidth("输入·缓存命中", 14)} ${fmtInt(r.main.cacheHitTokens)}`);
    }
    if (r.main.cacheWriteTokens > 0) {
      lines.push(`  ${padEndWidth("输入·缓存写入", 14)} ${fmtInt(r.main.cacheWriteTokens)}`);
    }
    lines.push(`  ${padEndWidth("输出", 14)} ${fmtInt(r.main.outputTokens)}`);
  } else {
    const c1 = padEndWidth("token", 12);
    // CP-4：列头从「单价」改成「均价」—— 这一列现在是费用反推的加权均价，
    // 不是牌价。名字不改，用户会拿它当价目表，然后发现乘出来对不上费用。
    const c2 = padEndWidth("均价", 10);
    const c3 = padEndWidth("费用", 11);
    lines.push(`  ${padEndWidth("", 14)} ${c1} ${c2} ${c3}${p.secondary("占比")}`);
    // 标签列宽取 14：「输入·缓存命中」显示宽度 13（stringWidth，·占 1 列），
    // 取 12 会让最长的标签不被 pad，金额列起点右移两格——对齐成列就断了。
    const tableRow = (
      label: string,
      tokens: number,
      avgPrice: number | undefined,
      usd: number,
      share: number,
    ) =>
      `  ${padEndWidth(label, 14)} ${padStartWidth(fmtInt(tokens), 12)} ${padStartWidth(avgPrice === undefined ? "—" : fmtUnitPrice(avgPrice), 10)} ${padStartWidth(`${cur}${fmtUSD(usd)}`, 11)}  ${Math.round(share * 100)}%`;
    const sumUSD = Math.max(1e-12, r.totals.mainCostUSD);
    // CP-4：四段费用与均价都取 main 聚合值（byModel 各段之和），**不再按 single 分支**。
    // 多模型时旧实现四段全显示 $0.0000，用户既算不出也无法验算；聚合后
    // 「该段 token × 均价 ÷ 1e6 === 该段费用」在单模型与多模型下都成立。
    // 0 值的命中/写入行同窄列一样整行省略：三段互斥的加法只依赖出现的行。
    lines.push(
      tableRow(
        "输入·未命中",
        r.main.uncachedTokens,
        r.main.avgPrice.uncached,
        r.main.breakdown.uncachedUSD,
        r.main.breakdown.uncachedUSD / sumUSD,
      ),
      ...(r.main.cacheHitTokens > 0
        ? [
            tableRow(
              "输入·缓存命中",
              r.main.cacheHitTokens,
              r.main.avgPrice.hit,
              r.main.breakdown.hitUSD,
              r.main.breakdown.hitUSD / sumUSD,
            ),
          ]
        : []),
      ...(r.main.cacheWriteTokens > 0
        ? [
            tableRow(
              "输入·缓存写入",
              r.main.cacheWriteTokens,
              r.main.avgPrice.write,
              r.main.breakdown.writeUSD,
              r.main.breakdown.writeUSD / sumUSD,
            ),
          ]
        : []),
      tableRow(
        "输出",
        r.main.outputTokens,
        r.main.avgPrice.output,
        r.main.breakdown.outputUSD,
        r.main.breakdown.outputUSD / sumUSD,
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
  // 显示条件里必须有断裂记录（CP-8/CP-9）：断裂是「缓存出过问题」的直接证据，
  // 而它恰恰可能发生在命中率算不出来的时候（首轮就断、或该协议不回报命中 token）。
  // 旧条件只有「有命中率或省钱」，于是最该看到断裂的人反而看不到 —— 这是本 PR 修掉的
  // 一类「信息被前置条件藏起来」的形态，别再把它加回去。
  const hasPrefixBreaks =
    r.cacheBreaks.prefixBreaks.available && r.cacheBreaks.prefixBreaks.count > 0;
  if (
    r.main.cacheHitRate !== undefined ||
    r.main.savingsUSD > 0 ||
    r.cacheBreaks.count > 0 ||
    hasPrefixBreaks
  ) {
    lines.push(p.accent("缓存"));
    // 1 位小数（D15 版式 91.7%）：数据层给的是精确百分比，取整会让 91.7 变成 92，
    // 与「命中率偏低」的阈值判断（同一份数值）产生肉眼可见的不一致。
    const rate = r.main.cacheHitRate !== undefined ? `${r.main.cacheHitRate.toFixed(1)}%` : "—";
    // 缓存断裂另起一行：并排写同一行约 75+ 显示列（断裂原因是人类可读句），70 列终端全折行。
    lines.push(
      `  命中率 ${p.primary(rate)}   省下 ${p.success(`${cur}${fmtUSD(r.main.savingsUSD)}`)}`,
    );
    // CP-8：归因按**结构化字段**拼，不再把 `changes[]` 的中文句子整段塞进括号。
    // 旧实现只显示次数 + 最弱的一条证据（hash 未变），更强的两条（消息前缀逐字节一致、
    // 无重试）判过了却不显示，用户看到的结论比实际证据弱得多。
    if (r.cacheBreaks.count > 0) {
      lines.push(
        `  ${p.secondary(
          `命中下降 ${r.cacheBreaks.count} 次（上游波动 ${r.cacheBreaks.upstreamCount} / 本地 ${r.cacheBreaks.localCount}）`,
        )}`,
      );
      const ev = r.cacheBreaks.latest;
      if (ev) {
        const detail = formatCacheBreakEvidence(ev, r.cacheBreaks.latestReason);
        for (const d of detail) lines.push(`    ${p.secondary(d)}`);
      }
    }
    // CP-9：字节侧断裂 —— 与上面那个 token 侧检测器**各报各的**。
    // 只在检测器可用时显示：没有数据写「0 次」会把「没采集」伪装成「前缀一直健康」。
    const pb = r.cacheBreaks.prefixBreaks;
    if (pb.available && pb.count > 0) {
      const waste =
        pb.latestWastedRatio !== undefined
          ? `，浪费约 ${(pb.latestWastedRatio * 100).toFixed(1)}% 字符`
          : "";
      lines.push(`  ${p.secondary(`本地前缀断裂 ${pb.count} 次（字节级${waste}）`)}`);
    }
    // D6：只在实测命中率确实偏低且样本足够时提示，且给的是可行动作（/cache --breaks）。
    //
    // 旧实现写死「openai 族 60-70% 属正常上限」，**完全不看实际数值** —— 取证会话
    // （20261110-142303-21c3a481）里命中率 91.7%，下一行却是「60-70% 属正常上限」，
    // 自相矛盾；而实测主流 openai 兼容渠道命中率 80–95%（阈值依据见
    // LOW_CACHE_HIT_RATE_THRESHOLD），旧口径本身就不成立。
    //
    // 判据与命中率同源：两边都来自 buildCostReport 的 r.main（同一批 modelUsage 数据），
    // 不再按「当前模型 provider」拼条件 —— 那种判据在多协议会话里会漏提示。
    const hint = formatCacheHitHint(r.main.cacheHitRate ?? 0, r.main.requests);
    if (hint) lines.push(p.secondary(hint));
  }

  lines.push("");

  // ── 单次请求（D13）──
  if (r.perRequest) {
    lines.push(p.accent("单次请求"));
    const pr = r.perRequest;
    // CP-10b：p95 在样本不足时**不给数**，并且把 n 显示出来。
    //
    // 旧实现恒定输出 p50/p95/最高，而 D13 的缓冲只留最近 20 条 —— n=4 时
    // 「p95」的数学含义是「第 4 个值」，它和「最高」是同一个数，用户看到
    // p95 ≈ 最高会以为分布很平，实际只是样本太少。样本不足时说清样本量，
    // 比给一个看起来精确的分位数诚实得多。
    const PER_REQUEST_P95_MIN_SAMPLES = 20;
    const haveP95 = pr.count >= PER_REQUEST_P95_MIN_SAMPLES;
    const parts = [`p50 ${cur}${fmtUSD(pr.p50)}`];
    if (haveP95) parts.push(`p95 ${cur}${fmtUSD(pr.p95)}`);
    parts.push(`最高 ${cur}${fmtUSD(pr.max)}`);
    lines.push(`  费用 ${parts.join(" · ")}（n=${pr.count}）`);
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
    // CP-10a：标签写清「逐次累计」—— 这个数是 N 次调用各自墙钟之和，不是它们占据的
    // 那段时间（辅助调用与主循环可能重叠）。用户拿它和上面的「API 耗时（主循环）」
    // 相加会得到一个比会话时长还大的数，然后以为计时坏了。口径写进标签是最省的解释。
    if (r.durations.sideDurationCalls === 0) {
      lines.push(`  辅助调用耗时（逐次累计）: —（本次启动后 ${r.side.calls} 次调用均未采集耗时）`);
    } else {
      const base = `  辅助调用耗时（逐次累计）: ${fmtDuration(r.durations.sideApiMs)}`;
      lines.push(
        r.durations.sideDurationCalls < r.side.calls
          ? `${base}（本次启动后 ${r.durations.sideDurationCalls}/${r.side.calls} 次采集到耗时，其余未采集）`
          : `${base}（本次启动后 ${r.durations.sideDurationCalls} 次调用）`,
      );
    }
  }
  lines.push(`  工具耗时: ${fmtDuration(r.durations.toolMs)}`);
  // PR-A 的收尾：辅助调用自报尚未全部入账时给一行提示（**只提示不补账**）。
  // 补账由会话结束时的 `reconcileSelfReports({ apply: true })` 做 —— 在这里补会让
  // 在途调用的自报晚到几毫秒后重复入账。提示的作用是让用户知道「数字还会涨」，
  // 而不是怀疑面板又算漏了（那正是 CP-1 的原始症状）。
  const gap = r.selfReportGap?.pendingCalls ?? 0;
  if (gap > 0) {
    lines.push(
      `  ${p.warn(`⚠ ${gap} 次辅助调用尚未自报入账（在途或刚结束），本次数字可能偏低；会话结束时会自动补账`)}`,
    );
  }

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
  lines.push("");
  lines.push(
    p.secondary("· 会话时长是墙钟：含思考与空闲；API 耗时只算主循环请求，"),
    p.secondary("  子代理与辅助调用不含在内"),
  );
  // CP-10a 的口径说明只在真有辅助调用时才写：没有辅助调用时这行是纯噪音，
  // 而且它的正文含「辅助调用耗时」字样，会让「无辅助调用 → 该行整段省略」的
  // 既有契约（cost-api-duration.test.ts）变成假绿 —— 断言按子串匹配，看不见语境。
  if (r.side.calls > 0) {
    lines.push(
      p.secondary("· 辅助调用耗时是逐次累计：N 次调用各花的时间之和，"),
      p.secondary("  不是它们占据的那段墙钟，不能与上面的 API 耗时直接相加"),
    );
  }
  lines.push(
    p.secondary("· 辅助调用 = 标题生成、记忆抽取、权限分类、摘要等，"),
    p.secondary("  不经过主对话但同样计费；其费用/耗时/按用途拆分仅含本次启动后"),
    p.secondary("· 请求数与费用是会话级（resume 后含历史）；"),
    p.secondary("  标了「本次启动后」的辅助调用数字不含 resume 前的部分"),
    p.secondary("· 均价 = 该段费用 ÷ 该段 token（由费用反推，含分时段加权）；"),
    p.secondary("  牌价是当前档位价目，两者不同源，别拿牌价乘 token 对费用"),
  );
  if (r.totals.fxConverted) {
    const conv = r.totals.conversions
      .map((c) => `1 USD = ${Number(c.perUSD.toFixed(4))} ${c.currency}`)
      .join("，");
    if (conv) lines.push(p.secondary(`· 按固定汇率折算：${conv}；≈ 表示折算出的估算值`));
  }

  return lines.join("\n");
}

/**
 * 该模型的价格时段说明（CP-3）：**三态**，不是「占比」一个数。
 *
 * 旧版在这里签名收 `peakShare: number`（数据层用 `?? costUSD` 兜成恒 1），
 * 于是全程空闲的会话显示「全程高峰时段」。现在数据层给出 `undefined` 表示
 * 「拆分不可用」，渲染层必须把这件事说出来 —— 沉默或猜一个值都是在骗人。
 *
 * 措辞用「高峰**费用**占比」而不是「高峰占比」：账本另有一个 `peakRatio` 是
 * 「高峰请求数 / 分时段请求数」，分母与范围都不同。两个都叫「高峰占比」时
 * 用户会拿它们对照，然后发现对不上（CP-3 的原始症状之一）。
 */
function tierNote(row: NonNullable<CostReport["byModel"][number]>): string {
  if (!row.pricing?.peakWindows || row.pricing.peakWindows.length === 0) {
    return "无分时段";
  }
  const share = row.peakShare;
  // undefined 的三种来路见 cost-report.ts 的 resolvePeakShare：无费用 / 旧快照 / 两桶对不上。
  // 对用户统一说「不可用」——三种来路的共同事实就是「没法给出可信的占比」。
  if (share === undefined) return "时段拆分不可用（旧快照或无费用明细）";
  if (share >= 0.999) return "全程高峰时段";
  if (share <= 0.001) return "全程空闲时段";
  return `高峰费用占比 ${Math.round(share * 100)}%（其余空闲价）`;
}

/**
 * CP-8：把一条断裂的**结构化证据**拼成人话（最多三行，每行 ≤ 70 显示列）。
 *
 * ## 为什么按字段拼，而不是直接显示 `changes`
 *
 * `changes` 是给人看的句子、可以有多条（system 变了 + tools 变了 + TTL 过期），
 * 渲染层若直接 join 会得到 90+ 列的一行，70 列终端必然折行；更要紧的是它**没有强弱之分** ——
 * 而判定「这是不是上游波动」恰恰依赖三条证据同时成立（hash 未变、消息前缀一致、无重试）。
 * 字段化之后，面板显示的证据与聚合统计用的判据是同一份，不会出现「面板说上游、账本说本地」。
 *
 * `verdict` 取自 `categories`（结构化），不解析中文文案 —— 文案改一个字的代价是
 * 历史统计整体漂移，而那种漂移没有任何东西会红（P0-2 修掉的反模式）。
 */
function formatCacheBreakEvidence(ev: CacheBreakEvidence, fallbackReason: string | null): string[] {
  const lines: string[] = [
    `最近一次 ${fmtInt(ev.previousCacheReadTokens)}→${fmtInt(ev.currentCacheReadTokens)}（-${ev.dropPercent}%）`,
  ];
  // 三态逐条说清：「不可判」必须显式写出来，不能省略（省略 = 暗示「没变化」）。
  const evidence: string[] = [];
  evidence.push(
    ev.prefixHashSame === true
      ? "system/tools 未变"
      : ev.prefixHashSame === false
        ? "system/tools 已变"
        : "system/tools 不可判",
  );
  evidence.push(
    ev.messagePrefixSame === true
      ? "消息前缀逐字节一致"
      : ev.messagePrefixSame === false
        ? "消息前缀被改写"
        : "消息前缀不可判",
  );
  if (ev.precededByRetry === true) evidence.push("两次请求间有重试");
  else if (ev.precededByRetry === false) evidence.push("两次请求间无重试");
  lines.push(`证据 ${evidence.join("、")}`);
  const verdict = cacheBreakVerdict(ev, fallbackReason);
  if (verdict) lines.push(`→ ${verdict}`);
  return lines;
}

/** 归因结论（CP-8）：按 `categories` 结构化映射，不解析文案。 */
function cacheBreakVerdict(ev: CacheBreakEvidence, fallbackReason: string | null): string | null {
  const cats = ev.categories;
  // 顺序有意义：一条断裂可能同时带多个类别，先给「本地可优化」的结论 ——
  // 用户能改的那些必须排在「改不动」的前面，否则它会以为自己无能为力。
  if (cats.includes("message_history")) return "本地消息历史被改写，可优化";
  if (cats.includes("prefix_break")) return "本地前缀断裂，可优化";
  if (cats.includes("system_prompt") || cats.includes("tools") || cats.includes("tool_order")) {
    return "本地 system/tools 变化，可优化";
  }
  if (cats.includes("compact")) return "压缩改写了历史前缀，属正常行为";
  if (cats.includes("server_fluctuation")) return "上游缓存波动（网关或厂商），本地不可控";
  if (cats.includes("ttl_expiry")) return "空闲超过缓存 TTL，属正常行为";
  if (cats.includes("model")) return "换了模型，必然全量重算";
  // 兜底用产出侧那句人话（`changes` 已含具体原因），但不拼多条 —— 一行放不下。
  return fallbackReason;
}

/**
 * 牌价行（CP-4）：`pricing` 里的四个数字 —— **高峰价**，空闲价由 `offPeakMultiplier` 派生。
 *
 * 单独成行而不是塞进上面那行：这一行的语义是「价目表」（多少钱一档），上一行是
 * 「我实际按什么价结算」（均价）。两件事在一行里并列，用户必然会拿牌价乘 token 去验算，
 * 然后发现对不上费用 —— 这正是本缺陷的原始形态。
 *
 * 窄列（<80）省略「USD/百万」与「（高峰价；…）」里的重复口径：70 列放不下
 * 60+ 显示列的行，折行会把「输入/命中/输出」三个数拆散到两行，读者对不上号。
 */
function formatPriceLine(
  row: NonNullable<CostReport["byModel"][number]>,
  currency: string,
  narrow: boolean,
): string | null {
  const p = row.pricing;
  if (!p) return null;
  // cacheRead / cacheWrite 在定价表里是可缺省的（调用方按比例近似），显示时如实留空。
  const price = (n: number | undefined) => (n === undefined ? "—" : fmtUnitPrice(n));
  const unit = narrow ? "" : ` ${currency}/百万`;
  const nums = `输入 ${price(p.input)} / 命中 ${price(p.cacheRead)} / 输出 ${price(p.output)}`;
  const hasPeak = (p.peakWindows?.length ?? 0) > 0;
  const offPeak = p.offPeakMultiplier;
  if (!hasPeak) return `牌价${unit} ${nums}`;
  const tier = narrow ? "" : "高峰价；";
  const off = offPeak !== undefined && offPeak !== 1 ? `空闲 ×${offPeak}` : "空闲同价";
  return `牌价${unit} ${nums}（${tier}${off}）`;
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

/**
 * 命中率低于该值（百分比）视为偏低，触发提示。
 *
 * 阈值依据是 2026-11-10 对本机 `~/.sid-code/usage-ledger.jsonl` 的实测
 * （筛 provider=openai、单会话 promptTotal ≥ 20 万，太短的会话缓存还没热起来）：
 *
 * | 模型 | 会话数 | 加权命中 | p50 | p90 |
 * | --- | --- | --- | --- | --- |
 * | origin-deepseek-v4-1-flash | 473 | 91.4% | 89.6% | 96.2% |
 * | glm-5.2 | 157 | 85.5% | 81.0% | 93.3% |
 * | glm-5.3-uniapi | 51 | 83.8% | 79.8% | 91.3% |
 * | kimi-k3 | 7 | 81.9% | 80.0% | 85.6% |
 * | gpt-5.6-luna | 19 | 2.2% | 0.0% | 0.0% |
 *
 * openai 族的命中率按厂商/网关差别很大：主流渠道稳定在 80–95%，有的渠道几乎为 0。
 * 所以旧口径「openai 族结构性上限约 60–70%」不成立（那是早期某个模型的样本）。
 * 阈值取 50% 既能抓住「渠道不支持缓存」这类真问题，又不会误伤正常渠道。
 *
 * 刻意**不按模型名/协议族分档**（CLAUDE.md：禁按模型硬编码分级）：同一族里既有 91%
 * 的渠道也有 2% 的渠道，按族给「正常上限」只会让前者看到无意义提示、后者被放过。
 */
export const LOW_CACHE_HIT_RATE_THRESHOLD = 50;

/**
 * 少于这么多次请求时不提示。
 *
 * 会话刚开始时缓存还没热起来（前几次请求几乎必然低命中），此时提示「偏低」是噪音：
 * 取证会话里最贵的 3 次请求正是缓存没热起来的前 3 次。
 */
export const LOW_CACHE_HIT_RATE_MIN_REQUESTS = 5;

/**
 * 命中率偏低时的提示行；不偏低或样本太少时返回 null（整段省略，不给正常路径加噪音）。
 *
 * ## 为什么改成按实测值判断（D6）
 *
 * 旧实现是「会话里有 openai 族命中、且该族没有缓存写入 → 输出写死的一句
 * 『openai 协议为隐式缓存，60-70% 属正常上限』」，**完全不看实际数值**。
 * 取证会话（`~/.sid-code/trajectories/sessions/20261110-142303-21c3a481`）里
 * `/cost` 显示命中率 91.7%，下一行却写「60-70% 属正常上限」，自相矛盾。
 *
 * 现在只在实测值低于 {@link LOW_CACHE_HIT_RATE_THRESHOLD} 且请求数达到
 * {@link LOW_CACHE_HIT_RATE_MIN_REQUESTS} 时提示，且提示内容是可行动的动作
 * （`/cache --breaks` 能看本会话每次缓存中断的归因）。
 *
 * 判据只吃数值，不吃协议族 —— 调它的渲染层与命中率同源（都来自 CostReport.main），
 * 不用「当前模型 provider」拼条件，多协议会话里也不会漏提示。
 */
export function formatCacheHitHint(hitRatePercent: number, requests: number): string | null {
  if (requests < LOW_CACHE_HIT_RATE_MIN_REQUESTS) return null;
  if (hitRatePercent >= LOW_CACHE_HIT_RATE_THRESHOLD) return null;
  return `  ⚠ 缓存命中率偏低（低于 ${LOW_CACHE_HIT_RATE_THRESHOLD}%）：可能是前缀被改动或渠道不支持缓存，可运行 /cache --breaks 查看本会话的中断原因`;
}
