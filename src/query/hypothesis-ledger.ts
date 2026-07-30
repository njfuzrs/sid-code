/**
 * Hypothesis Ledger —— 假设登记表(环节③:把"元认知纪律"从模型自律外化为 harness 机制)
 *
 * 背景(fdb47f30 / harness-llm 差距归因):deepseek 在排查中途已推出正确结论("进程没崩"),
 * 却因沉没成本把它丢弃、最终写成"崩溃"。根因不在算力,在元认知缺失:形成假设后不预注册
 * 证伪条件、拿到反驳证据时不主动裁决、把未证实的假设当结论交付。光靠 prompt 提醒不够——
 * deepseek 投入 6.2 万字思考仍然错了。
 *
 * 本模块把三件事固化成 harness 持有的状态机,不依赖模型自觉:
 *   机制1 预注册证伪:登记假设时必须声明 falsifier(证伪条件),事后不可修改。
 *   机制2 矛盾中断:新证据匹配到某条 open 假设的 falsifier 关键线索时,主循环插入高优先级
 *          中断,强制模型显式裁决(confirm / refute),而非装没看见继续滑向既定叙事。
 *   机制3 交付门禁:状态仍为 open 或 refuted 的假设不得作为结论写进最终交付物。
 *
 * 本模块是纯逻辑:不读 process、不写文件、不调 LLM。状态全部在内存对象里,
 * 由工具层(hypothesis_register / hypothesis_challenge)与主循环(矛盾检测)读写,便于单测。
 */

export type HypothesisStatus = "open" | "confirmed" | "refuted";

/** 一条证据(支持/反驳),带出处,对齐 digest 的 Provenance 精神 */
export interface HypothesisEvidence {
  /** 证据描述 */
  note: string;
  /** 出处指针(file:line / 工具输出 / 命令),让证据可回溯 */
  source?: string;
  /** 登记该证据的时刻(轮次序号),用于追溯 */
  turn?: number;
}

export interface Hypothesis {
  id: string;
  /** 假设描述 */
  statement: string;
  /**
   * 预注册的证伪条件(机制1):看到什么证据就推翻此假设。
   * 登记时必填,一经登记不可修改——防止事后挪动靶子(moving the goalposts)。
   */
  falsifier: string;
  /**
   * falsifier 的关键线索词(从 falsifier 文本提取或显式给出),用于机制2 的证据匹配。
   * 新证据文本命中任一关键词 → 触发矛盾中断,要求模型裁决。
   */
  falsifierCues: string[];
  status: HypothesisStatus;
  supporting: HypothesisEvidence[];
  refuting: HypothesisEvidence[];
  /** 创建轮次 */
  createdTurn: number;
  /** 最后状态变更轮次 */
  updatedTurn: number;
  /**
   * 已就该假设触发过矛盾中断的证据指纹集合(去重),避免同一条证据反复打断。
   */
  challengedFingerprints: string[];
}

/** 登记一条假设的入参 */
export interface RegisterInput {
  statement: string;
  falsifier: string;
  /** 可选:显式给出关键线索词;不给则从 falsifier 文本自动提取 */
  falsifierCues?: string[];
  supporting?: HypothesisEvidence[];
  turn?: number;
}

/** 对一条假设裁决的入参 */
export interface ChallengeInput {
  id: string;
  /** 裁决:确认 / 推翻 / 仍存疑(补充证据但不结案) */
  verdict: "confirm" | "refute" | "keep_open";
  /** 裁决依据(证据) */
  evidence: HypothesisEvidence;
  turn?: number;
}

/** 矛盾命中结果(机制2) */
export interface ContradictionHit {
  hypothesisId: string;
  statement: string;
  falsifier: string;
  /** 命中的关键线索词 */
  matchedCue: string;
  /** 触发命中的证据片段 */
  evidenceSnippet: string;
}

const STOPWORDS = new Set([
  "的","了","是","在","和","与","或","若","则","就","不","也","这","那","它","其",
  "a","an","the","is","are","was","were","to","of","in","on","at","it","its","if","then",
  "and","or","not","be","that","this","with","为","会","被","已","可","该","等","看到","显示",
]);

