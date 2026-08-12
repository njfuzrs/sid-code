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

/**
 * 缺口4:证据方向。
 *
 * 根因(全量 68 会话里 `keep_open` 只在 1 个会话出现过 2 次,近乎死选项):
 * `keep_open` 的实现是**无条件** `h.refuting.push(ev)`。于是模型想说"我有一些支持证据
 * 但还不够定论"时**没有对应出口**——用 keep_open 会把支持证据错误地记进 refuting。
 * 语义缺口让选项不可用,三元裁决事实上二元化成 confirm / refute,而二元化会把
 * "证据不足"的真实处境推向 `confirm`(refute 意味着放弃线索,confirm 能继续推进),
 * 与缺口1(confirm 曾是单向吸收态)形成正反馈:
 *   证据不足 → 事实二元化 → 倾向 confirm → 永久免疫证伪 → 错误结论畅通交付
 *
 * `neutral` 是 keep_open 未显式给方向时的默认落点:此时"这条证据算支持还是反驳"
 * 本来就未定,硬塞进任一侧都是在伪造信息——这正是本缺口要修的病。
 */
export type EvidenceDirection = "supporting" | "refuting" | "neutral";

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
  /**
   * 缺口4:方向未定的存疑证据(keep_open 未显式给方向时的落点)。
   *
   * 与 supporting/refuting 分开存,而不是二选一硬塞:"证据不足以定论"这件事本身
   * 是有信息量的,把它记进 refuting 会让"连续推翻计数""交付门禁文案"都读到假信息。
   */
  neutral: HypothesisEvidence[];
  /** 创建轮次 */
  createdTurn: number;
  /** 最后状态变更轮次 */
  updatedTurn: number;
  /**
   * 已就该假设触发过矛盾中断的证据指纹集合(去重),避免同一条证据反复打断。
   */
  challengedFingerprints: string[];
  /**
   * 缺口1:该假设 confirm **之后**又被证据命中证伪条件的次数。
   *
   * 存在理由(fdb47f30 的原样复发):`falsifier` 被刻意设成不可修改(防"事后挪动靶子"),
   * 却没有任何机制防"提前宣布胜利"——两者达到完全相同的效果:让一个未充分验证的判断
   * 免于审查。而后者**更省事**:模型只要在证据不足时喊一声 confirm,就永久获得免疫,
   * harness 全程沉默。这个计数让"确认后又被打脸几次"进交付门禁文案,模型无法假装没看见。
   */
  challengedAfterConfirm: number;
  /**
   * 缺口1:已就该假设注入过"翻案中断"的次数(上限 MAX_REOPEN_CHALLENGES)。
   *
   * 与 challengedAfterConfirm 分开计:后者是**事实**(被打脸几次,永久累加,进门禁文案),
   * 前者是**打扰预算**(注入几次就够了)。合成一个会让"上限用尽"顺带把事实抹掉。
   */
  reopenChallengeCount: number;
  /**
   * 已被模型**复核过**的打脸次数(≤ challengedAfterConfirm)。
   *
   * 存在理由(2026-08-01 成本收益实测,会话 20260801-120158-d91920a0):
   * 此前 `challengedAfterConfirm` 只增不减,而交付门禁的闸门读的正是它
   * (`hasChallengedConfirmed()`)——于是一条假设只要被撞过一次,门禁对该会话
   * **永久武装**:模型复核后重新 confirm,闸门条件依然为真,下一次收尾再拦一遍。
   * 实测末尾 turn 64/66 连续两次拦截、turn 65/67 把三条已确认假设原地重confirm,
   * 4 轮零新增结论——这就是用户看到的"鬼打墙"。
   *
   * 修法不是把事实抹掉(那会丢掉门禁文案要的留痕),而是把「事实」与「是否已复核」
   * 分开:`challengedAfterConfirm` 仍永久累加,门禁只看**未复核**的差值
   * (`challengedAfterConfirm > challengesAcknowledged`)。语义因此完整:
   *   - 复核过 → 闸门放下,不再重复拦;
   *   - 复核后**又**来新证据 → 差值再次为正,闸门重新武装(防线未被削弱)。
   */
  challengesAcknowledged: number;
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
  /**
   * 裁决:确认 / 推翻 / 仍存疑(补充证据但不结案) / 翻案(缺口1)。
   *
   * `reopen`(缺口1)是 confirmed 的出口:被新证据挑战后可回到 open,重新受门禁约束。
   * 刻意**不**让 refuted 可翻案——两个方向风险不对称:refute 是保守方向(不会把猜测
   * 写成结论),confirm 是激进方向(会)。让 refuted 也能翻会引入"翻来覆去永不收敛"
   * 的新风险,收益却小(refuted 假设本就不会被写成结论)。
   */
  verdict: "confirm" | "refute" | "keep_open" | "reopen";
  /** 裁决依据(证据) */
  evidence: HypothesisEvidence;
  /**
   * 缺口4:本条证据的方向。仅对 `keep_open` / `reopen` 有意义——
   * confirm/refute 的方向由 verdict 自身决定(分别必为 supporting/refuting)。
   * 不给则落 `neutral`(见 EvidenceDirection 注释:硬塞进任一侧就是伪造信息)。
   */
  evidenceDirection?: EvidenceDirection;
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
  /**
   * 缺口1:该命中发生在假设已 confirmed 之后(=「翻案中断」而非普通矛盾中断)。
   *
   * 分档的唯一理由是**措辞**:模型在真实轨迹里会把机制提示读成指责并开始自我批判
   * (见缺口6),所以翻案文案必须框定为"确认后又出现了这些证据,请确认结论仍然成立",
   * 而不是"你确认错了"。行为上两者一样(都只是请模型裁决,不阻断)。
   */
  afterConfirm?: boolean;
}

