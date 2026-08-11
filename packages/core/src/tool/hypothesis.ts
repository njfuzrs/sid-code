/**
 * Hypothesis 工具 —— 假设登记表的模型操作入口(环节③ 机制1 + 机制2 响应)
 *
 * 两个工具共享一个 HypothesisLedger 实例(构造时注入),与 TodoWriteTool 的模块状态同构:
 *   - hypothesis_register:登记假设,强制带证伪条件(机制1)。
 *   - hypothesis_challenge:对某条假设做裁决 confirm/refute/keep_open(机制2 的响应端)。
 *
 * 主循环(query/loop.ts)负责机制2 的触发端:每轮工具结果回流后,用新证据扫 open 假设的
 * falsifier 线索,命中则注入"矛盾中断"system-reminder,逼模型来调 hypothesis_challenge 裁决。
 *
 * 设计意图:把"怀疑自己的假设"这件最反人性的事,从模型自觉变成可调用、可校验、可门禁的工具动作。
 */

import type { LegacyTool as Tool, LegacyToolResult as ToolResult } from "./types.ts";
import { z } from "zod/v4";
import { lazySchema } from "../sdk/lazy-schema.ts";
import { HypothesisLedger, type Hypothesis } from "../query/hypothesis-ledger.ts";

const registerSchema = lazySchema(() =>
  z.object({
    statement: z.string().describe("假设描述,如 'fdb47f30 会话因进程崩溃而中断'"),
    falsifier: z
      .string()
      .describe(
        "证伪条件(必填):看到什么证据就能推翻这个假设。如 '若 ps 显示进程仍存活,则推翻崩溃假设'。" +
          "无法被证伪的不是假设,是信念——会被拒绝登记。",
      ),
    falsifier_cues: z
      .array(z.string())
      .optional()
      .describe("可选:证伪条件的关键线索词(用于自动匹配矛盾证据)。不填则从 falsifier 文本自动提取。"),
    supporting_evidence: z
      .array(
        z.object({
          note: z.string().describe("支持证据描述"),
          source: z.string().optional().describe("出处:file:line / 命令 / 工具输出"),
        }),
      )
      .optional()
      .describe("当前已有的支持证据(可选)"),
  }),
);

const challengeSchema = lazySchema(() =>
  z.object({
    id: z.string().describe("被裁决的假设 id,如 H1"),
    verdict: z
      .enum(["confirm", "refute", "keep_open", "reopen"])
      .describe(
        "裁决:confirm=证据确认成立 / refute=证据推翻 / keep_open=补充证据但证据不足以定论 / " +
          "reopen=此前已确认,但新证据动摇了它,退回 open 重新取证",
      ),
    evidence: z.object({
      note: z.string().describe("裁决依据(证据)"),
      source: z.string().optional().describe("出处:file:line / 命令 / 工具输出"),
    }),
    // 缺口4:keep_open/reopen 的证据方向。此前 keep_open 无条件把证据记进 refuting,
    // 于是"我有些支持证据但还不够定论"这个最常见的处境**没有出口**——模型只能在
    // confirm/refute 里二选一,而二元化会把"证据不足"推向 confirm(refute 意味着放弃线索)。
    evidence_direction: z
      .enum(["supporting", "refuting", "neutral"])
      .optional()
      .describe(
        "可选(仅 keep_open/reopen 有意义):这条证据偏支持还是偏反驳假设。" +
          "不填则记为 neutral(方向未定)。confirm/refute 的方向由 verdict 本身决定,无需填写。",
      ),
  }),
);

function fmtHypothesis(h: Hypothesis): string {
  const statusIcon = h.status === "confirmed" ? "✅" : h.status === "refuted" ? "❌" : "🔍";
  const lines = [
    `${statusIcon} ${h.id} [${h.status}] ${h.statement}`,
    `   证伪条件: ${h.falsifier}`,
  ];
  if (h.supporting.length) lines.push(`   支持(${h.supporting.length}): ${h.supporting.map((e) => e.note).join("; ")}`);
  if (h.refuting.length) lines.push(`   反驳(${h.refuting.length}): ${h.refuting.map((e) => e.note).join("; ")}`);
  return lines.join("\n");
}

