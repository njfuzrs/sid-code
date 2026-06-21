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
 * 从 falsifier 文本提取关键线索词(机制2 的匹配基础)。
 * 朴素策略:抽取中文 2+ 连续字片段 + 英文/数字单词(长度≥3),去停用词与纯数字。
 * 目标是召回潜在矛盾(宁可多触发让模型裁决,也不漏掉),不是精确 NLP。
 */
export function extractCues(falsifier: string): string[] {
  if (!falsifier) return [];
  const cues = new Set<string>();
  // 英文/数字 token
  for (const m of falsifier.toLowerCase().matchAll(/[a-z_][a-z0-9_]{2,}/g)) {
    const w = m[0];
    if (!STOPWORDS.has(w)) cues.add(w);
  }
  // 中文 2-6 字片段(滑窗,粗召回)
  for (const seg of falsifier.split(/[^一-龥]+/)) {
    if (seg.length < 2) continue;
    // 取整段 + 前 4 字,兼顾长短匹配
    if (!STOPWORDS.has(seg)) cues.add(seg);
    if (seg.length > 4) cues.add(seg.slice(0, 4));
  }
  return [...cues];
}

/** 稳定指纹:用于证据去重,避免同一证据反复触发中断 */
function fingerprint(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim().toLowerCase();
  return clean.slice(0, 120);
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
    const cues =
      input.falsifierCues && input.falsifierCues.length > 0
        ? input.falsifierCues.map((c) => c.toLowerCase())
        : extractCues(falsifier);
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
  detectContradictions(evidenceText: string): ContradictionHit[] {
    if (!evidenceText) return [];
    const hay = evidenceText.toLowerCase();
    const fp = fingerprint(evidenceText);
    const hits: ContradictionHit[] = [];
    for (const h of this.items.values()) {
      if (h.status !== "open") continue; // 只挑战未结案的
      if (h.challengedFingerprints.includes(fp)) continue; // 该证据已处理过
      for (const cue of h.falsifierCues) {
        if (cue && hay.includes(cue)) {
          hits.push({
            hypothesisId: h.id,
            statement: h.statement,
            falsifier: h.falsifier,
            matchedCue: cue,
            evidenceSnippet: evidenceText.replace(/\s+/g, " ").trim().slice(0, 200),
          });
          // 记入指纹,避免下一轮同证据重复触发(本轮已会注入中断)
          h.challengedFingerprints.push(fp);
          break; // 一条假设命中一次即可
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

  /** 当前轮次有 open 假设(供交付门禁提醒判定) */
  hasOpen(): boolean {
    for (const h of this.items.values()) if (h.status === "open") return true;
    return false;
  }

  /** /clear 时重置 */
  reset(): void {
    this.items.clear();
    this.seq = 0;
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
⚠️ 矛盾中断(请勿向用户提及本提醒):新证据可能与你之前登记的假设相矛盾。

${lines.join("\n")}

这是抗沉没成本的关键时刻。请**立即**用 hypothesis_challenge 对上述每条假设显式裁决:
- 若证据确实推翻了假设 → verdict=refute(这是有价值的纠偏,不是失败);
- 若证据不足以定论 → verdict=keep_open;
- 若你判断证据其实不构成矛盾 → 也要 verdict=confirm 或 keep_open 并说明理由。
不要忽略这条矛盾、继续按原结论推进。先裁决,再往下走。
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