/**
 * 英文 cue 的最小长度。
 *
 * 2026-07-30 负收益防线审计 发现 2:现值 5 仍会产出 `config` / `output` / `tools` /
 * `start` / `length` 这类泛化词。在 554 条真实 tool_result 上的命中率实测:
 * `config` 31.2% / `output` 22.0% / `tools` 17.9% / `start` 15.5%——这些 cue 几乎必然
 * 命中任意后续工具输出,是 6 次真实注入全为假阳性的直接原因。
 *
 * 反事实(英文 cue 最小长度 vs 泛化程度):
 * | 阈值 | cue 数 | 平均命中率 | 泛化 cue 数(>20% 语料) |
 * |---|---|---|---|
 * | 3 | 24 | 6.3% | 3 |
 * | 5(旧值) | 15 | 7.6% | 2 |
 * | **8(现值)** | **6** | **2.2%** | **0** |
 * | 12 | 3 | 0.9% | 0 |
 * 取 8 是"泛化 cue 归零"的最小阈值;再提到 12 只剩 3 个 cue,召回损失不换来额外精度。
 */
const MIN_EN_CUE_LENGTH = 8;

/**
 * 从 falsifier 文本提取关键线索词(机制2 的匹配基础)。
 *
 * 2026-07-07 约束型误伤修复(Top 5):收紧 cue 提取,要求线索词更长更具体。
 * 此前中文 2 字片段(如"崩溃/进程/存活")+ 英文 3 字 token 做朴素 `includes` 子串匹配,
 * 高频通用词几乎必然命中任意后续工具输出,且 detectContradictions 不判断语义方向——
 * 证据其实在**支持**假设也会被当成"矛盾"触发中断。要求更长的 cue 大幅降低这种误命中:
 *   - 中文:只取整段(≥4 连续汉字),不再加 2-3 字短片段、不再加 4 字前缀;
 *   - 英文/数字 token:长度≥5(过滤掉 err/pid/cpu 等极易撞车的短词)。
 * 仍是粗召回而非精确 NLP,但把"高频短词一碰就中"的最大误伤面收掉。
 *
 * 2026-07-30 负收益防线审计 发现 2:英文阈值 5 → 8(见 MIN_EN_CUE_LENGTH 反事实表)。
 * 2026-07-31 勘误:此前这里写「显式给出的 falsifierCues 不受此约束,用户/模型自己指定的短
 * cue 仍尊重」——那个豁免让整条防线在生产主路径上失效,见 sanitizeExplicitCues 的说明。
 */
export function extractCues(falsifier: string): string[] {
  if (!falsifier) return [];
  const cues = new Set<string>();
  // 英文/数字 token(长度≥MIN_EN_CUE_LENGTH,过滤泛化易撞车词)
  const enPattern = new RegExp(`[a-z_][a-z0-9_]{${MIN_EN_CUE_LENGTH - 1},}`, "g");
  for (const m of falsifier.toLowerCase().matchAll(enPattern)) {
    const w = m[0];
    if (!STOPWORDS.has(w)) cues.add(w);
  }
  // 中文片段:只取≥4 连续汉字的整段(短通用词误命中率过高,不再纳入)
  for (const seg of falsifier.split(/[^一-龥]+/)) {
    if (seg.length < 4) continue;
    if (!STOPWORDS.has(seg)) cues.add(seg);
  }
  return [...cues];
}

