import { getBackgroundGateStats } from "@sid-code/core/agent/background-task-gate.ts";
import { normalizeCacheUsage } from "@sid-code/core/llm/types.ts";
// D4 的辅助调用 token 用会话维度 getSessionSideStats（与费用同口径）；
// D8 的辅助调用耗时用进程维度 getSideStats（resume 基线没有逐条耗时）。
import {
  getSessionSideStats,
  getSideStats,
  type SideCallSnapshot,
} from "@sid-code/core/trace/side-call-sink.ts";
import type { CommandContext, LocalCommandModule, LocalCommandResult } from "../../types.ts";

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
 * 辅助调用 token 段（D4）。无辅助调用时返回空数组，整段省略。
 *
 * ## 为什么必须单独成段，而不是并进主循环数字
 *
 * /cost 的「总费用」含辅助调用（`totalCostUSD + sideCostUSD`），但 token / 请求数 /
 * 缓存命中率 / 省钱全部来自 `modelUsage` —— `addSideCost` 刻意不写 `modelUsage`
 * （辅助调用的 prompt 不是当前上下文，混进去会污染 stock 口径的上下文大小，
 * 见 `session/state.ts` 的对应注释）。两种范围混在一个面板上，用户拿
 * 「费用 ÷ token」估单价必然偏高，「省钱 vs 费用」也是两个不同范围在比
 * （北极星铁律 3：分母口径必须和指标一起写死）。
 *
 * 修法**不是**把辅助调用并进 `modelUsage`，而是分两块显示、各自标明范围：
 * 主循环一块（`modelUsage`），辅助调用一块（本函数）。
 *
 * ## 数据源为什么取会话维度 `getSessionSideStats`
 *
 * `getSideStats()` 是**进程维度**：resume 会话里它只剩本次启动后的记录，而 /cost 的
 * 费用是**会话累计**（`sideCostUSD` 有快照回灌基线）。用进程维度会让 token 只含本次
 * 启动、费用含全会话 —— 正是 D4 要消除的那种「分子分母范围不同」。
 * `getSessionSideStats()` = 回灌基线 + 本进程记录，与费用同口径。
 */
export function formatSideCallTokenSection(side: SideCallSnapshot): string[] {
  if (side.apiCalls <= 0) return [];
  return [
    "",
    `辅助调用 Token 用量（${side.apiCalls} 次调用；不计入上面的主循环数字）:`,
    // 千分位与主循环段（#763 的 fmtNum）一致：同一面板两套数字长相会让人以为口径不同。
    `  输入: ${fmtNum(side.tokensSent)}`,
    `  输出: ${fmtNum(side.tokensReceived)}`,
  ];
}

/** /cost 命令 */
export class CostCommand implements LocalCommandModule {
  /**
   * 后台闸门读取函数**可注入**：闸门是进程级单例，`bun test` 同批多文件跑在同一进程里，
   * 测试若去占用/重置它会和 `packages/core/tests/agent/background-task-gate.test.ts`
   * 互相干扰（两个文件并发跑时，一边的 drain 会清掉另一边的待补队列）。
   * 生产路径用默认值读真实闸门，测试传假状态即可覆盖「进行中 / 排队 / 空闲」三个分支。
   *
   * 辅助调用统计同理可注入（第二个参数）：`side-call-sink` 也是进程级单例，
   * 测试直接 recordSideCall 会让别的测试文件的 /cost 输出凭空多出辅助段。
   */
  constructor(
    private readonly readGateStats: () => PendingTasksView = () => getBackgroundGateStats(),
    private readonly readSideStats: () => SideCallSnapshot = () => getSessionSideStats(),
  ) {}

