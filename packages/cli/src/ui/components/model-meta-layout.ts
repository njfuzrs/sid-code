/**
 * /model 面板的**列宽预算**纯逻辑：终端有多宽、放得下哪几列。
 *
 * 为什么这件事需要单独一个模块（而不是在组件里 `if (termWidth > 100)`）：
 * 列宽是一组**互相牵制**的数（名字列宽依赖全量模型名、总宽依赖终端、能放几列依赖前两者），
 * 拿魔法阈值硬编码必然在某个终端宽度下溢出——而溢出在终端里的表现是**换行错位**，
 * 整个列表的对齐一起塌掉，比少一列难看得多。算清楚再决定，就不会有"某个宽度下很丑"。
 *
 * 两条设计判据：
 *
 * 1. **新列只在放得下时才出现，绝不挤掉已有列**。裁剪顺序由外向内：
 *    上下文列 → 价格列 → 端点列，而「光标 + 名字 + provider + 行尾徽章」是行的身份，
 *    再窄也不裁。宽终端全列齐全，窄终端逐级退化成改动前的样子，是最小惊讶。
 *    （端点列改动前是「永不裁」的，但实测 56 列下它会被 ink 硬换行、把所有行的对齐
 *    一起冲掉 —— 那不是"保住了端点"，是塌版。列宽预算收归本模块后一并修掉。）
 * 2. **裁掉的信息必须还能拿到**：光标详情行始终显示完整参数与价格（不受宽度影响，
 *    它是独占整行的，横向压力小得多）。所以裁列不等于信息丢失，只是"不能横向比较"。
 *    这条是允许裁列的前提——`src/ui/CLAUDE.md` L3.3「折叠必须给摘要而非完全隐藏」的同款。
 */

import stringWidth from "string-width";
import { TODO_COMPLETED } from "../constants/figures.ts";

/** 列之间的最小间隔（列宽已含 pad，这里是"至少留几个空格") */
const COL_GAP = 2;

/**
 * 面板边框 + 内边距占用的列数：`borderStyle="round"` 左右各 1 + `paddingX={1}` 左右各 1。
 * 算错这个数的后果是最右列贴边或溢出换行，所以跟着组件的 Box 属性走，别拍数字。
 */
const CHROME_WIDTH = 4;

/** 光标字形列（`<Box width={2}>`），每行固定占用 */
const CURSOR_WIDTH = 2;

/**
 * 行尾「当前」徽章的实际列宽。
 *
 * **从渲染用的同一个常量算出来，不写字面量**：手写的 6 曾经就是错的（把 `●` 当成 2 列，
 * 实测 `stringWidth(" ● 当前") === 7`），差 1 列的后果是恰好卡在预算边界的那一行被 ink
 * 换行 —— 正是本模块存在的目的（防对齐塌掉）要挡的事。
 * 字形换了（`figures.ts` 的 BULLET 在 mac / 非 mac 上就是两个不同字符）这里自动跟着变。
 */
const CURRENT_BADGE_WIDTH = stringWidth(` ${TODO_COMPLETED} 当前`);

/** 一行里各列的宽度与启用状态。宽度为 0 的列不渲染。 */
export interface MetaColumnPlan {
  nameWidth: number;
  providerWidth: number;
  /** 端点列宽。0 = 本次不显示（极窄终端） */
  endpointWidth: number;
  /** 上下文窗口列宽。0 = 本次不显示 */
  contextWidth: number;
  /** 价格列宽。0 = 本次不显示 */
  priceWidth: number;
}

/** 计算列宽所需的每行素材（已格式化成最终要印的字符串，长度即列宽下限）。 */
export interface MetaColumnInput {
  name: string;
  provider: string;
  endpoint?: string;
  /** 已格式化的上下文列文本（如 `1M` / `~200K`），无则 undefined */
  context?: string;
  /** 已格式化的价格列文本（如 `$3/$15`），无则 undefined */
  price?: string;
}

/**
 * 按终端宽度决定各列宽度。
 *
 * 列宽一律按**全量条目**算而不是当前过滤结果：否则打字过滤时列宽跟着结果集跳动，
 * 每敲一个字整个列表横向抖一下（这条在 ModelDialog 里本来就有，此处延续同一口径）。
 *
 * @param items      全量模型的列素材
 * @param termWidth  终端总列数
 */
