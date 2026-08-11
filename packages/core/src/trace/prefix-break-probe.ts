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
 *
 * ## ⚠️ 两层判据：为什么 message 级不够，必须并排一个字符级
 *
 * 上面那套段判据是**message 级**的，而**服务端按 token 前缀匹配，不按 message 对象匹配**。
 * 判据与目标不在同一层，这个缝隙让 P1-3 的第一次尝试整体翻车（2026-08-09）：
 *
 *   候选方案 A 把 ambient reminder 改走独立尾部消息 → 探针的 `msg[0]` 断裂 4→0、
 *   26 个测试全绿、机理讲得通 —— 但真实命中率**降了最多 11.2pp**，已整体回滚。
 *
 * 根因：OpenAI 族把多 text block `join("\n")` 成单 string（`openai.ts:568-573`），
 * "独立 block"与"独立 message"在 wire 上塌缩成同一串字节，理论收益为零。
 * `msg[0]→0` 是**度量假象** —— 加一条尾部消息让所有下标 +1，作废比例几乎没动
 *（13.3%→12.9%）。段判据量的是"第几个 message 对象变了"，而钱是按字节算的。
 *
 * 所以本模块并排落两套判据：
 *   · **message 级**（`firstChangedKind` / `wastedRatio`）—— 回答"该改哪里"，有语义、可定位；
 *   · **字符级**（`commonPrefixChars` / `charWastedRatio`）—— 回答"改了到底省不省"，无语义但贴近计费。
 *
 * **两者不一致时以字符级为准**（`judgeDisagreement` 显式标出这种情况）。
 * 字符级仍不是真 token 级（分词由服务端决定，本地拿不到），但它已经能拦住
 * 上面那类"下标变了、字节没变"的假收益 —— 这是 P1-3 继续往下走的最低判据门槛。
 *
 * > 教训已固化进记忆 `proxy-metric-rewards-relabeling-waste`：
 * > **判据与目标不同层时，目标指标归零 + 测试全绿 + 机理讲得通，三者同时成立仍可能是错的。**
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
  /**
   * **字符级判据用**：把整条前缀按 wire 顺序拼成的扁平串。
   *
   * 为什么要存这一份而不是只靠段 hash：段 hash 只能回答"第几段变了"，
   * 回答不了"共同前缀有多少字节" —— 而钱是按字节（token）算的。
   * 见文件头「两层判据」：上一次 P1-3 就是因为只有段判据而把假收益当真收益。
   *
   * ⚠️ **绝不落盘**（含用户代码与对话内容，与本仓库"遥测只存聚合"的隐私契约冲突）。
   * 只在内存里活到下一轮比较完就丢，落盘的仅是比较出的**长度数字**。
   * `PrefixBreakTracker` 只持有上一轮一份，内存 O(1)。
   */
  flat: string;
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

  // ─── 字符级判据（P1-3 解锁条件，与上面的 message 级并排落盘）───

  /**
   * 两轮前缀的**共同前缀字符数**。这是最贴近"服务端能复用多少"的本地代理指标。
   *
   * 服务端按 token 前缀匹配。token 数拿不到（分词在服务端），但字符级共同前缀
   * 与它单调相关 —— 足以拦住"message 下标变了、字节没变"这类假收益。
   */
  commonPrefixChars: number;
  /** 上一轮前缀总字符数 —— **`charWastedRatio` 的分母**（理由见该字段） */
  prevTotalChars: number;
  /** 本轮前缀总字符数（记下来供"前缀在增长还是被截短"这类分析用，不作分母） */
  currTotalChars: number;
  /**
   * 字符级作废比例 = (prevTotalChars − commonPrefixChars) / prevTotalChars（0~1）。
   *
   * ⚠️ **分母是上一轮长度，不是本轮长度。** 这一处极易写错，而写错的方向恰好是
   * 让健康形态看起来有问题：
   *
   *   用本轮长度做分母 → `1 − common/curr` 会把**本轮新增的内容**算成"浪费"。
   *   但新增内容从来就没被缓存过，谈不上作废。于是纯尾部追加（最健康的形态、
   *   缓存完整命中）会得到一个非零的"作废率"，与段级判据的 `broken=false` 冲突，
   *   把每一轮正常请求都标成"判据矛盾"。实测这正是本字段第一版的 bug：
   *   纯追加场景报 2.91% 作废 + 矛盾=true。
   *
   * 正确语义："**上一轮已经建立起来的可缓存前缀，这一轮有多少不能再用了**"。
   * 纯尾部追加 → common == prev.length → 0%。历史被原地改写 → 改写点之后全废。
   *
   * **与 `wastedRatio` 是两个不同层的数，不要混用**：
   * 本字段按字节算（贴近计费），`wastedRatio` 按 message 对象算（便于定位）。
   * 两者不一致时以本字段为准 —— 见 `judgeDisagreement`。
   */
  charWastedRatio: number;
  /**
   * 两层判据是否给出**矛盾结论**。true 时该轮的 message 级数字不可用于评估收益。
   *
   * 判据：`broken`（段级说断了）与 `charWastedRatio` 是否显著（> 阈值）不一致。
   * 典型形态就是上次翻车的那种 —— 段级报"断在 msg[0]"，字符级却显示共同前缀
   * 几乎没变（只是所有下标平移了一位）。
   *
   * ⚠️ 这个字段存在的意义是**让假收益在数据里自己现形**，而不是靠人事后复盘。
   */
  judgeDisagreement: boolean;
}