  async call(_args: string, ctx: CommandContext): Promise<LocalCommandResult> {
    const { SessionState } = await import("@sid-code/core/session/state.ts");
    const ss = ctx.sessionState;
    // D5：token 段必须走归一化后的**互斥三段**（normalizeCacheUsage 的单一事实源），
    // 不能直接贴 provider 原始的 `getTotalUsage().inputTokens` —— 同一个「输入」字段两族含义相反：
    //   - openai 族：prompt_tokens **含**命中部分，与「缓存读取」并列会被读成「两者相加才是总量」；
    //   - anthropic 族：input_tokens 是未命中余量，与缓存读/写互斥。
    // 拆成 未命中 / 命中 / 写入 + 合计后两族语义一致，也和计价公式（calculateCost）一一对应。
    const cacheView = ss.getNormalizedCacheUsage();

    // D7：`≈` 表示「金额由非 USD 币种按固定汇率折算成 USD」（估算值），判据看价格数据本身
    // （SessionState.isCostFxConverted），不看模型名。同一笔钱在 Footer / /cost / /debug
    // 三处必须同一写法，否则用户会误以为三处口径不同。
    const fxConverted = ss.isCostFxConverted();
    const cur = fxConverted ? "≈$" : "$";

    const lines = [
      `会话时长: ${SessionState.formatDuration(ss.getElapsedMs())}`,
      // D4：总费用是面板上**唯一含辅助调用**的指标，标签必须写出来。
      // 其余指标（token / 请求数 / 缓存命中率 / 省钱 / API 耗时）都只来自主循环
      // （`modelUsage` / `totalAPIDuration`），两段各自标明范围，用户才不会拿
      // 「含辅助的费用 ÷ 不含辅助的 token」去估单价、或拿两个范围的数直接相比。
      `总费用: ${cur}${ss.getEffectiveTotalCostUSD().toFixed(4)}（含辅助调用）`,
      ...(ss.sideCostUSD > 0
        ? [`  其中辅助调用: ${cur}${ss.sideCostUSD.toFixed(4)}（标题/记忆/分类/摘要等）`]
        : []),
    ];

    // D2：费用几乎都是辅助调用在涨，所以提示紧跟在费用行之后。
    // 无头模式（`/cost` 是 headless: true）也照样输出：脚本拿到的是同一份文本，
    // 多一行提示不影响解析，反而能解释「为什么和上一次跑的数字不一样」。
    const pendingNotice = formatPendingTasksNotice(this.readGateStats());
    if (pendingNotice) lines.push(pendingNotice);

    // D8：耗时三条线各自的范围必须写在标签里，否则用户会拿它们相加去对墙钟。
    // - 「API 耗时」只含**主循环**请求（totalAPIDuration 只在 query/loop 的 updateUsage 累加）；
    // - 辅助调用（fork / 标题生成 / 记忆召回等）的耗时单独一行，数据来自计费事件；
    // - 「会话时长」是墙钟，含思考 / 空闲 / 等待，不等于上面任何两项之和。
    //
    // 辅助调用耗时用 getSideStats()（**进程维度**）：resume 回灌的基线只有汇总，
    // 没有逐条耗时，所以这个数天然只覆盖「本次启动后」。文案里写明，
    // 避免用户拿它和会话维度的 sideCostUSD 硬对。
    const sideStats = getSideStats();
    const sideDurationLine = (() => {
      if (sideStats.apiCalls === 0) return null; // 没有辅助调用：整行省略
      if (sideStats.durationCalls === 0) {
        // 有调用但一次耗时都没采集到：写「—」，**不要写 0**。
        // 写 0 会让用户以为辅助调用没花时间，而实际可能是计费通道没接计时。
        return `辅助调用耗时: —（本次启动后 ${sideStats.apiCalls} 次调用均未采集耗时）`;
      }
      const base = `辅助调用耗时: ${SessionState.formatDuration(sideStats.durationMs)}`;
      return sideStats.durationCalls < sideStats.apiCalls
        ? `${base}（本次启动后 ${sideStats.durationCalls}/${sideStats.apiCalls} 次采集到耗时，其余未采集）`
        : `${base}（本次启动后 ${sideStats.durationCalls} 次调用）`;
    })();

    lines.push(
      // D8（main）把「API 耗时」标注成主循环并单独给出辅助调用耗时行；
      // D4 的范围要求被这一版完整覆盖（「（主循环）」= 「仅主循环」）。
      `API 耗时（主循环）: ${SessionState.formatDuration(ss.totalAPIDuration)}`,
      ...(sideDurationLine ? [sideDurationLine] : []),
      `工具耗时: ${SessionState.formatDuration(ss.totalToolDuration)}`,
      "  （会话时长是墙钟：含思考与空闲；API 耗时只算主循环请求，子代理与辅助调用不含在内）",
      "",
      // D4：以下 token / 请求数 / 缓存 / 省钱全部来自 `modelUsage`（辅助调用刻意不进），
      // 标题必须标明范围，否则用户会拿它们和「含辅助调用」的总费用相除/相比。
      // 「含子代理」也要写：子代理经 usage-sink 走同一个 updateUsage，本来就在这段数字里，
      // 不写会被读成「不含子代理」而低估。标题不写「累计」：下面 flow 与 stock 两行并列，
      // 写「累计」会和 stock 行自相矛盾（D3 与 D4 合并时踩到的点）。
      "主循环 Token 用量（不含辅助调用；含子代理）:",
      `  请求: ${ss.getTotalRequests()} 次`,
      // D5（main）：三段互斥。未命中 + 命中 + 写入 = 合计，命中/写入为 0 时整行省略
      // （与旧「缓存创建/读取只在非 0 时显示」一致，0 不参与加法，用户照样能验算）。
      `  输入·未命中: ${fmtNum(cacheView.uncachedInputTokens)}`,
      ...(cacheView.cacheHitTokens > 0
        ? [`  输入·缓存命中: ${fmtNum(cacheView.cacheHitTokens)}`]
        : []),
      ...(cacheView.cacheWriteTokens > 0
        ? [`  输入·缓存写入: ${fmtNum(cacheView.cacheWriteTokens)}`]
        : []),
      // D3：合计行是 **flow（累计发送）** 口径 —— 每次请求的 prompt 都计入；
      // 用的是归一化后的 promptTotal（三段之和）而不是 provider 原始 inputTokens：
      // 后者对 anthropic 族只是未命中余量，会让三段加法对不上（D5）。
      // D5 的千分位在这里也必须生效，否则同一面板两套数字长相。
      `  输入·合计（累计发送，flow）: ${fmtNum(cacheView.promptTotal)}  ← 全会话累加，每次请求的 prompt 都计入`,
      // D3：stock 与 flow 是两个口径，同一次会话里必然不等，不标清楚用户会以为其中一个是错的。
      `  当前上下文（stock）: ${fmtNum(ss.getStockPromptTokens())}  ← 最后一次请求的完整 prompt；状态栏 ↑ 显示的就是它`,
      `  输出（累计）: ${fmtNum(cacheView.outputTokens)}`,
    );

    // 模块 B：本会话缓存命中率 + 省钱（经归一化单一事实源）
    if (cacheView.cacheHitTokens > 0 && cacheView.promptTotal > 0) {
      const rate = ((cacheView.cacheHitTokens / cacheView.promptTotal) * 100).toFixed(1);
      const savings = ss.getTotalCacheSavings();
      // D4：命中率与省钱都只遍历 `modelUsage`（`getNormalizedCacheUsage` /
      // `getTotalCacheSavings`），不含辅助调用。标注范围，否则用户会拿它和含辅助调用的
      // 总费用相比；辅助调用本身也没有缓存省钱数据可算。
      lines.push(
        "",
        `缓存命中率: ${rate}%   省钱: ${cur}${savings.toFixed(4)}（仅主循环，不含辅助调用）`,
      );
      // P2-2：openai 协议路径为服务端隐式缓存（无客户端主动写入 cache_control，
      // cacheCreation 恒 0），命中率结构性上限约 60-70%，不同于 anthropic 族显式缓存的 90%+。
      // 对该族标注正常上限，避免用户把 60-70% 误判为 harness bug。以协议路径为准，非按模型名单。
      //
      // 判据必须与命中率同源：上面的命中率是全会话跨模型聚合（getNormalizedCacheUsage 遍历
      // modelUsage），所以这里也遍历 modelUsage，按每条记账时的 provider 判断。
      // 不能用 ctx.config.provider（当前模型）+ 全会话 cacheCreation：先 anthropic 后 /model 切
      // openai、或主模型 openai + anthropic 子代理时，anthropic 那部分的写入量会让条件恒假，
      // 提示要防的「60-70% 误判成 bug」恰好在多协议会话里重新暴露。
      // 写入量也只看 openai 族自己的那几条：该族恒 0（见 llm/openai-usage.ts），
      // 非 0 说明走了显式缓存，结构性上限的解释不再适用。
      const usageList = Object.values(ss.modelUsage);
      const implicitCacheUsage = usageList.filter(
        (s) => s.provider === "openai" && s.cacheReadInputTokens > 0,
      );
      const hasImplicitOnly =
        implicitCacheUsage.length > 0 &&
        implicitCacheUsage.every((s) => s.cacheCreationInputTokens === 0);
      if (hasImplicitOnly) {
        // 混了别的协议族时，整体命中率是两族加权的结果，不能直接拿 60-70% 去套
        const mixed = usageList.some((s) => s.provider !== "openai" && s.cacheReadInputTokens > 0);
        lines.push(
          mixed
            ? "  （本会话混用多个协议族：openai 协议部分为隐式缓存，60-70% 属正常上限；上面的命中率是各族加权结果，不能直接套单一族的标准）"
            : "  （openai 协议为隐式缓存，60-70% 属正常上限；90%+ 需 anthropic 族显式缓存）",
        );
      }
    }

    const models = Object.entries(ss.modelUsage);
    if (models.length > 1) {
      // D4：标题里的「主循环」明确指向不含辅助调用的那一段；#763 的「输入·合计」
      // 是同一段的 flow 合计行，两者说的是同一份 modelUsage。
      lines.push("", "按模型统计（累计发送口径，与上方主循环的「输入·合计」一致）:");
      for (const [model, stats] of models) {
        // ⚠️ 用归一化后的 promptTotal（由 cumulativePromptTokens 派生），不用 stock 的
        // `stats.inputTokens`：末次值只保留最后一次请求的 prompt 长度，分模型之和会远小于汇总，
        // 用户会看到"汇总远大于分模型之和"的诡异对不上。
        // 也不能直接贴 cumulativePromptTokens：anthropic 族的它是未命中余量，openai 族含命中，
        // 两族混用时分模型之和会对不上汇总「输入·合计」，所以逐模型过一遍 normalizeCacheUsage。
        const promptTotal = normalizeCacheUsage(
          {
            inputTokens: stats.cumulativePromptTokens,
            outputTokens: stats.outputTokens,
            cacheReadInputTokens: stats.cacheReadInputTokens,
            cacheCreationInputTokens: stats.cacheCreationInputTokens,
          },
          stats.provider,
        ).promptTotal;
        lines.push(
          `  ${model}: ${stats.requests} 次请求, ${cur}${stats.costUSD.toFixed(4)}, input=${fmtNum(promptTotal)}, output=${fmtNum(stats.outputTokens)}`,
        );
      }
    }

    // D4：辅助调用 token 单独成段。费用（总费用 / 其中辅助调用）与 token 的范围不同，
    // 分两块显示并各自标明范围，用户才能正确算单价、正确比较「省钱 vs 费用」。
    // 放在按模型统计之后：上面所有块都是主循环（modelUsage）口径，这里开始是辅助调用口径。
    lines.push(...formatSideCallTokenSection(this.readSideStats()));

    // D7：金额带 `≈` 时给出换算依据，让用户能自己验算「这个数怎么来的」。
    // 汇率取入账时的原始 fxToUSD（1/fx = 每 1 USD 折多少本币），不写死 7.1：
    // 用户配置或网关价可能用别的汇率，写死会和实际计价的汇率不一致。
    if (fxConverted) {
      const conv = ss.getCurrencyConversions();
      if (conv.length > 0) {
        const desc = conv
          .map((c) => `1 USD = ${Number(c.perUSD.toFixed(4))} ${c.currency}`)
          .join("，");
        lines.push("", `币种换算: ${desc}（固定汇率；≈ 表示按此折算的估算值）`);
      }
    }

    return { type: "text", value: lines.join("\n") };
  }
}

/**
 * 数字千分位格式化（与 /debug、/stats 面板同款写法）。
 *
 * D5：/cost 的 token 数曾裸输出（`2398645`），/debug 却是 `2,398,645`，同一份数据两个长相。
 * 显式指定 `en-US` 而不是用运行时默认 locale：/cost 输出会被脚本 grep，逗号位置必须稳定。
 */
function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}