export function computeMetaColumns(items: MetaColumnInput[], termWidth: number): MetaColumnPlan {
  const nameWidth = maxWidth(items.map((i) => i.name));
  const providerWidth = maxWidth(items.map((i) => i.provider));
  const endpointWidth = maxWidth(items.map((i) => i.endpoint));
  const contextWidth = maxWidth(items.map((i) => i.context));
  const priceWidth = maxWidth(items.map((i) => i.price));

  // 可用内容宽度。非 TTY / 异常值时给一个宽松的假设（80 是终端事实标准下限），
  // 而不是 0 —— 0 会让下面所有列都被裁掉，无头环境里等于面板突然少了一半信息。
  const avail = (Number.isFinite(termWidth) && termWidth > 0 ? termWidth : 80) - CHROME_WIDTH;

  // 行尾还要留给 `● 当前` / `⚠ 同名被遮蔽` 徽章，不预留会让最长那行的徽章换行。
  // 取「当前」徽章的宽度作为预留下限 —— 「同名被遮蔽」更长（14 列），但它是异常态、
  // 少数行，让它偶尔挤一下优于所有行都少一列。
  const BADGE_RESERVE = CURRENT_BADGE_WIDTH;

  // 名字 + provider + 光标 + 徽章：这三样是**行的身份**，没有它们这一行就没有意义，
  // 所以再窄也不裁（真放不下时由 ink 换行，与改动前行为一致）。
  const identityCost = CURSOR_WIDTH + nameWidth + COL_GAP + providerWidth + BADGE_RESERVE;

  // 三个可选列（端点 / 价格 / 窗口）**枚举全部 8 种组合取最优**，而不是按优先级贪心认领。
  //
  // 为什么不能贪心：贪心会破坏「越宽显示越多」这条铁律。实测反例——某个宽度下端点放不下、
  // 价格+窗口放得下（2 列）；把终端**拉宽一点**，端点恰好放得下便先认领掉 20 列，
  // 价格与窗口反而双双挤掉（1 列）。用户拖宽窗口结果信息变少了，这是纯 bug 观感。
  //
  // 枚举是天然单调的：某个组合在宽度 w 放得下，在 w+1 必然也放得下，所以"能放下的组合集合"
  // 随宽度只增不减，取最优的得分也只增不减。8 种组合的枚举成本可忽略。
  //
  // 评分：**先比列数、再比优先级权重**。列数优先保证单调；权重决定同列数时谁胜出——
  // 端点权重最高（它是**区分同一模型两个渠道的唯一手段**，少了它两行长得一模一样，
  // 用户无法判断选哪个，那是"选错"而不是"少看一个参考量"），价格次之（差异常是数量级的），
  // 窗口最低（够用是常态）。三者详情行都始终给全，不存在信息拿不到。
  const OPTIONAL = [
    { width: endpointWidth, weight: 4 },
    { width: priceWidth, weight: 2 },
    { width: contextWidth, weight: 1 },
  ];
  const budget = avail - identityCost;
  let bestMask = 0;
  let bestScore = -1;
  for (let mask = 0; mask < 1 << OPTIONAL.length; mask++) {
    let cost = 0;
    let count = 0;
    let weight = 0;
    for (let i = 0; i < OPTIONAL.length; i++) {
      if (!(mask & (1 << i))) continue;
      const col = OPTIONAL[i]!;
      // 宽度为 0 的列（该字段全缺）不可入选：选它等于白占一个"列数"名额
      if (col.width <= 0) {
        cost = Number.POSITIVE_INFINITY;
        break;
      }
      cost += COL_GAP + col.width;
      count++;
      weight += col.weight;
    }
    if (cost > budget) continue;
    // 列数放大 10 倍压过权重总和上限（4+2+1=7），保证"列数优先"不被权重反超
    const score = count * 10 + weight;
    if (score > bestScore) {
      bestScore = score;
      bestMask = mask;
    }
  }
  const endpoint = bestMask & 1 ? endpointWidth : 0;
  const price = bestMask & 2 ? priceWidth : 0;
  const context = bestMask & 4 ? contextWidth : 0;

  return {
    nameWidth,
    providerWidth,
    endpointWidth: endpoint,
    contextWidth: context,
    priceWidth: price,
  };
}

/** 一组字符串的最大终端列宽（CJK 安全，见 src/ui/CLAUDE.md L2.3）。全空返回 0。 */
function maxWidth(values: Array<string | undefined>): number {
  let w = 0;
  for (const v of values) {
    if (v) w = Math.max(w, stringWidth(v));
  }
  return w;
}

/** 把文本右侧补空格到指定列宽（用 stringWidth，不用 length）。 */
export function padTo(text: string, width: number): string {
  const pad = width - stringWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}
