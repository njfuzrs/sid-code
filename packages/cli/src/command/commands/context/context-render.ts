/**
 * /context 的排版层（PR3）：`ContextReport → string`。
 *
 * ## 与取数层的分工
 *
 * 所有百分比、差额、剩余量都在 core 的 `buildContextReport`（context-report.ts）里算完；
 * 本文件只做分区、对齐、千分位、颜色、窄列自适应。**这里不许再算任何指标** ——
 * 排版层重算指标正是 D9（`/stats` 用 stock÷flow 算出 4% 命中率）的根因，
 * 与 `/cost` 的 `cost-render.ts` 同一条纪律。
 *
 * ## 形态：命令输出面板
 *
 * `/context` 是查看类命令，按 `src/ui/CLAUDE.md` 的 L4-H 标 `outputPanel`，
 * 不再写专属 Dialog。面板的上下横线与滚动由 `CommandOutputDialog` 负责，
 * 所以这里**不画任何边框、不留前导缩进**（L2.2：用户会复制的区域不画左右竖线）。
 *
 * ## 版式规范依据
 *
 * L1/L2：颜色走 theme 语义 token 且只点睛、数字千分位、标签对齐成列（宽度用 `stringWidth`，
 * 中文占 2 列）、进度条用 `figures.ts` 的 `PROGRESS_FILLED`/`PROGRESS_EMPTY`、
 * 说明文字放注释区不挤正文、不使用 emoji。
 *
 * ## 无头 / 管道输出必须无 ANSI
 *
 * `/context` 是 `headless: true` 的命令：`-p` 与管道输出走同一条路径，
 * 转义码会污染脚本解析。判据由调用方传 `color: false`（`process.stdout.isTTY !== true`）。
 */

import { stringWidth, applyColor } from "../../../ui/render-port/text.ts";
import { PROGRESS_FILLED, PROGRESS_EMPTY, TREE_BRANCH } from "../../../ui/constants/figures.ts";
import { themeManager } from "../../../ui/themes/theme-manager.ts";
import type { Color } from "@sid-code/shared/types/color.ts";
import type {
  ContextReport,
  ContextReportCategory,
  ContextReportThreshold,
} from "@sid-code/core/context/context-report.ts";

/** 渲染选项。`color=false`（非 TTY / 测试）时全部着色函数退化为原样返回。 */
export interface RenderContextReportOptions {
  /** 终端列数。窄列（<80，与 /perf 的 NARROW_WIDTH 同值）去掉「还剩」列与进度条百分比。 */
  width: number;
  color: boolean;
  /**
   * D-07：本会话「接收确认开场白」计数（collector 自持，`getAckOpenerStats()`）。
   *
   * 为什么走**选项**而不是 `ContextReport` 字段：`/context` 的取数层是
   * `buildContextReport(ctxMgr, …)`，它的唯一数据源是 ContextManager + 会话快照，
   * 拿不到 collector；而这个数也不是「上下文用量」的一部分（它不改任何 token 账）。
   * 塞进 report 会让「取数层只读 ctxMgr」的契约破掉。未注入（headless 测试 / 轨迹采集关闭）
   * 时整节不画 —— 缺失 ≠ 0 个开场白。
   */
  ackOpener?: { turns: number; totalTurns: number };
}

/**
 * D-07：开场白行的措辞（渲染层只做格式化，比例在 {@link renderContextReport} 里按
 * 分子÷分母算一次 —— 这不属于「重算指标」：两个都是 collector 直接给的原始计数，
 * 除法是显示所必需，与 `percentOfUsed` 那种取数层口径不是一回事）。
 */
function renderAckOpenerRow(
  ack: { turns: number; totalTurns: number },
  p: ReturnType<typeof createPainter>,
): string {
  const ratio = ack.totalTurns > 0 ? `${Math.round((ack.turns / ack.totalTurns) * 100)}%` : "—";
  return (
    `  ${p.secondary(padEndWidth("接收确认开场白", 16))}  ` +
    `${padStartWidth(`${fmtInt(ack.turns)}/${fmtInt(ack.totalTurns)}`, 9)}` +
    `  ${padStartWidth(ratio, 5)}`
  );
}

