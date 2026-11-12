import { getBackgroundGateStats } from "@sid-code/core/agent/background-task-gate.ts";
import { normalizeCacheUsage } from "@sid-code/core/llm/types.ts";
import { getSideStats } from "@sid-code/core/trace/side-call-sink.ts";
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
 */
export function formatCacheHitHint(hitRatePercent: number, requests: number): string | null {
  if (requests < LOW_CACHE_HIT_RATE_MIN_REQUESTS) return null;
  if (hitRatePercent >= LOW_CACHE_HIT_RATE_THRESHOLD) return null;
  return `  ⚠ 缓存命中率偏低（低于 ${LOW_CACHE_HIT_RATE_THRESHOLD}%）：可能是前缀被改动或渠道不支持缓存，可运行 /cache --breaks 查看本会话的中断原因`;
}

/** /cost 命令 */
export class CostCommand implements LocalCommandModule {
  /**
   * 后台闸门读取函数**可注入**：闸门是进程级单例，`bun test` 同批多文件跑在同一进程里，
   * 测试若去占用/重置它会和 `packages/core/tests/agent/background-task-gate.test.ts`
   * 互相干扰（两个文件并发跑时，一边的 drain 会清掉另一边的待补队列）。
   * 生产路径用默认值读真实闸门，测试传假状态即可覆盖「进行中 / 排队 / 空闲」三个分支。
   */
  constructor(
    private readonly readGateStats: () => PendingTasksView = () => getBackgroundGateStats(),
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
      `总费用: ${cur}${ss.getEffectiveTotalCostUSD().toFixed(4)}`,
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
      `API 耗时（主循环）: ${SessionState.formatDuration(ss.totalAPIDuration)}`,
      ...(sideDurationLine ? [sideDurationLine] : []),
      `工具耗时: ${SessionState.formatDuration(ss.totalToolDuration)}`,
      "  （会话时长是墙钟：含思考与空闲；API 耗时只算主循环请求，子代理与辅助调用不含在内）",
      "",
      "Token 用量:",
      // D5：三段互斥。未命中 + 命中 + 写入 = 合计，命中/写入为 0 时整行省略
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
      const hitRate = (cacheView.cacheHitTokens / cacheView.promptTotal) * 100;
      const savings = ss.getTotalCacheSavings();
      lines.push("", `缓存命中率: ${hitRate.toFixed(1)}%   省钱: ${cur}${savings.toFixed(4)}`);
      // D6：这里原本写死「openai 族 60-70% 属正常上限」，不看实际数值，导致取证会话里
      // 91.7% 的命中率下面紧跟一句「60-70% 属正常上限」，自相矛盾。实测主流 openai
      // 兼容渠道命中率 80–95%（依据见 LOW_CACHE_HIT_RATE_THRESHOLD），旧口径不成立。
      // 现在只在实测值确实偏低且样本足够时提示，且给的是可行动的动作（/cache --breaks）。
      const hint = formatCacheHitHint(hitRate, ss.getTotalRequests());
      if (hint) lines.push(hint);
    }

    const models = Object.entries(ss.modelUsage);
    if (models.length > 1) {
      lines.push("", "按模型统计（累计发送口径，与上方「输入·合计」一致）:");
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