/**
 * 对**显式给出**的 falsifierCues 施加同一套泛化门槛(与 extractCues 同口径)。
 *
 * 根因(轨迹 20260730-142920-d98e7f16,24 次矛盾中断全为噪音):register 里
 * 「显式 cues 直接采用、不过滤」这条豁免,让 MIN_EN_CUE_LENGTH=8 的防线在生产
 * 主路径上**完全失效**——模型每次都会填 falsifier_cues(该会话 6 条假设全带),
 * 于是 extractCues 那条带门槛的路径一次都没走到。实测命中线索词:
 *
 *   9 × `resize`(6 字符) / 3 × `⚠`(1 字符) / 2 × `stringwidth` / 2 × `alignitems` …
 *
 * `resize`、`⚠` 都短于阈值 8,本该被过滤。它们几乎必然命中后续任意工具输出
 * (读渲染相关代码时 `resize` 遍地都是),结果是模型反复写「这是词面撞车」并花
 * reasoning 去否掉假警报——纯增成本、零收益,正是 MIN_EN_CUE_LENGTH 的反事实表
 * (阈值 8 → 泛化 cue 归零)要消除的那类误伤。
 *
 * 为什么不是简单删掉「显式 cues」这个入参:模型给的 cue 往往比自动提取的更贴合
 * 意图(如把长 falsifier 里的关键标识符点出来),值得保留。要拦的只是**过短/泛化**
 * 的那部分。故这里做筛而不做弃:
 *   - 英文/数字 token:长度≥MIN_EN_CUE_LENGTH 且不在 STOPWORDS;
 *   - 中文片段:≥4 连续汉字(与 extractCues 一致);
 *   - 含点/斜杠/连字符的复合标识符(`stdout.columns` / `flex-end` / `a/b`):放行——
 *     这类本身就足够具体,不受长度门槛限制(否则 `a/b.ts` 这种精确 cue 会被误杀);
 *   - 全部筛掉时返回空数组,由 register 回落到 extractCues(falsifier)——绝不
 *     因为「模型填了一堆废 cue」就让这条假设失去矛盾检测能力。
 */
export function sanitizeExplicitCues(cues: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of cues) {
    if (typeof raw !== "string") continue;
    const c = raw.trim().toLowerCase();
    if (!c) continue;
    if (STOPWORDS.has(c)) continue;
    // 复合标识符(带 . / - 或空格分隔的多词短语)本身足够具体,免长度门槛。
    if (/[./\-\s]/.test(c)) {
      out.add(c);
      continue;
    }
    // 纯中文片段:≥4 连续汉字
    if (/^[一-龥]+$/.test(c)) {
      if (c.length >= 4) out.add(c);
      continue;
    }
    // 其余(英文/数字/下划线标识符、单个符号如 ⚠):套用英文长度门槛
    if (c.length >= MIN_EN_CUE_LENGTH) out.add(c);
  }
  return [...out];
}

/**
 * "纯空结果"识别:工具明确报告"什么都没找到"的输出不构成证据。
 *
 * 负收益防线审计 发现 2 第 4 条假阳性就是这个:grep 返回"未找到匹配的内容",
 * 却因为 cue `dump-tools` 出现在**假设自己的措辞**里而触发矛盾中断。空结果是
 * "没有信息",既不支持也不反驳任何假设,拿它打断模型纯属噪音。
 *
 * 判据保守:整条输出去掉空白后必须**完全等于**已知空结果文案之一才短路,
 * 不做子串匹配(否则"未找到匹配的内容,但……"这种带后续信息的输出会被误吞)。
 */
const EMPTY_RESULT_TEXTS = new Set([
  "未找到匹配的内容",
  "未找到匹配的文件",
  "未找到结果",
  "未找到符号",
  "未找到定义",
  "未找到实现",
  "未找到引用",
  "no matches found",
  "(no content)",
  "",
]);

export function isEmptyResultText(s: string): boolean {
  return EMPTY_RESULT_TEXTS.has(s.replace(/\s+/g, " ").trim().toLowerCase());
}

/**
 * 假设工具自身的名字——它们的 tool_result 是**回执**而非新证据。
 *
 * 负收益防线审计 发现 2:6 次真实注入里 2 次是"登记假设的回执触发自己"。
 * `hypothesis_register` 的 output(fmtHypothesis)会逐字复述 falsifier 全文,
 * 该 output 进 tool_result 后必然命中刚从同一段 falsifier 提取出的 cue——纯自噬。
 */
export const HYPOTHESIS_TOOL_NAMES = new Set(["hypothesis_register", "hypothesis_challenge"]);

/**
 * 从本轮 tool_result 里挑出可作为"新证据"的文本(机制2 的输入)。
 *
 * 纯函数,便于单测(主循环那段拿不到测试夹具)。做两件事:
 *   1. 剔除假设工具自身的回执(发现 2 自触发);
 *   2. 逐条返回而非拼成一个大串(发现 3:整轮拼接会让指纹被前缀绑死)。
 *
 * `resolveToolName` 由调用方提供(主循环用 tool_use_id 反查 response.content)。
 */