/** 窄列阈值，与 `/perf` 的 `NARROW_WIDTH` 同一个值。 */
const NARROW_WIDTH = 80;

/** 千分位（en-US 分组）。不用 toLocaleString：ICU 差异会让测试在不同环境飘。 */
export function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 紧凑 token 写法（「还剩 ~654k」用）：≥1000 折成 k，≥1M 折成 M。 */
export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** 带符号的差额：`+9,800` / `−4,100` / `0`。负号用 U+2212（与正号的视觉宽度一致）。 */
export function fmtSigned(n: number): string {
  const v = Math.round(n);
  if (v === 0) return "0";
  return v > 0 ? `+${fmtInt(v)}` : `−${fmtInt(-v)}`;
}

/** 档位 → 人话。`none` 是「正常」，其余直接说在做什么。 */
export function levelLabel(level: ContextReport["level"]): string {
  switch (level) {
    case "none":
      return "正常";
    case "soft":
      return "遮罩中";
    case "hard":
      return "摘要中";
    case "emergency":
      return "紧急";
  }
}

/** 按显示宽度右对齐（`stringWidth`：中文标签占 2 列，不能拿 `.length` 充数——L2.3）。 */
function padStartWidth(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : " ".repeat(width - w) + s;
}

/** 按显示宽度左对齐。 */
function padEndWidth(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** 取一列所有字符串的最大显示宽度（列宽自适应，不写死 12/16 这类魔数）。 */
function maxWidth(strings: readonly string[]): number {
  return strings.reduce((m, s) => Math.max(m, stringWidth(s)), 0);
}

/**
 * 按显示宽度折行（中文按字折，ASCII 不拆词只保证不超宽）。
 *
 * 为什么需要它：面板里有几条长说明（底部口径说明、本地释放明细、固定开销 detail），
 * 宽列下一条就 100+ 列，窄列（60/80）下会顶出终端——输出面板不会替我们折行，
 * 顶出去的部分直接看不见（L2.3：宽度用 `stringWidth`，不是 `.length`）。
 */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (cur !== "" && curW + w > width) {
      out.push(cur);
      cur = "";
      curW = 0;
    }
    cur += ch;
    curW += w;
  }
  out.push(cur);
  return out;
}

function createPainter(useColor: boolean) {
  const sc = useColor
    ? themeManager.getSemanticColors()
    : {
        text: { primary: "", secondary: "" },
        ui: { active: "" },
        status: { warning: "", success: "", error: "" },
      };
  // 与 cost-render 同一个收窄手法：三元里的无色 fallback 会把静态类型拉宽成 string，
  // 在这一个点收窄成 Color，比给 fallback 编造类型标注干净。
  const wrap = (s: string, color: string) =>
    useColor && color ? applyColor(s, color as Color) : s;
  return {
    primary: (s: string) => wrap(s, sc.text.primary),
    secondary: (s: string) => wrap(s, sc.text.secondary),
    accent: (s: string) => wrap(s, sc.ui.active),
    warn: (s: string) => wrap(s, sc.status.warning),
    danger: (s: string) => wrap(s, sc.status.error),
    /** 首行标题与「已用」数字的强调档：颜色 + 粗体（L1「克制点睛」，只给两处用）。 */
    hero: (s: string) => (useColor ? `\x1b[1m${wrap(s, sc.text.primary)}\x1b[22m` : s),
  };
}

/**
 * 进度条单色：已用部分跟档位变色（与 footer 的 `deriveContextColor` 同源语义），
 * 剩余部分用 PROGRESS_EMPTY。构成交给下面的表格表达，**不给分类配色**
 * （旧面板 10 个分类撞成 3 种颜色，既区分不了又违反「克制点睛」）。
 */