/**
 * `judgeDisagreement` 的字符级显著性阈值。
 *
 * 取 1%：低于此的作废量在 128-token 粒度的服务端缓存扩展面前是噪声
 *（实测服务端按 128 token 整数倍渐进扩展前缀，见 cache-bench 报告 §2），
 * 段级却可能因为一个下标平移就报"断裂"。
 */
const CHAR_WASTE_SIGNIFICANT = 0.01;

/**
 * 求两串的共同前缀长度（字符数）。
 *
 * 刻意用朴素逐字符比较而非二分 + hash：前缀通常在很早就分叉（断裂时）或
 * 一路相同到尾（健康时），朴素扫描的实际开销就是 O(共同长度)，而共同长度长的
 * 情况恰恰是"没断裂"—— 那时也没别的活要干。二分需要额外的 hash 预计算，
 * 在这个访问模式下不划算，还会引入 hash 碰撞这个假阴性来源。
 */
export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
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
  /**
   * 字符级判据的输入：按 wire 顺序累积各段**原文**。
   *
   * 与 segments 在同一趟里构建（而不是事后再走一遍），两个原因：
   * ① `splitSystem` 只调一次 —— 它是注入进来的外部函数，调两次既浪费也埋下
   *    "两次返回不同"的隐患；
   * ② 顺序天然对齐：parts 的推入顺序就是 segments 的推入顺序，也就是请求体里的
   *    实际顺序（system → tools → messages）。分两趟写最容易出的错就是两边顺序漂移，
   *    而那种错会让"共同前缀"这个数悄悄失去意义。
   *
   * 用数组 + join 而非字符串 `+=`：前缀实测可达 60KB/轮，逐段累加会产生大量中间串。
   */
  const parts: string[] = [];

  if (system) {
    const { staticContent, dynamicContent } = splitSystem(system);
    segments.push({ kind: "system_static", hash: h(staticContent), length: staticContent.length });
    parts.push(staticContent);
    if (dynamicContent !== undefined) {
      segments.push({ kind: "system_dynamic", hash: h(dynamicContent), length: dynamicContent.length });
      parts.push(dynamicContent);
    }
  }

  segments.push({ kind: "tools", hash: h(toolsSerialized), length: toolsSerialized.length });
  parts.push(toolsSerialized);

  messages.forEach((m, i) => {
    // 段（message 级判据）用结构序列化：它要的正是"这条消息的结构变没变"
    const s = safeStringify(m);
    segments.push({ kind: "message", messageIndex: i, hash: h(s), length: s.length });
    // 字符级判据用 wire 文本：**刻意不同源**。用同一个串会让这一层退化成
    // 段判据的换单位重演，拦不住"结构变了、字节没变"的假收益。
    // 详见 flattenTextForWire 的注释。
    parts.push(flattenTextForWire(m));
  });

  return {
    segments,
    totalLength: segments.reduce((a, b) => a + b.length, 0),
    flat: parts.join(""),
  };
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
 * 抽出一条消息在 **wire 上真正占字节的文本**，供字符级判据使用。
 *
 * ## 为什么不能直接用 `JSON.stringify`
 *
 * 这是本轮最容易做错、且做错了就等于白做的一步。用 `JSON.stringify(message)`
 * 拼出来的串量的是 **message 结构**（`{"role":"user","content":[{"type":"text"...`），
 * 而结构恰恰是**服务端看不到的东西** —— OpenAI 族把多 text block
 * `join("\n")` 成单个 string（`openai.ts:568-573`）才发出去。
 *
 * 后果很具体：2026-08-09 回滚的方案 A 把 ambient reminder 从"msg[0] 的第二个 block"
 * 改成"独立的尾部 message"。两种形态在 wire 上**塌缩成同一串字节**，理论收益为零，
 * 实测命中率反降 11.2pp。但如果字符级判据建在 `JSON.stringify` 上，
 * 它会看到 `content` 数组从 2 元素变 1 元素、多出一个 message 对象 ——
 * **照样报出一个"改善"**，于是这一层白加了，只是把段判据的假象换了个单位重演一遍。
 *
 * 所以这里只抽文本内容、丢掉全部结构标记，并用 `\n` 连接多个 block ——
 * 刻意**复刻 OpenAI 族的 join 行为**，让"拆 block"与"拆 message"在判据里也塌缩成同一串。
 * 这样上面那类改动会被正确地判成"共同前缀没变 → 零收益"。
 *
 * ## 已知近似
 *
 * 这仍**不是**真 token 级（分词在服务端，本地拿不到），也不是逐字节的 wire 复刻：
 * · role 标记、tool_call 的 JSON 包装在真实请求里也占 token，这里被丢掉了；
 * · Anthropic 族原生支持多 block、不做 join，对它而言这是轻微低估结构开销。
 *
 * 取舍理由：判据的用途是**比较两轮之间的增量**，不是估算绝对 token 数。
 * 被丢掉的那些部分在相邻两轮里高度稳定，对"共同前缀长度"的差值影响很小；
 * 而它换来的是拦住上面那类"结构变了、字节没变"的假收益 —— 那才是 P1-3 的拦路石。
 */