const STOPWORDS = new Set([
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "或",
  "若",
  "则",
  "就",
  "不",
  "也",
  "这",
  "那",
  "它",
  "其",
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "to",
  "of",
  "in",
  "on",
  "at",
  "it",
  "its",
  "if",
  "then",
  "and",
  "or",
  "not",
  "be",
  "that",
  "this",
  "with",
  "为",
  "会",
  "被",
  "已",
  "可",
  "该",
  "等",
  "看到",
  "显示",
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
 * 缺口1:单条已确认假设最多注入几次「翻案中断」。
 *
 * 取 2 的理由:翻案中断的价值高度集中在**第一次**——它要做的事只是"请你确认结论
 * 仍然成立"。同一条假设被同类证据反复打断时,收益递减而成本线性增长,而反复打扰
 * 恰恰是本轮修复要避免的"多了步骤、没有收益"。给 2 次而非 1 次是留一次余量:
 * 第一次可能真是词面撞车,第二次来自不同证据时仍值得再问一遍。
 *
 * 注意:超预算只停**注入**,不停 `challengedAfterConfirm` 累加——事实必须留痕,
 * 它会进交付门禁文案("H3 已确认,但此后有 N 条证据命中其证伪条件")。
 */
export const MAX_REOPEN_CHALLENGES = 2;

/**
 * 缺口5:会话内 cue 词频抑制阈值(严格大于才抑制)。
 *
 * 取 6 = max(实测噪音 per-session 条数)+1,推导见 `shouldSuppressByFrequency` 注释。
 * 关键是**别取 5**:实测 `onrender`/`playwright` 恰好等于 5,阈值语义差一档就从
 * "不抑制"翻成"抑制"。取 6 保证任何 cue 都能先触发至少一次真中断再可能被静音。
 */
export const SESSION_CUE_FREQ_THRESHOLD = 6;

/**
 * 假设登记表机制总开关——**默认关闭**,设 `SID_ENABLE_HYPOTHESIS=1` 显式开启。
 *
 * 为什么默认关(2026-08-01 受控 A/B,fixture=/tmp/hyp-ab4,gpt-5.6-luna,ON/OFF 各 4 次):
 * 同一份受控仓库(设计文档声称 5 项全实现,真值 2 项落地 / 3 项分别是死代码、字段从不
 * 累加、条件恒 false),两臂对比结果:
 *
 *   臂    准确率      轮数    input      output    耗时
 *   ON    5.00/5      23.2    792,959    11,757    162s
 *   OFF   5.00/5      15.2    451,892     8,316    100s
 *   差      0        +52%      +75%       +41%     +61%
 *
 * ON 臂机制**全程活跃**(register 6.0 / challenge 6.0 / settled 6.0,交付门禁每次都
 * 触发,纯假设轮 10.0/23.2),但准确率一题都没多做对。即:多花 75% input、61% 墙钟,
 * 换来零质量增益。此前另一次单会话观测(20260801-120158-d91920a0)也显示它吃掉 31.4%
 * input,其中 42% 的裁决是"绕一圈回到同一结论"的空转。
 *
 * 与 SID_ENABLE_LOOP_DETECTION / SID_ENABLE_BARE_ELLIPSIS_CHECK 同范式:代码不删、
 * 仅默认关,需要时(接入行为不稳定的弱模型、或做长链根因排查)显式开启。留着代码是
 * 因为 A/B 只覆盖单一 fixture / 单模型 / n=4,不足以证明它**永远**无用;但"默认付费"
 * 需要正收益证据,而这个证据目前不存在。
 *
 * 命名从 SID_DISABLE_HYPOTHESIS 改为 SID_ENABLE_HYPOTHESIS:开关的默认值方向变了,
 * 沿用 DISABLE_ 前缀会让"不设任何 env"读起来像开启,与实际相反。
 */
export function isHypothesisEnabled(): boolean {
  return process.env.SID_ENABLE_HYPOTHESIS === "1";
}

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
  /**
   * 缺口5:cue → 本会话内"含该 cue 的证据条数"(document frequency)。
   *
   * 刻意**不**持久化:词频是"本会话语境"的度量,resume 后语境可能已完全不同,
   * 回灌旧频次等于让上个会话的语境永久静音这个 cue——那是把一个软抑制变成了硬删除。
   * 空表的降级方向是"多提醒一次",与本模块其它降级选择同向(宁可多提醒,不要哑火)。
   */
  private cueDocFreq = new Map<string, number>();
  /**
   * 缺口2 层次2:假设"续期"提醒是否已给过(会话级一次性,与 strategyNagged 同理由挂 ledger)。
   */
  private staleNagged = false;

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
      neutral: [],
      createdTurn: input.turn ?? 0,
      updatedTurn: input.turn ?? 0,
      challengedFingerprints: [],
      challengedAfterConfirm: 0,
      reopenChallengeCount: 0,
      challengesAcknowledged: 0,
    };
    this.items.set(id, h);
    return h;
  }

  /**
   * 裁决一条假设(机制2 的人/模型响应入口)。
   *
   * 返回 `{ h, redundant }`:`redundant=true` 表示这次裁决没有改变任何状态,也没有
   * 结清任何未复核的打脸——即"绕一圈回到同一结论"的空转(实测 26 次裁决里 11 次
   * 是这种,占 42%)。调用方据此回一句短提示而非完整登记表,省掉下一轮的往返。
   */
  challenge(input: ChallengeInput): { h: Hypothesis; redundant: boolean } {
    const h = this.items.get(input.id);
    if (!h) throw new Error(`未找到假设 ${input.id}`);
    const ev = { ...input.evidence, turn: input.evidence.turn ?? input.turn };
    // 空转判定必须在改状态**之前**取快照:状态未变 + 没有待复核的打脸 + 证据不是新的。
    const statusBefore = h.status;
    const pendingBefore = h.challengedAfterConfirm - h.challengesAcknowledged;
    const evFp = fingerprint(`${ev.note} ${ev.source ?? ""}`);
    const evidenceIsNew = !h.challengedFingerprints.includes(evFp);
    if (input.verdict === "confirm") {
      h.supporting.push(ev);
      h.status = "confirmed";
      // 关键修复:确认即视为"已复核这些打脸"。事实(challengedAfterConfirm)不动,
      // 只推进复核水位——门禁因此放下,而复核后新来的证据仍会让差值重新为正。
      h.challengesAcknowledged = h.challengedAfterConfirm;
    } else if (input.verdict === "refute") {
      h.refuting.push(ev);
      h.status = "refuted";
    } else if (input.verdict === "reopen") {
      // 缺口1:confirmed 的出口——被新证据挑战后退回 open,重新受交付门禁约束。
      // 允许从任何非 refuted 状态调用(在 open 上调等价于 keep_open,不报错更宽容:
      // 模型分不清"该 reopen 还是 keep_open"时不该被工具报错打断思路)。
      // refuted 刻意不可翻案(见 ChallengeInput.verdict 注释的风险不对称论证)。
      if (h.status === "refuted") {
        throw new Error(
          `${h.id} 已被推翻(refuted 是终态,不可翻案)。若确认此前的推翻有误,请登记一条新假设。`,
        );
      }
      this.pushDirectional(h, ev, input.evidenceDirection);
      h.status = "open";
    } else {
      // keep_open:补充证据但不结案(证据不足以定论)。
      // 缺口4:此前**无条件** push 进 refuting——模型想说"有些支持证据但还不够定论"
      // 时没有出口,支持证据被错记成反驳。现按显式方向落位,不给方向则落 neutral。
      this.pushDirectional(h, ev, input.evidenceDirection);
      h.status = "open";
    }
    h.updatedTurn = input.turn ?? h.updatedTurn;
    // 裁决后,把本条证据指纹记入已处理集合(防止同证据再次触发中断)
    if (evidenceIsNew) h.challengedFingerprints.push(evFp);
    // 空转 = 状态没变 + 本来就没有待复核的打脸 + 证据也不是新的。
    // 三个条件必须同时成立才算空转:状态变了是实质进展;有待复核打脸时的 confirm
    // 是"复核动作"(会推进 challengesAcknowledged),都不该被判为空转。
    const redundant = h.status === statusBefore && pendingBefore === 0 && !evidenceIsNew;
    return { h, redundant };
  }

  /**
   * 缺口4:按证据方向落位。方向缺省时进 `neutral`——不硬塞进 supporting/refuting。
   *
   * 为什么默认不是 refuting(旧行为):`keep_open` 的字面语义是"还不能定论",
   * 把它一律当反驳会让 `consecutiveRefutations()`(换策略判据)和交付门禁文案
   * 都读到伪造的方向信息,而这两处都会据此改变对模型的提示。
   */
  private pushDirectional(
    h: Hypothesis,
    ev: HypothesisEvidence,
    direction: EvidenceDirection | undefined,
  ): void {
    if (direction === "supporting") h.supporting.push(ev);
    else if (direction === "refuting") h.refuting.push(ev);
    else h.neutral.push(ev);
  }

  /**
   * 机制2 核心:用一段新证据文本,检测是否与任何**未被推翻**假设的 falsifier 线索矛盾。
   * 命中即返回(可能多条),由主循环据此注入矛盾中断。已就同一证据裁决过的不再触发。
   *
   * 缺口1:扫描范围由 `status === "open"` 放宽到 `status !== "refuted"`——
   *   - `open` → 照旧(普通矛盾中断);
   *   - `confirmed` → **纳入扫描**,命中产出 `afterConfirm: true` 的「翻案中断」;
   *   - `refuted` → 继续跳过(已排除的假设不必反复翻,且 refuted 不会被写成结论)。
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
        // 缺口1:refuted 是终态、不再挑战;open 与 confirmed 都要扫。
        if (h.status === "refuted") continue;
        if (h.challengedFingerprints.includes(fp)) continue; // 该证据已处理过
        // 同一轮内一条假设最多产出一条命中(多条 tool_result 都撞同一假设时不重复打扰)
        if (hits.some((x) => x.hypothesisId === h.id)) continue;
        const afterConfirm = h.status === "confirmed";
        // 缺口1:翻案中断的打扰预算(普通矛盾中断不受此限)。已确认的假设反复被同类
        // 词面撞车打断,收益递减而成本线性——超预算后仍累加 challengedAfterConfirm
        // (事实要留痕、进门禁文案),只是不再注入中断。
        if (afterConfirm && h.reopenChallengeCount >= MAX_REOPEN_CHALLENGES) {
          continue;
        }
        for (const cue of h.falsifierCues) {
          if (!cue || !hay.includes(cue)) continue;
          // 缺口5:会话内语境高频词抑制。cue 通过了静态长度门槛,但"够长"不等于
          // "在本任务语境里够特异"——实测 `onrender`×5 / `playwright`×5 /
          // `contextwindow`×3 都是长度合格却在本会话遍地出现的词。
          // 判据只看**本会话已见过多少条不同证据含该词**,首次命中永远放行(见
          // shouldSuppressByFrequency 的护栏说明)。
          if (this.shouldSuppressByFrequency(cue)) break;
          hits.push({
            hypothesisId: h.id,
            statement: h.statement,
            falsifier: h.falsifier,
            matchedCue: cue,
            evidenceSnippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
            ...(afterConfirm ? { afterConfirm: true } : {}),
          });
          // 记入指纹,避免下一轮同证据重复触发(本轮已会注入中断)
          h.challengedFingerprints.push(fp);
          if (afterConfirm) {
            // 事实(被打脸几次)与打扰预算(注入几次)分开计,见字段注释。
            h.challengedAfterConfirm += 1;
            h.reopenChallengeCount += 1;
          }
          break; // 一条假设命中一次即可
        }
      }
    }
    return hits;
  }

  /**
   * 缺口5:登记一批证据文本里出现过哪些 cue(会话内词频统计的输入)。
   *
   * 由主循环在每轮工具结果回流时调用,**与 detectContradictions 同一批文本**。
   * 统计口径是"含该 cue 的证据条数"而非"出现次数"——同一条 tool_result 里
   * `resize` 出现 30 次只算 1 条,否则一个长文件就能把任何 cue 打成"高频词"。
   */
  observeEvidence(evidence: string | string[]): void {
    const items = (Array.isArray(evidence) ? evidence : [evidence]).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (items.length === 0) return;
    // 只统计"当前登记表里真的在用的 cue",避免为无关词无限增长这张表。
    const activeCues = new Set<string>();
    for (const h of this.items.values()) {
      for (const cue of h.falsifierCues) if (cue) activeCues.add(cue);
    }
    if (activeCues.size === 0) return;
    for (const text of items) {
      if (isEmptyResultText(text)) continue;
      const hay = text.toLowerCase();
      for (const cue of activeCues) {
        if (hay.includes(cue)) {
          this.cueDocFreq.set(cue, (this.cueDocFreq.get(cue) ?? 0) + 1);
        }
      }
    }
  }

  /**
   * 缺口5:该 cue 是否已被本会话语境证明为"高频泛化词",本次命中应跳过。
   *
   * 两条护栏(缺一不可,否则这个自适应会自己变成新的漏报源):
   *   1. **只跳过本次命中,绝不删 cue**——词频是会话内的、可能只是某个阶段的语境,
   *      删掉就永久失去检测能力,而漏报正是本模块最怕的失效方向(fdb47f30 的形态)。
   *   2. **首次命中永远放行**：判据用 `> SESSION_CUE_FREQ_THRESHOLD` 且统计发生在
   *      检测**同批**文本上,含该 cue 的当前这批已计入频次。阈值取 6 保证一条 cue
   *      至少能触发一次真中断后才可能被抑制——「一次都没提醒过就被静音」是不可接受的。
   *
   * 阈值 6 的推导(设计文档 §2.5 实测的残留噪音分布):真实语料里 per-session
   * 含 cue 证据条数最高的是 `onrender`=5 / `playwright`=5 / `prevscreen`=4 /
   * `handleresize`=4 / `contextwindow`=3。取 6 = max(实测噪音)+1,意味着**本次改动
   * 对已知噪音样本一次都不抑制**——刻意保守:抑制的是"比已知最坏情况还泛化"的词。
   * 文档目测的 5 会把 `onrender`/`playwright` 卡在边界(它们恰好等于 5,`> 5` 不成立、
   * `>= 5` 成立),阈值语义差一档就从"不抑制"翻成"抑制",故明确写成 `>` 且取 6。
   */
  private shouldSuppressByFrequency(cue: string): boolean {
    return (this.cueDocFreq.get(cue) ?? 0) > SESSION_CUE_FREQ_THRESHOLD;
  }

  /** 缺口5:只读快照,供单测与离线核对(不暴露内部 Map 引用)。 */
  cueFrequencySnapshot(): Record<string, number> {
    return Object.fromEntries(this.cueDocFreq);
  }

  /** 机制3:交付门禁——返回仍为 open / refuted 的假设(不得作为结论交付) */
  unsettled(): Hypothesis[] {
    return [...this.items.values()].filter((h) => h.status !== "confirmed");
  }

  /**
   * 缺口1:已确认、但确认之后又被证据命中证伪条件的假设。
   *
   * 交付门禁的**第二道闸门**:`hasUnsettled()` 口径刻意不变(confirmed 仍不算未结清,
   * 否则每条确认假设都会拦一道、正常交付被误伤),但"确认后又被打脸"的假设必须单独拦
   * ——这正是"提前宣布胜利"绕过审查的那扇后窗。
   *
   * 2026-08-01(成本收益实测)口径修正:判据从"被打脸过"改为"有**未复核**的打脸"
   * ——`challengedAfterConfirm > challengesAcknowledged`。旧口径只增不减,让门禁在
   * 一条假设被撞一次后对整个会话永久武装:模型复核并重新 confirm 后闸门依然为真,
   * 下次收尾再拦一遍(实测末尾连拦 2 次、4 轮零新增结论)。改成差值后语义完整:
   * 复核过就放下,复核后又来新证据则重新武装。
   */
  challengedConfirmed(): Hypothesis[] {
    return [...this.items.values()].filter(
      (h) => h.status === "confirmed" && h.challengedAfterConfirm > h.challengesAcknowledged,
    );
  }

  /** 缺口1:是否存在"确认后又被证据挑战过、且尚未复核"的假设(门禁闸门用)。 */
  hasChallengedConfirmed(): boolean {
    for (const h of this.items.values()) {
      if (h.status === "confirmed" && h.challengedAfterConfirm > h.challengesAcknowledged) {
        return true;
      }
    }
    return false;
  }

  /** 缺口2:所有已被推翻的假设(供"交付物是否复用了已推翻说法"检查)。 */
  refutedItems(): Hypothesis[] {
    return [...this.items.values()].filter((h) => h.status === "refuted");
  }

  /** 缺口2:登记表里最后一次 hypothesis 操作发生的轮次（用 updatedTurn 的最大值）。 */
  lastActivityTurn(): number {
    let max = 0;
    for (const h of this.items.values()) {
      if (h.updatedTurn > max) max = h.updatedTurn;
      if (h.createdTurn > max) max = h.createdTurn;
    }
    return max;
  }

  /**
   * 缺口2 层次2:判定「该给假设续期提醒了吗」,并在返回 true 时**就地置位**一次性标志。
   *
   * 与 claimStrategyNag 同款「判据+置位原子」设计:分开会让调用方漏置位就每 N 轮刷屏、
   * 错置位就永久哑火。
   *
   * 判据(三条同时满足):
   *   1. 登记表**非空**——从不用这套机制的会话不该被打扰(占全量 68 会话的 89.7%);
   *   2. 距末次假设操作已超 staleTurns 轮;
   *   3. 尚未给过(会话级一次性)。
   *
   * 刻意**不**要求"有未结清假设":假设全部结清后的空转期恰恰是风险最高的阶段
   * (设计文档 §2.3:假设集中在会话前 1/4 结清,之后 32-65 轮登记表完全空转,
   * 而那正是改代码+写交付物的阶段)。
   */
  claimStaleNag(currentTurn: number, staleTurns: number): boolean {
    if (this.staleNagged) return false;
    if (this.items.size === 0) return false;
    const last = this.lastActivityTurn();
    if (currentTurn - last < staleTurns) return false;
    this.staleNagged = true;
    return true;
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
    // 缺口2 层次2：续期提醒同理由随 /clear 清零。
    this.staleNagged = false;
    // 缺口5：词频是"本会话语境"的度量，/clear 后语境重置，频次表必须一并清空——
    // 否则清空对话后旧语境仍在静音某些 cue（软抑制退化成隐形的硬删除）。
    this.cueDocFreq.clear();
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
  serialize(): {
    seq: number;
    items: Hypothesis[];
    strategyNagged?: boolean;
    staleNagged?: boolean;
  } {
    return {
      seq: this.seq,
      // 缺陷3：一次性标志随快照走。理由与 items 持久化同源——跨会话续做同一排查时
      // （`-c` 恢复），若标志不回灌，上个会话已给过的换策略提示会再给一次，
      // 而文案明写"本提醒只出现一次"。
      strategyNagged: this.strategyNagged,
      // 深拷贝,防止外部改写快照污染内部状态(与 TodoWriteTool.serialize 同款纪律)
      // 缺口2 层次2：续期提醒的一次性标志同理由随快照走（否则 `-c` 恢复后重复提醒）。
      staleNagged: this.staleNagged,
      // 深拷贝,防止外部改写快照污染内部状态(与 TodoWriteTool.serialize 同款纪律)
      items: [...this.items.values()].map((h) => ({
        ...h,
        falsifierCues: [...h.falsifierCues],
        supporting: h.supporting.map((e) => ({ ...e })),
        refuting: h.refuting.map((e) => ({ ...e })),
        // 缺口4：neutral 与 supporting/refuting 同等持久化——它承载"证据不足以定论"
        // 这个有信息量的事实，丢了就等于 resume 后把存疑证据当无证据。
        neutral: h.neutral.map((e) => ({ ...e })),
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
  hydrate(
    snapshot:
      | { seq?: unknown; items?: unknown; strategyNagged?: unknown; staleNagged?: unknown }
      | undefined
      | null,
  ): void {
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
        falsifierCues: Array.isArray(h.falsifierCues)
          ? h.falsifierCues.filter((c): c is string => typeof c === "string")
          : [],
        status: h.status,
        supporting: Array.isArray(h.supporting)
          ? h.supporting.filter(
              (e): e is HypothesisEvidence =>
                !!e && typeof e === "object" && typeof (e as HypothesisEvidence).note === "string",
            )
          : [],
        refuting: Array.isArray(h.refuting)
          ? h.refuting.filter(
              (e): e is HypothesisEvidence =>
                !!e && typeof e === "object" && typeof (e as HypothesisEvidence).note === "string",
            )
          : [],
        // 缺口4：旧快照没有 neutral 字段 → 回灌为空数组（安全降级：只是少了存疑证据的
        // 展示，不影响任何判据；绝不把旧的 refuting 内容挪过来伪造方向）。
        neutral: Array.isArray(h.neutral)
          ? h.neutral.filter(
              (e): e is HypothesisEvidence =>
                !!e && typeof e === "object" && typeof (e as HypothesisEvidence).note === "string",
            )
          : [],
        createdTurn: typeof h.createdTurn === "number" ? h.createdTurn : 0,
        updatedTurn: typeof h.updatedTurn === "number" ? h.updatedTurn : 0,
        challengedFingerprints: Array.isArray(h.challengedFingerprints)
          ? h.challengedFingerprints.filter((f): f is string => typeof f === "string")
          : [],
        // 缺口1：旧快照缺字段 → 0。降级方向是"确认后被打脸的历史丢了、门禁不拦"，
        // 与 strategyNagged 缺字段时的选择一致：宁可漏一次提醒，不要凭空造出一次拦截。
        challengedAfterConfirm:
          typeof h.challengedAfterConfirm === "number" && h.challengedAfterConfirm >= 0
            ? h.challengedAfterConfirm
            : 0,
        // 打扰预算刻意**不**从快照恢复语义上的"已用尽"——resume 是新一段排查，
        // 让每条已确认假设重新有 MAX_REOPEN_CHALLENGES 次机会。同样是"宁可多提醒"。
        reopenChallengeCount: 0,
        // 复核水位如实回灌:它与 challengedAfterConfirm 成对决定门禁是否武装。
        // 只回灌其中一个会造出假状态——单独丢 acknowledged 会让 resume 后凭空多出
        // 一次拦截(旧会话已复核过的打脸重新变成"未复核")。缺字段时按 0 降级，
        // 并 clamp 到 challengedAfterConfirm 以内，防手改快照造出负差值。
        challengesAcknowledged: Math.min(
          typeof h.challengesAcknowledged === "number" && h.challengesAcknowledged >= 0
            ? h.challengesAcknowledged
            : 0,
          typeof h.challengedAfterConfirm === "number" && h.challengedAfterConfirm >= 0
            ? h.challengedAfterConfirm
            : 0,
        ),
      });
      // 从 id(形如 "H3")提取编号,兜底 seq
      const m = /^H(\d+)$/.exec(h.id);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    this.items = restored;
    const snapSeq =
      typeof (snapshot as { seq?: unknown }).seq === "number"
        ? (snapshot as { seq: number }).seq
        : 0;
    this.seq = Math.max(snapSeq, maxSeq);
    // 缺陷3：一次性标志回灌（缺字段的旧快照 → false，即恢复后仍有一次提示机会，
    // 这是安全的降级方向：宁可多给一次有用提示，不要静默哑火）。
    if ((snapshot as { strategyNagged?: unknown }).strategyNagged === true) {
      this.strategyNagged = true;
    }
    // 缺口2 层次2：续期提醒的一次性标志同款回灌（缺字段 → false，即恢复后仍有一次机会）。
    if ((snapshot as { staleNagged?: unknown }).staleNagged === true) {
      this.staleNagged = true;
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
  // 缺口1:把「已确认假设被打脸」单独分段。行为上两者一样(都只是请模型裁决、不阻断),
  // 分档的唯一理由是**措辞**——模型在真实轨迹里会把机制提示读成指责并开始自我批判
  // (缺口6),所以翻案段必须框定成"请确认结论仍然成立",而不是"你确认错了"。
  const plain = hits.filter((h) => !h.afterConfirm);
  const afterConfirm = hits.filter((h) => h.afterConfirm);
  const fmt = (h: ContradictionHit) =>
    `- ${h.hypothesisId}「${h.statement}」的证伪条件是:${h.falsifier}\n` +
    `  刚出现的证据命中了它的关键线索「${h.matchedCue}」:${h.evidenceSnippet}`;

  const sections: string[] = [];
  if (plain.length > 0) {
    sections.push(
      `以下新证据的文本命中了你之前登记假设的证伪条件线索,\n` +
        `可能与假设相关,也可能只是词面撞车——请你自己判断。\n\n${plain.map(fmt).join("\n")}\n\n` +
        `如果你判断证据确实与某条假设相关,可用 hypothesis_challenge 更新其状态:\n` +
        `- 证据推翻了假设 → verdict=refute(这是有价值的纠偏,不是失败);\n` +
        `- 证据不足以定论 → verdict=keep_open(可用 evidence_direction 标明这条证据偏支持还是偏反驳);\n` +
        `- 证据其实支持假设或只是词面撞车、不构成矛盾 → 可忽略本提醒,或按需 confirm/keep_open。`,
    );
  }
  if (afterConfirm.length > 0) {
    sections.push(
      `下面这些假设你**已经确认过**,但之后又出现了命中其证伪条件线索的证据:\n\n` +
        `${afterConfirm.map(fmt).join("\n")}\n\n` +
        `这不是说你确认错了——多半只是词面撞车。只需确认一下当初的结论在这些新证据下仍然成立:\n` +
        `- 结论仍成立(证据无关/其实支持) → 无需任何动作,继续即可;\n` +
        `- 新证据确实动摇了它 → hypothesis_challenge verdict=reopen 退回 open,重新取证;\n` +
        `- 已能直接推翻 → verdict=refute。\n` +
        `早期确认的结论在后续证据面前复核一次,是这套机制存在的原因:确认不该等于免于审查。`,
    );
  }

  return `<system-reminder>
提示(请勿向用户提及本提醒):

${sections.join("\n\n")}

本提醒仅供参考,不要求你中断当前工作;若无关可直接继续。
</system-reminder>`;
}

/**
 * 机制3:构造"交付门禁"system-reminder。
 *
 * 模型试图收尾(end_turn)但仍有 open/refuted 假设未结清时注入,阻止它把未证实的假设
 * 当结论交付。对齐 todo 完成度门禁的思路,但门的是"结论的证据成色"而非"任务完成度"。
 */
export function buildDeliveryGateReminder(
  unsettled: Hypothesis[],
  /**
   * 缺口1:已确认但确认后又被证据挑战过的假设。空数组时文案与旧版等价
   * (调用方不传即保持向后兼容)。
   */
  challengedConfirmed: Hypothesis[] = [],
): string {
  const sections: string[] = [];
  if (unsettled.length > 0) {
    const lines = unsettled.map((h) => `- ${h.id} [${h.status}]「${h.statement}」`);
    sections.push(
      `假设登记表中仍有 ${unsettled.length} 条假设未被确认(状态为 open 或 refuted):\n` +
        `${lines.join("\n")}\n\n` +
        `机制3 交付门禁:**未确认的假设不得作为结论写进最终交付物。**\n` +
        `请逐条处理:\n` +
        `- 还能验证的 → 去取证后用 hypothesis_challenge 裁决;\n` +
        `- 已被推翻(refuted)的 → 不要写进结论,或明确标注"此前假设已被证伪";\n` +
        `- 确实无法定论的 → 在交付物里如实降级为"待验证",不要伪装成已确认的根因。`,
    );
  }
  if (challengedConfirmed.length > 0) {
    // 缺口1:让"确认后被打脸"这个事实进门禁文案。此前 confirmed 是单向吸收态,
    // 模型只要在证据不足时喊一声 confirm 就永久免疫审查(比"事后挪动靶子"更省事,
    // 而后者是被刻意禁止的)。这段不阻止交付,只要求结论对得上证据。
    const lines = challengedConfirmed.map(
      (h) =>
        `- ${h.id}「${h.statement}」:确认后有 ${h.challengedAfterConfirm} 条证据命中过它的证伪条件` +
        `(证伪条件:${h.falsifier})`,
    );
    sections.push(
      `另有 ${challengedConfirmed.length} 条**已确认**假设,在确认之后又被证据命中过证伪条件:\n` +
        `${lines.join("\n")}\n\n` +
        `交付前请确认这些结论仍然站得住:\n` +
        `- 复核后仍成立 → 直接交付即可,无需额外动作;\n` +
        `- 当初确认得过早、证据其实不足 → hypothesis_challenge verdict=reopen 退回 open,` +
        `或 verdict=refute 推翻,并据此改写结论。\n` +
        `确认过的判断在新证据面前复核一次不是走形式:把没验证充分的结论写成根因,` +
        `正是这套机制要防的那类错误。`,
    );
  }
  if (sections.length === 0) return "";
  return `<system-reminder>
你正准备收尾,但假设登记表还有需要处理的地方:

${sections.join("\n\n")}
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

// ─────────────────── 缺口2:门禁与交付物挂钩 ───────────────────

/**
 * 缺口2 层次2:假设登记表"空转"多少轮后给一次续期提醒。
 *
 * 取 20 的依据(设计文档 §2.3 换算成会话内绝对轮次后的尾部空转实测):
 * `162226`=44 轮 / `172113`=56 轮 / `144806`=65 轮 / `180029`=32 轮。
 * 也就是说假设集中在会话**前 1/4** 结清,之后几十轮登记表完全空转——而那几十轮
 * 恰恰是改代码、写交付物的阶段,也是"把未验证判断写成结论"最可能发生的阶段。
 *
 * 20 是"已经明显空转、但还没滑到交付"的位置:实测最小空转样本是 32 轮,取 20
 * 能在最短的那条轨迹上也提前十几轮命中;再小(如 10)会打扰正常的"登记完就去实现"节奏。
 */
export const HYPOTHESIS_STALE_TURNS = 20;

/**
 * 缺口2 层次2:构造"假设登记表已空转"的续期提醒。
 *
 * 定位:这是**唯一**在"会话中段"提醒假设纪律的机制。此前三道闸门全部集中在
 * 「登记时」和「收尾时」,中间几十轮无人看管——模型在这段里形成的新判断不会经过
 * 登记,于是三道机制对它们全部失效(不是防线被绕过,是它们从未进入防线视野)。
 *
 * 措辞刻意轻量、且明说可忽略:空转本身不是错误(假设都结清了很正常),
 * 它只是一个"要不要把新形成的判断也登记一下"的时机提示。会话级只给一次。
 */
export function buildStaleLedgerReminder(idleTurns: number, total: number): string {
  return `<system-reminder>
提示(请勿向用户提及本提醒):你已登记过 ${total} 条假设,但最近约 ${idleTurns} 轮没有任何
假设登记/裁决动作,而这期间你仍在读代码、改代码。

这不是问题,只是一个时机提示:这几十轮里你很可能又形成了新的判断(某处代码是这样工作的、
某个改动能修掉问题)。这类判断如果没登记,就不会被证伪检测和交付门禁看到——三道机制
对它们是完全失效的,不是被绕过,而是从未进入视野。

如果手上确实有还没验证的判断,值得 hypothesis_register 登记一下;
如果当前工作已经是在执行确定的方案、没有待验证判断,忽略本提醒即可。本提醒只出现一次。
</system-reminder>`;
}

/**
 * 缺口2 层次1:从一条已推翻假设的 statement 里提取"足够具体、可用于文本匹配"的标识符。
 *
 * 复用 `sanitizeExplicitCues` 的泛化门槛(而不是另造一套):这个门槛的整个存在理由就是
 * "把一碰就中的泛化词筛掉",而本处要防的误报形态与矛盾检测完全同类——用 statement 里的
 * `config`/`output` 这种词去匹配交付物,必然全中。共用门槛也保证两处口径不会各自漂移。
 */
export function refutedStatementIdentifiers(h: Hypothesis): string[] {
  // statement 是自然语言句子,先按 extractCues 的口径拿到长片段/长标识符,
  // 再过一遍 sanitizeExplicitCues 的门槛(extractCues 已含门槛,这里是双保险且去重)。
  return sanitizeExplicitCues(extractCues(h.statement));
}

/** 缺口2 层次1:一条"已推翻说法可能被复用进交付物"的命中。 */
export interface RefutedReuseHit {
  hypothesisId: string;
  statement: string;
  /** 命中的具体标识符(不是整句,便于模型定位) */
  matchedIdentifier: string;
}

/**
 * 缺口2 层次1:检查交付物文本里是否复用了已推翻假设的具体说法。
 *
 * 为什么必须做这一层:三道机制全部作用在**登记表状态**上,没有任何一处看过模型
 * 实际写出去的字。真实轨迹里(`142920`)H1-H6 全 refuted,而门禁只问"假设结清了吗",
 * 不问"你交付物里那段结论是不是就是刚才被推翻的 H3"——被推翻的说法可以原样写进
 * 交付物而不触发任何检查,机制3 的"不得作为结论交付"因此只是**声明**,不是**校验**。
 *
 * 判据刻意保守(宁可漏报不误报,误报会让模型怀疑自己写对的东西):
 *   - 只用过了泛化门槛的具体标识符,不做语义匹配;
 *   - 每条假设最多产出一条命中;
 *   - 输出是**疑问句**而非断言(见 buildRefutedReuseReminder)——匹配到标识符不等于
 *     真的复用了错误结论,模型完全可能是在写"H3 已被证伪"这种如实标注。
 */
export function detectRefutedReuse(
  refuted: Hypothesis[],
  deliverableText: string,
): RefutedReuseHit[] {
  if (!deliverableText || refuted.length === 0) return [];
  const hay = deliverableText.toLowerCase();
  const hits: RefutedReuseHit[] = [];
  for (const h of refuted) {
    for (const id of refutedStatementIdentifiers(h)) {
      if (id && hay.includes(id)) {
        hits.push({ hypothesisId: h.id, statement: h.statement, matchedIdentifier: id });
        break; // 一条假设一条命中即可,不刷屏
      }
    }
  }
  return hits;
}

/**
 * 缺口2 层次1:构造"交付物疑似复用已推翻说法"的提醒。
 *
 * 全文用疑问句、且明说"可能只是词面重合":匹配到标识符**不等于**复用了错误结论——
 * 模型可能正在如实标注"此前 H3 假设已被证伪"(那恰恰是门禁要求的正确做法)。
 * 断言式措辞会让模型怀疑自己写对的东西,那是负收益。
 */
export function buildRefutedReuseReminder(hits: RefutedReuseHit[]): string {
  const lines = hits.map(
    (h) => `- ${h.hypothesisId}「${h.statement}」(交付物里出现了其中的「${h.matchedIdentifier}」)`,
  );
  return `<system-reminder>
提示(请勿向用户提及本提醒):你刚写出的内容里出现了一些字眼,与此前**已被推翻**的假设有重合:

${lines.join("\n")}

这可能只是词面重合(比如你正在如实说明"该假设已被证伪",那完全正确),也可能是
被推翻的说法又被当成结论写了进去。请自查一下:交付物里这部分表述,是否仍把上面
这些已证伪的判断当作成立的结论?

- 若只是词面重合或已如实标注 → 无需任何动作;
- 若确实复用了已推翻的说法 → 请改写该处,或明确标注它已被证伪。
</system-reminder>`;
}