function progressBar(
  ratio: number,
  barWidth: number,
  level: ContextReport["level"],
  p: ReturnType<typeof createPainter>,
): string {
  const filled = Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
  const filledGlyphs = PROGRESS_FILLED.repeat(filled);
  const emptyGlyphs = PROGRESS_EMPTY.repeat(barWidth - filled);
  const colored =
    level === "emergency"
      ? p.danger(filledGlyphs)
      : level === "soft" || level === "hard"
        ? p.warn(filledGlyphs)
        : p.primary(filledGlyphs);
  return colored + p.secondary(emptyGlyphs);
}

/**
 * 分类行：标签缩进两格、数字右对齐、百分比右对齐。
 *
 * 「占已用」的分母统一是「已用」，各分类之和 = 小计 ÷ 已用，**不一定 100%**：
 * 差额正好是「实测校正」与「本地已释放」两行，所以小计行显示真实百分比、
 * 底部再给一行小字解释，避免用户以为数字算错。
 */
function renderCategoryRow(
  c: ContextReportCategory,
  labelWidth: number,
  tokenWidth: number,
  p: ReturnType<typeof createPainter>,
): string {
  return (
    `    ${p.secondary(padEndWidth(c.label, labelWidth))}` +
    `  ${padStartWidth(fmtInt(c.tokens), tokenWidth)}` +
    `  ${padStartWidth(`${c.percentOfUsed}%`, 5)}`
  );
}

/** 阈值行：名称 + 档位 + 触发点（+ 窄列时省略「还剩」）。 */
function renderThresholdRow(
  t: ContextReportThreshold,
  nameWidth: number,
  levelWidth: number,
  atWidth: number,
  narrow: boolean,
  p: ReturnType<typeof createPainter>,
): string {
  const name = padEndWidth(t.label, nameWidth);
  const level = padEndWidth(t.level, levelWidth);
  const at = padStartWidth(fmtInt(t.at), atWidth);
  const levelColored =
    t.level === "emergency"
      ? p.danger(level)
      : t.level === "soft" || t.level === "hard"
        ? p.warn(level)
        : p.secondary(level);
  const head = `  ${p.primary(name)}  ${levelColored}  ${at}`;
  if (narrow) return head;
  // blocking 是「剩余极少时直接强制截断、不调 LLM」的最后防线，
  // 把它显示成「还剩 ~3k」会让用户以为还有缓冲可烧；说清它是什么。
  if (t.key === "blocking") {
    return `${head}  ${p.secondary("（不调用模型，最后防线）")}`;
  }
  return `${head}  ${p.secondary(`~${fmtCompact(t.remaining)}`)}`;
}

/**
 * 渲染主入口。纯函数：同一份 report + 同一份选项，输出逐字节确定。
 *
 * 分节顺序（与文档 §5.2 一致）：标题 → 结论 → 进度条 → 构成 → 对账 → 压缩阈值 → 固定开销 → 提示。
 */