export function collectEvidenceTexts(
  results: Array<{ type?: string; tool_use_id?: string; content?: unknown }>,
  resolveToolName: (toolUseId: string | undefined) => string,
): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (r?.type !== "tool_result") continue;
    if (HYPOTHESIS_TOOL_NAMES.has(resolveToolName(r.tool_use_id))) continue;
    const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    if (typeof text === "string" && text.length > 0) out.push(text);
  }
  return out;
}

/**
 * 稳定指纹:用于证据去重,避免同一证据反复触发中断。
 *
 * 2026-07-30 负收益防线审计 发现 3:旧实现是 `slice(0, 120)`——前 120 字符相同就判为
 * "同一条证据"并静默跳过。真实语料里这个前缀极易重复(`任务清单已更新: …` /
 * `文件已编辑: …(替换了 1 处)` / 部署脚本的 `>>> [1/12] 前置校验 …`),实测碰撞率:
 *
 * | 截断长度 | 被判为"同一证据"的轮次 | 占比 |
 * |---|---|---|
 * | 120(旧值) | 53 / 452 | 11.7% |
 * | 400 | 40 | 8.8% |
 * | **全文 hash(现值)** | **37** | **8.2%** |
 *
 * 即 53 − 37 = 16 次是**纯粹由截断造成的伪碰撞**:内容不同却被当成同一证据,
 * 真矛盾被静默吞掉(漏报)。改为全文 hash 后剩下的 8.2% 都是真实重复。
 *
 * 用 FNV-1a 32 位:纯函数、无依赖、对本用途(会话内去重,规模 ~10^2)碰撞概率可忽略。
 */
function fingerprint(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < clean.length; i++) {
    h ^= clean.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 带长度做二次约束,进一步压低不同长度文本撞同一 hash 的概率
  return `${h.toString(36)}:${clean.length}`;
}

/**
 * 假设登记表 —— harness 持有的内存状态机。
 *
 * 与 TodoWriteTool 同构:模块级实例由工具读写,主循环经 getter 读快照。
 * /clear 时调 reset()。
 */
export class HypothesisLedger {
  private items = new Map<string, Hypothesis>();
  private seq = 0;
  /**
   * 缺陷3:换策略提示是否已给过(会话级一次性)。
   *
   * 为什么挂在 ledger 而不是 LoopState:LoopState 由 createInitialLoopState 在**每次
   * queryLoop 调用**(即每条用户消息)时新建,而 ledger 是会话级长生命周期对象。
   * 若把标志放 LoopState,用户下一条消息就会把它清零 → 连续推翻状态未变的情况下
   * 会再次注入,而提示文案明写"本提醒只出现一次"。跟着 ledger 走才与假设状态同寿。
   */
  private strategyNagged = false;

  /** 机制1:登记假设,强制带 falsifier。返回新建的假设。 */
  register(input: RegisterInput): Hypothesis {
    const statement = (input.statement ?? "").trim();
    const falsifier = (input.falsifier ?? "").trim();
    if (!statement) throw new Error("hypothesis.statement 不能为空");
    if (!falsifier) {
      // 机制1 的硬约束:没有证伪条件的假设不许登记。
      throw new Error("hypothesis.falsifier(证伪条件)必填——无法被证伪的不是假设,是信念");
    }
    this.seq += 1;
    const id = `H${this.seq}`;
    // 显式 cues 也要过泛化门槛(见 sanitizeExplicitCues:旧豁免让 MIN_EN_CUE_LENGTH
    // 防线在生产主路径完全失效)。筛完为空则回落到自动提取,不让假设失去矛盾检测能力。
    const explicit = input.falsifierCues?.length ? sanitizeExplicitCues(input.falsifierCues) : [];
    const cues = explicit.length > 0 ? explicit : extractCues(falsifier);
    const h: Hypothesis = {
      id,
      statement,
      falsifier,
      falsifierCues: cues,
      status: "open",
      supporting: input.supporting ? [...input.supporting] : [],
      refuting: [],
      createdTurn: input.turn ?? 0,
      updatedTurn: input.turn ?? 0,
      challengedFingerprints: [],
    };
    this.items.set(id, h);
    return h;
  }

