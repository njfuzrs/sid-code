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
      .enum(["confirm", "refute", "keep_open"])
      .describe("裁决:confirm=证据确认成立 / refute=证据推翻 / keep_open=补充证据但证据不足以定论"),
    evidence: z.object({
      note: z.string().describe("裁决依据(证据)"),
      source: z.string().optional().describe("出处:file:line / 命令 / 工具输出"),
    }),
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

/** hypothesis_challenge —— 机制2 响应端 + 机制3 结案:对假设裁决 */
export class HypothesisChallengeTool implements Tool {
  readonly zodSchema = challengeSchema();
  private turnProvider: () => number;

  constructor(
    private ledger: HypothesisLedger,
    turnProvider?: () => number,
  ) {
    this.turnProvider = turnProvider ?? (() => 0);
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
- \`keep_open\`:补充了反驳/存疑证据,但不足以定论。假设保持 open,继续被挑战。

## 关键纪律(抗沉没成本)
拿到与假设矛盾的证据时,**默认倾向 refute 或 keep_open**,而不是找理由维持原叙事。
fdb47f30 的教训正是:已推出"进程没崩"的正确证据,却因不愿推翻早期"崩溃"叙事而把它丢弃。`;
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
      verdict?: "confirm" | "refute" | "keep_open";
      evidence?: { note: string; source?: string };
    };
    if (!p.id || !p.verdict || !p.evidence?.note) {
      return { output: "需要 id、verdict、evidence.note 三个字段", isError: true };
    }
    try {
      const turn = this.turnProvider();
      const h = this.ledger.challenge({
        id: p.id,
        verdict: p.verdict,
        evidence: { ...p.evidence, turn },
        turn,
      });
      const unsettled = this.ledger.unsettled();
      let tail = "";
      if (unsettled.length > 0) {
        tail =
          `\n\n仍未结清(不得作为结论交付)的假设 ${unsettled.length} 条:` +
          unsettled.map((u) => `${u.id}[${u.status}]`).join(", ");
      } else {
        tail = "\n\n所有假设已结清。";
      }
      return { output: `已裁决 ${h.id} → ${h.status}。\n${fmtHypothesis(h)}${tail}` };
    } catch (e: any) {
      return { output: `裁决失败:${e?.message ?? String(e)}`, isError: true };
    }
  }
}