function flattenTextForWire(m: unknown): string {
  if (typeof m === "string") return m;
  if (!m || typeof m !== "object") return "";
  const msg = m as { content?: unknown };
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    // 非常规形状（无 content / content 是对象）：退回结构序列化。
    // 宁可在这类少见形状上保守（把结构算进去），也不要静默返回空串 ——
    // 空串会让这条消息在字符级判据里"消失"，共同前缀凭空变长。
    return safeStringify(m);
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; content?: unknown };
    if (typeof b.text === "string") {
      parts.push(b.text);
    } else if (typeof b.content === "string") {
      // tool_result 的常见形状：{ type: "tool_result", content: "..." }
      parts.push(b.content);
    } else {
      // thinking / image / tool_use 等无纯文本载荷的块：用结构序列化占位。
      // 它们在 wire 上确实占字节，跳过会让共同前缀被高估。
      parts.push(safeStringify(block));
    }
  }
  // 用 \n 连接 —— 复刻 OpenAI 族 `join("\n")`，使"拆 block"与"拆 message"塌缩为同一串
  return parts.join("\n");
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
  // 字符级判据先算：它与段判据**互不依赖**，而且是两者矛盾时的裁判方
  //（见文件头「两层判据」）。放在前面也保证每条落盘记录都带这组数字 ——
  // 只在 broken 时才算的话，"没断裂但共同前缀掉了一半"这种情况就永远看不见。
  const commonPrefixChars = commonPrefixLength(prev.flat, curr.flat);
  const prevTotalChars = prev.flat.length;
  const currTotalChars = curr.flat.length;
  // 分母是**上一轮**长度：问的是"上轮建起来的可缓存前缀，这轮有多少不能再用"。
  // 用本轮长度会把新增内容算成浪费，让纯尾部追加（最健康形态）也报非零作废。
  // 详见 charWastedRatio 的字段注释。
  const charWastedRatio =
    prevTotalChars > 0 ? (prevTotalChars - commonPrefixChars) / prevTotalChars : 0;

  const base: PrefixBreakDiagnosis = {
    broken: false,
    prevSegmentCount: prev.segments.length,
    currSegmentCount: curr.segments.length,
    commonPrefixChars,
    prevTotalChars,
    currTotalChars,
    charWastedRatio,
    judgeDisagreement: false,
  };

  /**
   * 两层判据是否矛盾。
   *
   * · 段级说断了、字符级说几乎没浪费 → 典型的**下标平移假象**（上次 P1-3 翻车形态）；
   * · 段级说没断、字符级说浪费显著 → 段粒度太粗掩盖了段内改写（同样危险，
   *   而且更隐蔽：这种情况下 message 级看起来一切正常）。
   *
   * 两个方向都要标，不能只防上次踩过的那一个。
   */
  const disagree = (broken: boolean): boolean =>
    broken !== charWastedRatio > CHAR_WASTE_SIGNIFICANT;

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
        judgeDisagreement: disagree(true),
      };
    }
  }

  // prev 比 curr 长：历史被截短（compact / 消息删除）—— 前缀同样作废
  if (prev.segments.length > curr.segments.length) {
    return {
      ...base,
      broken: true,
      firstChangedKind: "message",
      firstChangedIndex: n,
      wastedRatio: 0,
      judgeDisagreement: disagree(true),
    };
  }

  return { ...base, judgeDisagreement: disagree(false) };
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