  /** 裁决一条假设(机制2 的人/模型响应入口) */
  challenge(input: ChallengeInput): Hypothesis {
    const h = this.items.get(input.id);
    if (!h) throw new Error(`未找到假设 ${input.id}`);
    const ev = { ...input.evidence, turn: input.evidence.turn ?? input.turn };
    if (input.verdict === "confirm") {
      h.supporting.push(ev);
      h.status = "confirmed";
    } else if (input.verdict === "refute") {
      h.refuting.push(ev);
      h.status = "refuted";
    } else {
      // keep_open:补充反驳证据但不结案(证据不足以定论)
      h.refuting.push(ev);
      h.status = "open";
    }
    h.updatedTurn = input.turn ?? h.updatedTurn;
    // 裁决后,把本条证据指纹记入已处理集合(防止同证据再次触发中断)
    const fp = fingerprint(`${ev.note} ${ev.source ?? ""}`);
    if (!h.challengedFingerprints.includes(fp)) h.challengedFingerprints.push(fp);
    return h;
  }

  /**
   * 机制2 核心:用一段新证据文本,检测是否与任何 open 假设的 falsifier 线索矛盾。
   * 命中即返回(可能多条),由主循环据此注入矛盾中断。已就同一证据裁决过的不再触发。
   */
  detectContradictions(evidence: string | string[]): ContradictionHit[] {
    // 发现 3 后半:支持**逐条** tool_result 而非整轮拼接串。
    // 旧调用点把一整轮所有 tool_result join("\n") 成一个大串再算一个指纹——
    // 这让"某一条 tool_result 变了但拼接串前缀没变"的轮次整体被去重吞掉。
    // 逐条各算指纹后,一条被去重不影响其它条。字符串入参仍兼容(视为单条)。
    const items = (Array.isArray(evidence) ? evidence : [evidence]).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (items.length === 0) return [];

    const hits: ContradictionHit[] = [];
    for (const text of items) {
      // 发现 2:纯空结果("未找到匹配的内容"等)不是证据,不该打断模型
      if (isEmptyResultText(text)) continue;
      const hay = text.toLowerCase();
      const fp = fingerprint(text);
      for (const h of this.items.values()) {
        if (h.status !== "open") continue; // 只挑战未结案的
        if (h.challengedFingerprints.includes(fp)) continue; // 该证据已处理过
        // 同一轮内一条假设最多产出一条命中(多条 tool_result 都撞同一假设时不重复打扰)
        if (hits.some((x) => x.hypothesisId === h.id)) continue;
        for (const cue of h.falsifierCues) {
          if (cue && hay.includes(cue)) {
            hits.push({
              hypothesisId: h.id,
              statement: h.statement,
              falsifier: h.falsifier,
              matchedCue: cue,
              evidenceSnippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
            });
            // 记入指纹,避免下一轮同证据重复触发(本轮已会注入中断)
            h.challengedFingerprints.push(fp);
            break; // 一条假设命中一次即可
          }
        }
      }
    }
    return hits;
  }

  /** 机制3:交付门禁——返回仍为 open / refuted 的假设(不得作为结论交付) */
  unsettled(): Hypothesis[] {
    return [...this.items.values()].filter((h) => h.status !== "confirmed");
  }

  get(id: string): Hypothesis | undefined {
    return this.items.get(id);
  }

  all(): Hypothesis[] {
    return [...this.items.values()];
  }

  /** 是否有任何已登记假设(主循环据此决定是否跑矛盾检测,省开销) */
  isEmpty(): boolean {
    return this.items.size === 0;
  }

  /**
   * 当前轮次有 open 假设。
   *
   * ⚠️ 注意口径:这个方法**只看 open**,不含 refuted。交付门禁请勿用它做闸门——
   * 用 `hasUnsettled()`(与 `unsettled()` / buildDeliveryGateReminder 同口径)。
   * 保留本方法是因为「有没有仍在被挑战的活假设」本身是个有意义的独立问题
   * (矛盾检测只挑战 open 假设),且已有持久化测试依赖其语义。
   */
  hasOpen(): boolean {
    for (const h of this.items.values()) if (h.status === "open") return true;
    return false;
  }