/** hypothesis_register —— 机制1:登记假设 + 强制预注册证伪条件 */
export class HypothesisRegisterTool implements Tool {
  readonly zodSchema = registerSchema();
  private ledger: HypothesisLedger;
  private turnProvider: () => number;

  constructor(ledger?: HypothesisLedger, turnProvider?: () => number) {
    // ledger 缺省时自建一个;challenge 工具通过 getLedger() 复用同一实例。
    this.ledger = ledger ?? new HypothesisLedger();
    this.turnProvider = turnProvider ?? (() => 0);
  }

  /** 暴露登记表实例,供 challenge 工具复用 + queryLoop 经 deps.getHypothesisLedger 读取。 */
  getLedger(): HypothesisLedger {
    return this.ledger;
  }

  /**
   * 缺口8:延迟接线轮次取值器(理由同 HypothesisChallengeTool.setTurnProvider)。
   *
   * register 侧同样需要:`createdTurn` 恒为 0 时,`ageInTurns` 拿不到有效基准,
   * "假设从登记到裁决跨了几轮"这个度量就永远是空的。
   */
  setTurnProvider(fn: () => number): void {
    this.turnProvider = fn;
  }

  name(): string {
    return "hypothesis_register";
  }

  description(): string {
    return `登记一条排查/根因假设到假设登记表,**强制预注册证伪条件**。

## 何时使用
排查问题、定位根因、出修复方案时,**每当你形成一个"我认为是 X 导致的"判断,先登记它**,而不是直接当结论往下写。
这能防止两类典型错误:① 早早锁定一个叙事,后续证据与之矛盾却视而不见;② 把没验证的猜测当事实交付。
**对照文档核查代码是否落地、审计某机制是否生效、逐项核验一组条目时同样适用**:每当你要对某文件下"已落地/未落地""存在/不存在某逻辑"这类事实结论,先把它登记为假设再去 read 核实,不要凭 grep 命中直接外推成结论。

## 关键约束(机制1:预注册证伪)
- \`falsifier\`(证伪条件)**必填**:你必须说清"看到什么证据就推翻这个假设"。无法被证伪的判断会被拒绝登记。
- 证伪条件一经登记**不可修改**——防止事后挪动靶子把猜测硬说成对的。
- 登记后,harness 会在后续每轮工具结果里自动扫描:一旦新证据命中你的证伪条件线索,会**强制中断**要求你用 hypothesis_challenge 裁决。

## 示例
statement: "index 23 无响应是因为进程崩溃了"
falsifier: "若 ps -p <pid> 显示进程仍存活,或 heartbeat 仍在跳动,则推翻崩溃假设"

登记后你会拿到假设 id(如 H1),后续用 hypothesis_challenge 对它裁决。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(registerSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true; // 仅写内存登记表,不碰文件系统/外部,plan 模式下也应可用
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const p = input as {
      statement?: string;
      falsifier?: string;
      falsifier_cues?: string[];
      supporting_evidence?: { note: string; source?: string }[];
    };
    try {
      const turn = this.turnProvider();
      const h = this.ledger.register({
        statement: p.statement ?? "",
        falsifier: p.falsifier ?? "",
        falsifierCues: p.falsifier_cues,
        supporting: (p.supporting_evidence ?? []).map((e) => ({ ...e, turn })),
        turn,
      });
      return {
        output:
          `已登记假设 ${h.id}(状态 open)。\n${fmtHypothesis(h)}\n\n` +
          `提醒:这是假设不是结论。harness 会持续用新证据挑战它的证伪条件;` +
          `定论前请用 hypothesis_challenge 显式裁决。只有 confirmed 的假设能写进最终结论。`,
      };
    } catch (e: any) {
      return { output: `登记失败:${e?.message ?? String(e)}`, isError: true };
    }
  }
}

/**
 * 缺口8:裁决埋点的写入端(由 cli.ts 在注册工具时注入 TraceCollector 的 appendEvent)。
 *
 * 用构造注入而不是全局 sink(如 side-call-sink 那种):工具实例本就在 cli.ts 里构造,
 * 顺手多传一个参数的成本远低于引入一份新的全局可变状态,且单测可以直接传假 sink 断言。
 */
export type HypothesisTraceSink = (event: {
  event: string;
  session_id: string;
  timestamp: string;
  data?: Record<string, unknown>;
}) => void;

/** hypothesis_challenge —— 机制2 响应端 + 机制3 结案:对假设裁决 */
export class HypothesisChallengeTool implements Tool {
  readonly zodSchema = challengeSchema();
  private turnProvider: () => number;
  private traceSink?: HypothesisTraceSink;
  private sessionIdProvider: () => string;

  constructor(
    private ledger: HypothesisLedger,
    turnProvider?: () => number,
    /** 缺口8:裁决事件写入端。不注入则埋点静默跳过(与所有可观测性埋点同纪律)。 */
    traceSink?: HypothesisTraceSink,
    /** 缺口8:session_id 取值器(events.jsonl 每条都要带)。 */
    sessionIdProvider?: () => string,
  ) {
    this.turnProvider = turnProvider ?? (() => 0);
    this.traceSink = traceSink;
    this.sessionIdProvider = sessionIdProvider ?? (() => "");
  }

  /**
   * 缺口8:延迟接线埋点写入端。
   *
   * 必须支持延迟注入:本工具在 cli.ts 注册(那时 TraceCollector 尚未创建),
   * collector 在 app.doInit 里才 init 完成——与 wireSubAgentUsageSink 同款时序问题,
   * 故采用同款解法(构造时可空 + 事后 setter 回填)。未接线时埋点静默跳过。
   */
  setTraceSink(sink: HypothesisTraceSink, sessionIdProvider: () => string): void {
    this.traceSink = sink;
    this.sessionIdProvider = sessionIdProvider;
  }

  /**
   * 缺口8:延迟接线轮次取值器。
   *
   * 轮次此前恒为 0(cli.ts 注释写的"暂用占位")——而 `ageInTurns`(假设从登记到裁决
   * 跨了几轮)是缺口2 的核心度量之一,占位值让它恒为 undefined。接上会话累计轮次后
   * 才有意义;用累计轮次而非消息内 turnCount,理由同缺口7(后者跨消息归零、相减无意义)。
   */
  setTurnProvider(fn: () => number): void {
    this.turnProvider = fn;
  }

  /**
   * 缺口8:把一次裁决落成 HypothesisSettled 事件。
   *
   * 纯观测、零行为改动。记录的是裁决的**成色**而非"调了工具"——后者已由
   * HypothesisToolUsed 覆盖,但它答不出关键问题:"confirm 时平均握有几条带 source
   * 的支持证据?" 而这正是判定缺口1/缺口4 修没修对的硬指标:
   *   - 若 confirm 大多只有 0-1 条无 source 证据 → "提前宣布胜利"依然普遍,翻案该收紧;
   *   - 若普遍 2 条以上带 source → 确认是扎实的,当前阈值合适。
   * 带 source 的条数单独记:出处指针是证据可回溯性的代理指标(对齐 digest 的 Provenance)。
   */
  private emitSettled(
    h: Hypothesis,
    verdict: string,
    direction: string | undefined,
    turn: number,
    /**
     * 本次裁决是否为空转(状态未变 + 无待复核证据 + 证据非新)。
     * 落进事件才能在现网回答"空转率是多少"——2026-08-01 实测 42% 靠离线重算得出,
     * 当时事件里没有这个字段,只能凭 verdict 序列反推。
     */
    redundant: boolean,
  ): void {
    if (!this.traceSink) return;
    try {
      const withSource = (list: { source?: string }[]) =>
        list.filter((e) => typeof e.source === "string" && e.source.length > 0).length;
      this.traceSink({
        event: "HypothesisSettled",
        session_id: this.sessionIdProvider(),
        timestamp: new Date().toISOString(),
        data: {
          hypothesisId: h.id,
          verdict,
          /** 裁决后的终态(keep_open/reopen 都会是 open) */
          status: h.status,
          /** 缺口4:本条证据的落位方向(未给时为 undefined,即 neutral) */
          evidenceDirection: direction,
          supportingCount: h.supporting.length,
          refutingCount: h.refuting.length,
          /** 缺口4:方向未定的存疑证据条数——keep_open 是否真的被用起来了看这里 */
          neutralCount: h.neutral.length,
          supportingWithSource: withSource(h.supporting),
          refutingWithSource: withSource(h.refuting),
          /** 缺口1:确认后又被证据打脸的次数(0 表示没被挑战过) */
          challengedAfterConfirm: h.challengedAfterConfirm,
          /** 其中已被复核过的次数;与上一字段的差值 >0 才武装交付门禁 */
          challengesAcknowledged: h.challengesAcknowledged,
          /** 本次裁决是否空转(离线算空转率用,不必再从 verdict 序列反推) */
          redundant,
          /** 该假设从登记到本次裁决跨了几轮(turn 口径同 createdTurn,由 turnProvider 决定) */
          turn,
          createdTurn: h.createdTurn,
          ageInTurns: turn > 0 && h.createdTurn > 0 ? turn - h.createdTurn : undefined,
        },
      });
    } catch {
      /* 埋点绝不能反过来阻断工具执行 */
    }
  }

  name(): string {
    return "hypothesis_challenge";
  }

  description(): string {
    return `对假设登记表中的某条假设做裁决:确认、推翻、或仍存疑。

## 何时使用
- harness 注入了"矛盾中断"提醒(新证据命中了某假设的证伪条件)时——**必须**来这里裁决,不能装没看见继续推进。
- 你自己拿到了足以确认或推翻某条假设的证据时。
- 交付结论前,逐条结清所有 open 假设(机制3:open/refuted 的假设不得作为结论交付)。

## 裁决档位
- \`confirm\`:证据确认假设成立。该假设可作为结论。
- \`refute\`:证据推翻假设。这是**有价值的产出**,不是失败——它防止你交付一个错误根因。
- \`keep_open\`:补充了证据但不足以定论。假设保持 open,继续被挑战。
- \`reopen\`:此前已 confirm,但新证据动摇了它 → 退回 open 重新取证。已 refute 的不能翻案(那是终态)。

## keep_open 怎么用(别把它当"只能记反驳证据")
\`keep_open\` 是给**证据不足以定论**的处境用的,证据偏哪边都可以,用 \`evidence_direction\` 标明方向:
- \`evidence_direction: "supporting"\`——例:"grep 到 3 处调用点符合预期,但没看到实际运行结果,不能确认";
- \`evidence_direction: "refuting"\`——例:"日志里没出现预期的报错,倾向不成立,但日志级别可能不够";
- 不填 / \`"neutral"\`——例:"读到相关代码但看不出是否影响该路径,方向未定"。

**不要因为"手上是支持证据"就跳过 keep_open 直接 confirm。** 支持证据不等于充分证据:
证据不足时 confirm 会让这条假设提前进入结论,而后续反证很容易被当成噪音忽略。

## 关键纪律(抗沉没成本)
拿到与假设矛盾的证据时,**默认倾向 refute 或 keep_open**,而不是找理由维持原叙事。
fdb47f30 的教训正是:已推出"进程没崩"的正确证据,却因不愿推翻早期"崩溃"叙事而把它丢弃。

## 连续 refute 意味着什么(读到这里请注意,这不是在批评你)
一条 refute 是**有效产出**:它排除了一个方向,缩小了搜索空间。
但**连续多条 refute 且一条都没 confirm**,是另一层信号——它说明假设的**来源**不对,
多半是在凭代码静态推理、凭命名/注释外推,而这类推理覆盖不到真实根因。
此时该换的是**取证手段**(查 git 改动史 / 加临时日志实测 / 写最小复现 / 问用户补条件),
不是继续在同一路数上换下一个猜测。

这是搜索策略问题,不是纪律问题、也不是你的失误。看到自己连推几条时,请直接换手段,
不必自我检讨——把"连错几次"读成"我违反了纪律"反而会浪费你的推理预算。`;
  }