export function renderContextReport(r: ContextReport, opts: RenderContextReportOptions): string {
  const p = createPainter(opts.color);
  const width = Math.max(20, opts.width || 80);
  const narrow = width < NARROW_WIDTH;
  const lines: string[] = [];

  /** 文本折行推入：首行带 prefix，续行按 prefix 的显示宽度对齐。`paint` 默认 secondary。 */
  const pushWrapped = (
    prefix: string,
    text: string,
    paint: (s: string) => string = p.secondary,
  ) => {
    const pad = stringWidth(prefix);
    const chunks = wrapText(text, Math.max(1, width - pad));
    lines.push(prefix + paint(chunks[0]!));
    for (let i = 1; i < chunks.length; i++) {
      lines.push(" ".repeat(pad) + paint(chunks[i]!));
    }
  };

  /**
   * 表格行的「值 + 说明」：同行放得下就同行，放不下就把说明折到下一行并折行。
   *
   * `headWidth` 必须由调用方传**纯文本**宽度：`head` 已着色，含 ANSI 时
   * `stringWidth` 会把转义码也算进宽度（那正是 L2.3 要防的「用错宽度口径」）。
   */
  const pushRowWithDetail = (head: string, headWidth: number, detail: string) => {
    const gap = 2;
    if (headWidth + gap + stringWidth(detail) <= width) {
      lines.push(`${head}${" ".repeat(gap)}${p.secondary(detail)}`);
      return;
    }
    lines.push(head);
    for (const chunk of wrapText(detail, Math.max(1, width - 4))) {
      lines.push(`    ${p.secondary(chunk)}`);
    }
  };

  // ── 标题：模型名与窗口。窄列去掉模型名（长网关名会把首行顶过 70 列）──
  const titleParts = ["上下文用量"];
  if (!narrow && r.model) titleParts.push(r.model);
  titleParts.push(`窗口 ${fmtInt(r.maxTokens)}`);
  lines.push(p.accent(titleParts.join(" · ")));
  lines.push("");

  // ── 结论：先给一句可以直接行动的话（与 /perf 同款）──
  const toTriggerNote =
    r.toTrigger > 0 ? `，距压缩触发还有 ~${fmtCompact(r.toTrigger)}` : "，已达压缩触发点";
  lines.push(
    `${p.secondary("结论")}  ${p.primary(`已用 ${fmtInt(r.used)}`)}` +
      `${p.secondary(`（${r.percentOfWindow}%）${toTriggerNote}；档位：${levelLabel(r.level)}`)}`,
  );
  if (r.largestVariable.length > 0) {
    const [first, ...rest] = r.largestVariable;
    const tail =
      rest.length > 0
        ? `，其次是${rest.map((v) => `${v.label}（${v.percentOfUsed}%）`).join("和")}`
        : "";
    pushWrapped("      ", `最大的可变成分是${first.label}（${first.percentOfUsed}%）${tail}`);
  }
  lines.push("");

  // ── 进度条：已用 / 触发点百分比 ──
  const barWidth = Math.max(10, Math.min(40, width - (narrow ? 4 : 20)));
  const ratio = r.maxTokens > 0 ? r.used / r.maxTokens : 0;
  const bar = progressBar(ratio, barWidth, r.level, p);
  const barTail = narrow
    ? ""
    : `   ${p.secondary(`${r.percentOfWindow}% / ${r.triggerPercentOfWindow}%`)}`;
  lines.push(bar + barTail);

  // ── 构成 ──
  lines.push("");
  const calibNote = r.calibrated
    ? `启发式 × 校准系数 ${r.calibrationFactor.toFixed(2)}`
    : "启发式（未校准）";
  const tokenHeader = "token";
  const shareHeader = "占已用";
  const labelWidth = maxWidth(r.categories.map((c) => c.label));
  const tokenWidth = Math.max(maxWidth([tokenHeader, fmtInt(r.used)]), 5);
  const headerGap = "  ";
  lines.push(
    `${p.accent("构成")}${p.secondary(`（${calibNote}）`)}` +
      `${headerGap}${p.secondary(padStartWidth(tokenHeader, tokenWidth))}` +
      `  ${p.secondary(padStartWidth(shareHeader, 5))}`,
  );

  const resident = r.categories.filter((c) => c.group === "resident");
  const conversation = r.categories.filter((c) => c.group === "conversation");
  if (resident.length > 0) {
    lines.push(`  ${p.secondary("常驻（每轮都带）")}`);
    for (const c of resident) lines.push(renderCategoryRow(c, labelWidth, tokenWidth, p));
  }
  if (conversation.length > 0) {
    lines.push(`  ${p.secondary("会话")}`);
    for (const c of conversation) lines.push(renderCategoryRow(c, labelWidth, tokenWidth, p));
  }

  // 小计 → 实测校正 → 本地已释放 → 已用（四行是同一本账的三步修正）
  lines.push(
    `  ${p.secondary(padEndWidth("小计", labelWidth))}  ${padStartWidth(fmtInt(r.subtotal), tokenWidth)}` +
      `  ${padStartWidth(`${r.subtotalPercentOfUsed}%`, 5)}`,
  );
  const anchorHeadPlain = `  ${padEndWidth("实测校正", labelWidth)}  ${padStartWidth(
    fmtSigned(r.anchorLiftTokens),
    tokenWidth,
  )}`;
  pushRowWithDetail(
    `  ${p.secondary(padEndWidth("实测校正", labelWidth))}  ${padStartWidth(fmtSigned(r.anchorLiftTokens), tokenWidth)}`,
    stringWidth(anchorHeadPlain),
    "锚定到末次真实输入",
  );
  const freedDetail =
    r.freed.byStrategy.length > 0
      ? `${r.freed.byStrategy.map((s) => `${s.label} ${s.count} 项`).join("、")}（不再发送）`
      : "（不再发送）";
  const freedHeadPlain = `  ${padEndWidth("本地已释放", labelWidth)}  ${padStartWidth(
    fmtSigned(-r.freed.tokens),
    tokenWidth,
  )}`;
  pushRowWithDetail(
    `  ${p.secondary(padEndWidth("本地已释放", labelWidth))}  ${padStartWidth(fmtSigned(-r.freed.tokens), tokenWidth)}`,
    stringWidth(freedHeadPlain),
    freedDetail,
  );
  lines.push(
    `  ${p.primary(padEndWidth("已用（= 状态栏）", labelWidth))}  ${p.primary(padStartWidth(fmtInt(r.used), tokenWidth))}`,
  );

  // ── 对账（B8）──
  lines.push("");
  lines.push(p.accent("对账"));
  const reconLabelWidth = maxWidth(["末次请求的真实输入", "下一次请求的预测", "差额"]);
  const reconTokenWidth = Math.max(
    maxWidth([fmtInt(r.lastActualPromptTokens), fmtInt(r.used), fmtSigned(r.delta)]),
    5,
  );
  if (r.lastActualPromptTokens > 0) {
    lines.push(
      `  ${p.secondary(padEndWidth("末次请求的真实输入", reconLabelWidth))}  ${padStartWidth(fmtInt(r.lastActualPromptTokens), reconTokenWidth)}` +
        `  ${p.secondary("状态栏 ↑")}`,
    );
  } else {
    // 会话还没发过请求：没有实测可对账。如实说，不拿 0 冒充「实测值是 0」。
    lines.push(
      `  ${p.secondary(padEndWidth("末次请求的真实输入", reconLabelWidth))}  ${p.secondary("—  尚无实测（本会话还没发过请求）")}`,
    );
  }
  lines.push(
    `  ${p.secondary(padEndWidth("下一次请求的预测", reconLabelWidth))}  ${padStartWidth(fmtInt(r.used), reconTokenWidth)}` +
      `  ${p.secondary(`状态栏 ${r.percentOfWindow}%`)}`,
  );
  if (r.lastActualPromptTokens > 0) {
    lines.push(
      `  ${p.secondary(padEndWidth("差额", reconLabelWidth))}  ${padStartWidth(fmtSigned(r.delta), reconTokenWidth)}` +
        // 取数说明：`used` 是发送量口径（扣本地释放），`lastActualPromptTokens` 是
        // SessionState 的 stock（末次真实 prompt，压缩后仍保留压缩前旧值）。
        // 两者是两个独立状态机，所以差额里会混入「压缩/清理造成的下降」，
        // 不能标成「本轮新增 − 本地释放」——那样用户会算出对不上的数。
        `  ${p.secondary("含压缩/清理下降，非单轮增量")}`,
    );
  }

  // ── 压缩阈值（B7）：四档 + 完成预留拆分 ──
  lines.push("");
  lines.push(p.accent("压缩阈值（按已用量）"));
  const thrNameWidth = maxWidth(r.thresholds.map((t) => t.label));
  const thrLevelWidth = maxWidth(r.thresholds.map((t) => t.level));
  const thrAtWidth = Math.max(maxWidth(r.thresholds.map((t) => fmtInt(t.at))), 5);
  for (const t of r.thresholds) {
    lines.push(renderThresholdRow(t, thrNameWidth, thrLevelWidth, thrAtWidth, narrow, p));
  }
  if (r.completionBuffer > 0) {
    pushWrapped(
      "  ",
      `完成预留 ${fmtInt(r.completionBuffer)} = 回复输出 ${fmtInt(r.outputReserve)} + 一次摘要 ${fmtInt(r.summaryReserve)}`,
    );
  }

  // ── 固定开销来源（A4）：细目 + 残差，加总严格等于母项 ──
  const sources = r.fixedOverhead.sources;
  // 取数层允许残差为负（`Σ sources + residual === 母项` 严格成立，见 fixed-overhead.ts），
  // 但负数在面板上没有可行动含义：这里按显示口径钳 0，且只在 >0 时画「规则正文与其它」。
  const residual = Math.max(0, r.fixedOverhead.residual);
  if (sources.length > 0 || residual > 0) {
    lines.push("");
    lines.push(p.accent("固定开销来源") + p.secondary("（「记忆/CLAUDE.md」的细目）"));
    const srcLabelWidth = maxWidth([...sources.map((s) => s.label), "规则正文与其它"]);
    const srcTokenWidth = Math.max(
      maxWidth([...sources.map((s) => fmtInt(s.tokens)), fmtInt(residual)]),
      5,
    );
    for (const s of sources) {
      const headPlain = `  ${TREE_BRANCH} ${padEndWidth(s.label, srcLabelWidth)}  ${padStartWidth(fmtInt(s.tokens), srcTokenWidth)}`;
      pushRowWithDetail(
        `  ${p.secondary(TREE_BRANCH)} ${padEndWidth(s.label, srcLabelWidth)}` +
          `  ${padStartWidth(fmtInt(s.tokens), srcTokenWidth)}`,
        stringWidth(headPlain),
        s.detail ?? "",
      );
    }
    // A4 残差行：母项减已列细目之和。不列它，用户把细目加总会小于母项，
    // 只能怀疑哪个数字算错了。
    if (residual > 0) {
      const headPlain = `  ${TREE_BRANCH} ${padEndWidth("规则正文与其它", srcLabelWidth)}  ${padStartWidth(fmtInt(residual), srcTokenWidth)}`;
      pushRowWithDetail(
        `  ${p.secondary(TREE_BRANCH)} ${padEndWidth("规则正文与其它", srcLabelWidth)}` +
          `  ${padStartWidth(fmtInt(residual), srcTokenWidth)}`,
        stringWidth(headPlain),
        "CLAUDE.md 正文、召回记忆、会话记忆",
      );
    }
  }

  // ── 回答规范（D-07）：只展示，不给提示 ──
  //
  // 不进「提示」区：提示区是「你能做点什么」的可行动项，而这一行是**行为观测**——
  // 系统提示词 #8 要求每轮都不写接收确认开场白，用户改不了它，只能看它退没退步。
  // 不画进度条：这类计数不是容量指标，条形图会让人误以为它有阈值。
  if (opts.ackOpener && opts.ackOpener.totalTurns > 0) {
    lines.push("");
    lines.push(
      p.accent("回答规范") +
        p.secondary("（#8 不写接收确认开场白 · 本轮首条文本判定 · 只度量不干预）"),
    );
    lines.push(renderAckOpenerRow(opts.ackOpener, p));
  }

  // ── 提示（最多 3 条，每条都能指到一个字段与一个阈值）──
  // 截断兜底放在渲染层：report 层已限制 3 条，但渲染层是「任何 report 都画得下」的最后一道
  // ——面板高度有限，第 4 条以后用户永远读不到，画出来只是噪音。
  const hints = r.hints.slice(0, 3);
  if (hints.length > 0) {
    lines.push("");
    for (const h of hints) pushWrapped("提示  ", h, p.warn);
  }

  // ── 底部小字：「占已用」列的和不是 100% 不是算错 ──
  lines.push("");
  pushWrapped(
    "",
    "说明：分类是校准后、扣减前的值，「占已用」之和 = 小计 ÷ 已用；" +
      "与 100% 的差额正是「实测校正」与「本地已释放」两行。",
  );

  return lines.join("\n");
}
