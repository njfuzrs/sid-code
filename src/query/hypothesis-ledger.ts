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
 *
 * 2026-07-07 约束型误伤修复(Top 5):收紧 cue 提取,要求线索词更长更具体。
 * 此前中文 2 字片段(如"崩溃/进程/存活")+ 英文 3 字 token 做朴素 `includes` 子串匹配,
 * 高频通用词几乎必然命中任意后续工具输出,且 detectContradictions 不判断语义方向——
 * 证据其实在**支持**假设也会被当成"矛盾"触发中断。要求更长的 cue 大幅降低这种误命中:
 *   - 中文:只取整段(≥4 连续汉字),不再加 2-3 字短片段、不再加 4 字前缀;
 *   - 英文/数字 token:长度≥5(过滤掉 err/pid/cpu 等极易撞车的短词)。
 * 仍是粗召回而非精确 NLP,但把"高频短词一碰就中"的最大误伤面收掉。
 */
export function extractCues(falsifier: string): string[] {
  if (!falsifier) return [];
  const cues = new Set<string>();
  // 英文/数字 token(长度≥5,过滤极短易撞车词)
  for (const m of falsifier.toLowerCase().matchAll(/[a-z_][a-z0-9_]{4,}/g)) {
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

  /**
   * 序列化登记表为可持久化快照(写入会话 JSONL 的 hypothesis_ledger metadata,resume 回灌)。
   *
   * 根因:items/seq 是纯内存态,此前从未持久化也从未回灌——跨会话续做同一排查时(`-c` 恢复),
   * 登记表全新为空,机制3「交付门禁」失去依据:上一会话登记的 open/refuted 假设不再拦截交付,
   * 模型可能把未证实的假设当结论写出去(正是本模块要防的 fdb47f30 事故模式)。
   *
   * 全量存储 items(含证据链/证伪线索/状态)+ seq(保持 id 单调递增,避免恢复后 register 撞号)。
   */
  serialize(): { seq: number; items: Hypothesis[] } {
    return {
      seq: this.seq,
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
  hydrate(snapshot: { seq?: unknown; items?: unknown } | undefined | null): void {
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