  inputSchema(): Record<string, unknown> {
    return z.toJSONSchema(challengeSchema()) as Record<string, unknown>;
  }

  readOnly(): boolean {
    return true;
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const p = input as {
      id?: string;
      verdict?: "confirm" | "refute" | "keep_open" | "reopen";
      evidence?: { note: string; source?: string };
      evidence_direction?: "supporting" | "refuting" | "neutral";
    };
    if (!p.id || !p.verdict || !p.evidence?.note) {
      return { output: "需要 id、verdict、evidence.note 三个字段", isError: true };
    }
    try {
      const turn = this.turnProvider();
      const { h, redundant } = this.ledger.challenge({
        id: p.id,
        verdict: p.verdict,
        evidence: { ...p.evidence, turn },
        evidenceDirection: p.evidence_direction,
        turn,
      });
      // 缺口8:把每次裁决落成结构化 trace 事件。
      //
      // 为什么必须补(纯观测、零行为改动):此前 events.jsonl 里**只有** HypothesisToolUsed
      // (记"调了哪个工具"),没有任何一处记录裁决的**成色**——于是"confirm 时平均握有
      // 几条带 source 的支持证据"这个问题在现网无法回答。而这恰恰是判定缺口1/缺口4
      // 修没修对的唯一硬指标:若 confirm 大多只有 0-1 条无 source 证据,说明"提前宣布
      // 胜利"依然普遍,翻案机制该收紧;若普遍 2 条以上带 source,说明确认是扎实的。
      // 带 source 的比例单独记:出处指针是证据可回溯性的代理指标(对齐 digest 的 Provenance)。
      this.emitSettled(h, p.verdict, p.evidence_direction, turn, redundant);
      // 2026-08-01 成本收益实测:26 次裁决里 11 次(42%)是"绕一圈回到同一结论"的空转。
      // 空转轮的边际成本等于一次真实工作轮(实测纯假设轮平均 32.9s、与工作轮 32.5s
      // 几乎相同,因为整个上下文要全价重发),而产出信息量为零。
      //
      // 这里回一句短提示而不是完整登记表:载荷越长,模型越倾向"再读一遍再回一次",
      // 空转就自我延续。明确告诉它"状态没变、无需再裁决"是打断该循环的最短路径。
      if (redundant) {
        return {
          output:
            `${h.id} 已是 ${h.status},本次裁决未改变状态、也没有待复核的新证据——无需重复裁决。\n` +
            `若要继续推进:补充**新**证据后再裁决,或直接交付(该假设已结清)。`,
        };
      }
      const unsettled = this.ledger.unsettled();
      const tailParts: string[] = [];
      if (unsettled.length > 0) {
        tailParts.push(
          `仍未结清(不得作为结论交付)的假设 ${unsettled.length} 条:` +
            unsettled.map((u) => `${u.id}[${u.status}]`).join(", "),
        );
      } else {
        tailParts.push("所有假设已结清。");
      }
      // 缺口1:已确认但确认后被证据挑战过的假设,在这里也提示一次——不必等到收尾门禁。
      // 越早知道"这条确认后来被打脸过",改写结论的成本越低。
      const challenged = this.ledger.challengedConfirmed();
      if (challenged.length > 0) {
        tailParts.push(
          `另有 ${challenged.length} 条已确认假设在确认后被证据命中过证伪条件:` +
            challenged.map((c) => `${c.id}(${c.challengedAfterConfirm} 次)`).join(", ") +
            `。交付前请复核结论是否仍成立,必要时 verdict=reopen 退回重新取证。`,
        );
      }
      return {
        output: `已裁决 ${h.id} → ${h.status}。\n${fmtHypothesis(h)}\n\n${tailParts.join("\n")}`,
      };
    } catch (e: any) {
      return { output: `裁决失败:${e?.message ?? String(e)}`, isError: true };
    }
  }
}