  /**
   * 交付门禁的正确闸门:有任何**未确认**(open 或 refuted)的假设。
   *
   * 根因(轨迹 20260730-142920-d98e7f16,交付门禁实测注入 0 次):门禁此前用
   * `hasOpen()` 判闸,但它的载荷 `unsettled()` 是 `status !== "confirmed"`——
   * **闸门判据比它自己声明的范围窄了一档**。该会话 H1-H6 全部 refuted、0 open,
   * 于是闸门不响,尽管这恰恰是最该拦的场景:模型手里没有任何 confirmed 结论,
   * 6 个假设全被推翻,正是机制3 要防的「把未证实的假设当结论交付」。
   *
   * 与三处声明对齐(此前只有闸门一处不对齐):
   *   - `unsettled()`: status !== "confirmed"
   *   - `buildDeliveryGateReminder` 文案:「状态为 open **或 refuted**」
   *   - 模块头注释机制3:「open/refuted 的假设不得作为结论交付」
   */
  hasUnsettled(): boolean {
    for (const h of this.items.values()) if (h.status !== "confirmed") return true;
    return false;
  }

  /**
   * 连续推翻计数:按登记顺序从**末尾**往前数,连续 refuted 的假设有几条
   * (遇到 confirmed 或 open 即停)。
   *
   * 用途(缺陷3,轨迹 20260730-142920-d98e7f16):该会话 H1-H6 全部 refuted、
   * 0 confirmed,模型连推 6 个假设仍在原地登记第 7 个同类假设,最后靠自己反应过来
   * ——而且是以自我批判的方式("我一直在凭推理猜方向,这违反纪律")。harness 里
   * 没有任何机制观察到这个模式:refute 单看是"有价值的纠偏",连续 refute 则是
   * **搜索空间选错了**的信号,该换方法(查 git 历史 / 加日志实测 / 问用户),
   * 而不是继续同一路数猜下一个。
   *
   * 用"连续"而非"总数"是为了不惩罚正常排查:先错几次再 confirm 是健康的,
   * confirm 会把计数清零;只有"一直错、一次没对"才是要提示换策略的形态。
   */
  consecutiveRefutations(): number {
    const list = [...this.items.values()];
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.status !== "refuted") break;
      n++;
    }
    return n;
  }

  /** 是否有任何已确认假设(供"连推 N 条但一条没confirm"的策略提示判定) */
  hasConfirmed(): boolean {
    for (const h of this.items.values()) if (h.status === "confirmed") return true;
    return false;
  }

  /**
   * 缺陷3:判定「该给换策略提示了吗」,并在返回 true 时**就地置位**一次性标志。
   *
   * 收成一个方法(而非让调用方自己拼 3 个条件 + 自己置位)的理由:判据与"只给一次"
   * 的语义必须原子,否则调用方漏置位就会每轮刷屏、错置位就永久哑火。
   * 返回连续推翻条数(>0 表示该提示),0 表示不提示。
   */
  claimStrategyNag(threshold: number): number {
    if (this.strategyNagged) return 0;
    if (this.hasConfirmed()) return 0;
    const n = this.consecutiveRefutations();
    if (n < threshold) return 0;
    this.strategyNagged = true;
    return n;
  }

  /** /clear 时重置 */
  reset(): void {
    this.items.clear();
    this.seq = 0;
    // 一次性标志随 /clear 一并清零：新一轮排查是全新的搜索过程，应当重新有机会拿到提示。
    this.strategyNagged = false;
  }

  /**
   * 序列化登记表为可持久化快照(写入会话 JSONL 的 hypothesis_ledger metadata,resume 回灌)。
   *
   * 根因:items/seq 是纯内存态,此前从未持久化也从未回灌——跨会话续做同一排查时(`-c` 恢复),
   * 登记表全新为空,机制3「交付门禁」失去依据:上一会话登记的 open/refuted 假设不再拦截交付,
   * 模型可能把未证实的假设当结论写出去(正是本模块要防的 fdb47f30 事故模式)。
   *
   * 全量存储 items(含证据链/证伪线索/状态)+ seq(保持 id 单调递增,避免恢复后 register 撞号)。
   */
  serialize(): { seq: number; items: Hypothesis[]; strategyNagged?: boolean } {
    return {
      seq: this.seq,
      // 缺陷3：一次性标志随快照走。理由与 items 持久化同源——跨会话续做同一排查时
      // （`-c` 恢复），若标志不回灌，上个会话已给过的换策略提示会再给一次，
      // 而文案明写"本提醒只出现一次"。
      strategyNagged: this.strategyNagged,
      // 深拷贝,防止外部改写快照污染内部状态(与 TodoWriteTool.serialize 同款纪律)
      items: [...this.items.values()].map((h) => ({
        ...h,
        falsifierCues: [...h.falsifierCues],
        supporting: h.supporting.map((e) => ({ ...e })),
        refuting: h.refuting.map((e) => ({ ...e })),
        challengedFingerprints: [...h.challengedFingerprints],
      })),
    };
  }

  /**
   * 从持久化快照回灌登记表(resume 恢复路径调用)。
   *
   * 容错:快照缺字段/类型不符时逐条跳过,绝不因脏快照阻断恢复。直接覆盖(resume 时本就是空实例)。
   * seq 取「快照 seq」与「回灌成功的最大 H 编号」的较大值——即使 seq 字段丢失或偏小,也能保证
   * 后续 register 生成的 id 不与已恢复假设撞号。
   */
  hydrate(snapshot: { seq?: unknown; items?: unknown; strategyNagged?: unknown } | undefined | null): void {
    if (!snapshot || typeof snapshot !== "object") return;
    const rawItems = (snapshot as { items?: unknown }).items;
    if (!Array.isArray(rawItems)) return;
    const restored = new Map<string, Hypothesis>();
    let maxSeq = 0;
    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue;
      const h = item as Partial<Hypothesis>;
      if (typeof h.id !== "string" || !h.id) continue;
      if (typeof h.statement !== "string" || !h.statement) continue;
      if (typeof h.falsifier !== "string" || !h.falsifier) continue;
      if (h.status !== "open" && h.status !== "confirmed" && h.status !== "refuted") continue;
      restored.set(h.id, {
        id: h.id,
        statement: h.statement,
        falsifier: h.falsifier,
        falsifierCues: Array.isArray(h.falsifierCues) ? h.falsifierCues.filter((c): c is string => typeof c === "string") : [],
        status: h.status,
        supporting: Array.isArray(h.supporting) ? h.supporting.filter((e): e is HypothesisEvidence => !!e && typeof e === "object" && typeof (e as HypothesisEvidence).note === "string") : [],
        refuting: Array.isArray(h.refuting) ? h.refuting.filter((e): e is HypothesisEvidence => !!e && typeof e === "object" && typeof (e as HypothesisEvidence).note === "string") : [],
        createdTurn: typeof h.createdTurn === "number" ? h.createdTurn : 0,
        updatedTurn: typeof h.updatedTurn === "number" ? h.updatedTurn : 0,
        challengedFingerprints: Array.isArray(h.challengedFingerprints) ? h.challengedFingerprints.filter((f): f is string => typeof f === "string") : [],
      });
      // 从 id(形如 "H3")提取编号,兜底 seq
      const m = /^H(\d+)$/.exec(h.id);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    this.items = restored;
    const snapSeq = typeof (snapshot as { seq?: unknown }).seq === "number" ? (snapshot as { seq: number }).seq : 0;
    this.seq = Math.max(snapSeq, maxSeq);
    // 缺陷3：一次性标志回灌（缺字段的旧快照 → false，即恢复后仍有一次提示机会，
    // 这是安全的降级方向：宁可多给一次有用提示，不要静默哑火）。
    if ((snapshot as { strategyNagged?: unknown }).strategyNagged === true) {
      this.strategyNagged = true;
    }
  }
}

