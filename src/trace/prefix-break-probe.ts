/**
 * prefix-break-probe.ts —— 前缀断裂**定位**埋点（P1-2 的数据前提）
 *
 * ## 为什么需要新埋点：原方案那条路在现有数据上走不通
 *
 * 方案 P1-2 原文是"从 raw.jsonl 逐轮 diff `request.system` 与 `messages` 前缀"。
 * 实测（2026-08-08）这条路不通：
 *   - `collector.ts:707-715` **只在 index==1** 存完整 `system`/`messages`，后续轮次
 *     只存 `new_messages` 增量。28 个会话 326 条请求记录里只有 28 条是完整的。
 *   - `computeNewMessages`（collector.ts:1793）是纯尾部 `slice`，**原地改写与历史中部
 *     插入不留任何痕迹** —— 而 JIT 注入 / reminder / todo 回注干的正是这类事。
 * 也就是说：历史数据里既没有可 diff 的完整前缀，也没有能反映中部变化的增量。
 *
 * ## 为什么不落完整前缀，而落 hash 链
 *
 * 落完整 system+messages 每轮约 60KB（实测首轮 system 53880 字符），190 轮会话就是
 * 十几 MB，且**含用户代码与对话内容**——与本仓库"遥测只存聚合、绝不存内容"的隐私
 * 契约直接冲突。而定位断裂只需要知道"第一个变化的段在哪"，不需要变化的内容。
 *
 * 所以这里落**分段 hash 链**：把请求前缀切成有语义的段（system 静态区 / system 动态区 /
 * tools / 每条历史消息），逐段 hash。逐轮比较两条链即可回答 P1-3 真正需要的问题：
 *   - 断在 system 静态区 → 有动态内容漏进了静态段（本该稳定的地方在变）
 *   - 断在 system 动态区 → 预期行为（动态区就是会变），但可衡量它有多大
 *   - 断在 tools → 工具集合/顺序不稳定
 *   - 断在第 k 条消息 → 历史被原地改写（k 越靠前，浪费越大）
 *   - 只在尾部追加 → **完全没断裂**，这是健康形态
 *
 * 关键设计：**在线比较，只落结论**。hash 链本身不落盘（每轮几百个 hash 也会积累），
 * 只把"与上一轮相比第一个变化的段"这一条结论写进 events.jsonl。
 */

import { createHash } from "node:crypto";

/** 段类型 —— 与 P1-3 的候选优化项一一对应，便于直接读出该改哪里 */
export type PrefixSegmentKind =
  | "system_static"
  | "system_dynamic"
  | "tools"
  | "message";

export interface PrefixSegment {
  kind: PrefixSegmentKind;
  /** message 段的序号（0-based）；其它段为 undefined */
  messageIndex?: number;
  hash: string;
  /** 段的字符长度 —— 用于估算"断在这里浪费了多少" */
  length: number;
}

/** 一轮请求的前缀指纹 */
export interface PrefixFingerprint {
  segments: PrefixSegment[];
  /** 前缀总字符数（估算浪费比例的分母） */
  totalLength: number;
}

/** 逐轮比较的结论（这才是落盘的东西） */
export interface PrefixBreakDiagnosis {
  /** 与上一轮相比是否发生了"非尾部追加"的变化 */
  broken: boolean;
  /** 第一个变化段的类型；broken=false 时为 undefined */
  firstChangedKind?: PrefixSegmentKind;
  /** 第一个变化段的下标（在 segments 数组里）；broken=false 时为 undefined */
  firstChangedIndex?: number;
  /** 第一个变化段若是 message，它在历史里的序号 */
  firstChangedMessageIndex?: number;
  /**
   * 从第一个变化处起、被作废的前缀字符数占总前缀的比例（0~1）。
   *
   * 这是"这次断裂有多贵"的直接度量：断在第 2 条消息比断在第 200 条贵得多。
   * P1-3 该先优化哪一类，看的就是这个值的分布而不是断裂**次数**。
   */
  wastedRatio?: number;
  /** 上一轮 / 本轮的段数（尾部追加会让后者更大） */
  prevSegmentCount: number;
  currSegmentCount: number;
}