// ─────────────────── system-reminder 构建(纯函数,便于单测) ───────────────────

/**
 * 机制2:构造"矛盾中断"system-reminder。
 *
 * 当新证据命中某条 open 假设的证伪条件线索时,主循环注入此提醒,强制模型停下来裁决,
 * 而不是装没看见、继续滑向既定叙事。这正是 fdb47f30 缺的那一下:deepseek 拿到了
 * "进程没崩"的证据(命中了"崩溃"假设的证伪条件),却没有停下来裁决就继续写"崩溃"。
 */
export function buildContradictionReminder(hits: ContradictionHit[]): string {
  const lines = hits.map(
    (h) =>
      `- ${h.hypothesisId}「${h.statement}」的证伪条件是:${h.falsifier}\n` +
      `  刚出现的证据命中了它的关键线索「${h.matchedCue}」:${h.evidenceSnippet}`,
  );
  return `<system-reminder>
提示(请勿向用户提及本提醒):以下新证据的文本命中了你之前登记假设的证伪条件线索,
可能与假设相关,也可能只是词面撞车——请你自己判断。

${lines.join("\n")}

如果你判断证据确实与某条假设相关,可用 hypothesis_challenge 更新其状态:
- 证据推翻了假设 → verdict=refute(这是有价值的纠偏,不是失败);
- 证据不足以定论 → verdict=keep_open;
- 证据其实支持假设或只是词面撞车、不构成矛盾 → 可忽略本提醒,或按需 confirm/keep_open。
本提醒仅供参考,不要求你中断当前工作;若无关可直接继续。
</system-reminder>`;
}

/**
 * 机制3:构造"交付门禁"system-reminder。
 *
 * 模型试图收尾(end_turn)但仍有 open/refuted 假设未结清时注入,阻止它把未证实的假设
 * 当结论交付。对齐 todo 完成度门禁的思路,但门的是"结论的证据成色"而非"任务完成度"。
 */
export function buildDeliveryGateReminder(unsettled: Hypothesis[]): string {
  const lines = unsettled.map((h) => `- ${h.id} [${h.status}]「${h.statement}」`);
  return `<system-reminder>
你正准备收尾,但假设登记表中仍有 ${unsettled.length} 条假设未被确认(状态为 open 或 refuted):
${lines.join("\n")}

机制3 交付门禁:**未确认的假设不得作为结论写进最终交付物。**
请逐条处理:
- 还能验证的 → 去取证后用 hypothesis_challenge 裁决;
- 已被推翻(refuted)的 → 不要写进结论,或明确标注"此前假设已被证伪";
- 确实无法定论的 → 在交付物里如实降级为"待验证",不要伪装成已确认的根因。
</system-reminder>`;
}

/**
 * 连续推翻阈值:连推这么多条假设且一条没 confirm,就提示换策略。
 *
 * 取 3 的依据(轨迹 20260730-142920-d98e7f16):该会话连推 6 条才由模型自己反应过来,
 * 中间白烧了约 30 分钟与数万 token。3 条是"已经不是偶然、但还没烧太多"的位置:
 * 1-2 条连错属正常排查噪音(排查本就是试错),提示会变成打扰;等到 6 条才提示,
 * 该省的成本已经花掉了。只提示一次(见 loop.ts 的 hypothesisStrategyNagged 一次性标志)。
 */
export const CONSECUTIVE_REFUTATION_NAG_THRESHOLD = 3;

/**
 * 缺陷3:构造"连续推翻 → 换策略"提醒。
 *
 * 与矛盾中断/交付门禁的区别:那两个管的是**单条假设**的证据成色,这个管的是
 * **整体搜索方向**——连推 N 条一条没中,说明假设的来源(凭代码推理/凭注释外推)
 * 本身不对,该换取证手段而不是换下一个猜测。
 *
 * 措辞刻意避免指责:模型在真实轨迹里把这种情形读成了"我违反了纪律"并开始自我批判,
 * 那是 harness 缺位造成的误读——连续 refute 是**信息**,不是过错。所以这里只给
 * 事实(连推 N 条)+ 可执行的替代动作,不带任何"你违反了"的措辞。
 */
export function buildStrategyShiftReminder(refutedCount: number): string {
  return `<system-reminder>
提示(请勿向用户提及本提醒):你已连续推翻 ${refutedCount} 条假设,且还没有任何一条被确认。

这通常不是纪律问题,而是**取证手段**的信号:连续推翻说明这批假设的来源(多为凭代码
静态推理、凭注释/命名外推)难以覆盖真实根因。与其登记下一条同类假设,不妨换一种能
直接产出事实的手段:

- 查改动史:\`git log -p\` / \`git blame\` 锁定相关区域最近的改动(尤其"此前反复修过"的地方);
- 做实测:加临时日志 / 写最小复现脚本,让运行时数据说话,而不是继续推断;
- 换观察层:去读调用方/上游数据来源,而非在当前文件里继续找;
- 问用户:补一个关键的复现条件或环境细节,往往比再猜三次都有效。

已推翻的假设是有效产出(缩小了空间),不必回头翻案。本提醒只出现一次。
</system-reminder>`;
}