function h(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/**
 * 计算一轮请求的前缀指纹。
 *
 * @param system system prompt 原文（含 DYNAMIC_BOUNDARY 时会被拆成静态/动态两段）
 * @param toolsSerialized 工具 schema 的序列化结果（顺序敏感 —— 顺序变了缓存就断）
 * @param messages 历史消息（逐条 hash，故中部改写可被定位）
 * @param splitSystem 注入 system 拆分函数，避免本模块反向依赖 api 层
 */
export function fingerprintPrefix(
  system: string | undefined,
  toolsSerialized: string,
  messages: unknown[],
  splitSystem: (s: string) => { staticContent: string; dynamicContent?: string },
): PrefixFingerprint {
  const segments: PrefixSegment[] = [];

  if (system) {
    const { staticContent, dynamicContent } = splitSystem(system);
    segments.push({ kind: "system_static", hash: h(staticContent), length: staticContent.length });
    if (dynamicContent !== undefined) {
      segments.push({ kind: "system_dynamic", hash: h(dynamicContent), length: dynamicContent.length });
    }
  }

  segments.push({ kind: "tools", hash: h(toolsSerialized), length: toolsSerialized.length });

  messages.forEach((m, i) => {
    const s = safeStringify(m);
    segments.push({ kind: "message", messageIndex: i, hash: h(s), length: s.length });
  });

  return { segments, totalLength: segments.reduce((a, b) => a + b.length, 0) };
}

/** 序列化单条消息用于 hash。循环引用等异常降级为空串（绝不因埋点抛错）。 */
function safeStringify(m: unknown): string {
  try {
    return JSON.stringify(m) ?? "";
  } catch {
    return "";
  }
}

/**
 * 比较两轮指纹，定位第一个变化的段。
 *
 * **纯尾部追加不算断裂** —— 这正是健康形态：前缀完全没动，只在末尾加了新消息，
 * 缓存能完整命中。只有前 min(len) 段里出现不一致才是断裂。
 */
export function diagnosePrefixBreak(
  prev: PrefixFingerprint,
  curr: PrefixFingerprint,
): PrefixBreakDiagnosis {
  const base: PrefixBreakDiagnosis = {
    broken: false,
    prevSegmentCount: prev.segments.length,
    currSegmentCount: curr.segments.length,
  };

  const n = Math.min(prev.segments.length, curr.segments.length);
  for (let i = 0; i < n; i++) {
    const a = prev.segments[i]!;
    const b = curr.segments[i]!;
    // 段类型不同也算断裂（例如动态区从有到无 → 整条链错位）
    if (a.hash !== b.hash || a.kind !== b.kind) {
      // 浪费量 = 从断点起到本轮前缀结尾的字符数（这一段之后全部要重算）
      const wasted = curr.segments.slice(i).reduce((s, x) => s + x.length, 0);
      return {
        ...base,
        broken: true,
        firstChangedKind: b.kind,
        firstChangedIndex: i,
        firstChangedMessageIndex: b.messageIndex,
        wastedRatio: curr.totalLength > 0 ? wasted / curr.totalLength : 0,
      };
    }
  }

  // prev 比 curr 长：历史被截短（compact / 消息删除）—— 前缀同样作废
  if (prev.segments.length > curr.segments.length) {
    return { ...base, broken: true, firstChangedKind: "message", firstChangedIndex: n, wastedRatio: 0 };
  }

  return base;
}

/**
 * 有状态的追踪器：每轮喂入指纹，返回与上一轮比较的结论。
 *
 * 只保留**上一轮**的指纹（不是全历史）——内存 O(1) 且这就是缓存断裂的判据所需：
 * 缓存比对的永远是相邻两次请求。
 */
export class PrefixBreakTracker {
  private prev: PrefixFingerprint | null = null;

  /** 返回 null 表示这是首轮（无可比对象），不是"没断裂" */
  observe(fp: PrefixFingerprint): PrefixBreakDiagnosis | null {
    const prev = this.prev;
    this.prev = fp;
    if (!prev) return null;
    return diagnosePrefixBreak(prev, fp);
  }

  reset(): void {
    this.prev = null;
  }
}
