#!/usr/bin/env bun
/**
 * defense-trigger-rate —— "四环防线"触发率度量脚本
 *
 * 背景（docs/bugfixes/todo/LLM行为差异分析-gpt5.4-vs-deepseek-v4-pro.md §0.5 / §7）：
 * 假设登记表 / 对抗验证等防线代码全在、单测全过，但真实会话里可能【零触发】——
 * 防线自己成了它当初要消灭的"死功能"。文档给出的工程结论是：
 *   「防线落地后必须验'是否被触发',而非只验'是否 build + 单测过'。应建立'防线触发率'指标。」
 *
 * 本脚本就是那个指标：扫描本地会话轨迹（events.jsonl），统计防线相关工具
 * （hypothesis_register / hypothesis_challenge / sub_agent(verify)）在
 * **审计核查类任务**里的实际调用率——因为防线本就只该在这类高风险结论任务上触发
 * （见 observability-debug SKILL.md 的任务门禁），全量任务的分母会稀释掉信号。
 *
 * 判定"审计核查类任务"：看首个用户 prompt 是否命中关键词
 *   检查/核查/审计/是否落地/落地实现/对照/排查/根因/缺口/验收/复核/verify/audit ...
 * 这是启发式（非确定性分类器，符合文档反对"造分类器中枢"的结论），只用于统计口径。
 *
 * 用法：
 *   bun scripts/defense-trigger-rate.ts                 # 扫最近 200 个会话
 *   bun scripts/defense-trigger-rate.ts --limit 1000    # 扫最近 N 个
 *   bun scripts/defense-trigger-rate.ts --all           # 扫全部
 *   bun scripts/defense-trigger-rate.ts --json          # 机器可读
 *   bun scripts/defense-trigger-rate.ts --list-audit    # 列出被判为审计类且【零触发】的会话（供抽查）
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, listSessions } from "../src/trace/digest.ts";

/** 防线相关工具名（sub_agent 的 verify 类型单独看 tool_input） */
const HYP_TOOLS = new Set(["hypothesis_register", "hypothesis_challenge"]);

/** 审计核查类任务的关键词（命中即算，启发式口径） */
const AUDIT_KEYWORDS = [
  "检查", "核查", "审计", "是否落地", "落地实现", "是否实现", "对照", "对比检查",
  "排查", "根因", "缺口", "验收", "复核", "核实", "有没有落地", "是否存在",
  "audit", "verify", "review", "check whether", "double check", "double-check",
];

interface SessionStat {
  id: string;
  model: string | null;
  isAudit: boolean;
  hypRegister: number;
  hypChallenge: number;
  subAgentVerify: number;
  subAgentTotal: number;
  toolCalls: number;
  promptHead: string;
}

/** 读一个会话的 events.jsonl，抽出防线触发统计。 */
function scanSession(dir: string, id: string): SessionStat | null {
  const p = join(dir, "events.jsonl");
  if (!existsSync(p)) return null;

  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }

  const stat: SessionStat = {
    id,
    model: null,
    isAudit: false,
    hypRegister: 0,
    hypChallenge: 0,
    subAgentVerify: 0,
    subAgentTotal: 0,
    toolCalls: 0,
    promptHead: "",
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = ev.event;
    const data = ev.data ?? {};

    if (kind === "SessionStart" && data.model) {
      stat.model = String(data.model);
    } else if (kind === "UserPromptSubmit" && typeof data.prompt === "string") {
      // 只用首个用户 prompt 判定任务类型（后续追问不改变任务性质）
      if (!stat.promptHead) {
        stat.promptHead = data.prompt.slice(0, 120).replace(/\s+/g, " ");
        const lower = data.prompt.toLowerCase();
        stat.isAudit = AUDIT_KEYWORDS.some((kw) =>
          kw === kw.toLowerCase() && /[a-z]/.test(kw) ? lower.includes(kw) : data.prompt.includes(kw),
        );
      }
    } else if (kind === "PreToolUse") {
      const tn = data.tool_name;
      if (!tn) continue;
      stat.toolCalls++;
      if (HYP_TOOLS.has(tn)) {
        if (tn === "hypothesis_register") stat.hypRegister++;
        else stat.hypChallenge++;
      } else if (tn === "sub_agent") {
        stat.subAgentTotal++;
        // verify 类型藏在 tool_input.agent_type（若埋点携带）
        const at = data.tool_input?.agent_type ?? data.agent_type;
        if (at === "verify") stat.subAgentVerify++;
      }
    }
  }

  return stat;
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const listAudit = args.includes("--list-audit");
  const limIdx = args.indexOf("--limit");
  const limit = all ? Infinity : limIdx >= 0 ? Number(args[limIdx + 1]) || 200 : 200;

  const paths = resolvePaths();
  const refs = listSessions(paths);
  if (refs.length === 0) {
    process.stderr.write(`未找到任何会话轨迹（${paths.sessionsDir}）。\n`);
    process.exit(1);
  }

  const picked = refs.slice(0, limit === Infinity ? refs.length : limit);
  const stats: SessionStat[] = [];
  for (const ref of picked) {
    const s = scanSession(ref.dir, ref.id);
    if (s) stats.push(s);
  }

  const audit = stats.filter((s) => s.isAudit);
  const auditWithHyp = audit.filter((s) => s.hypRegister > 0);
  const auditWithVerify = audit.filter((s) => s.subAgentVerify > 0);
  const auditWithAny = audit.filter((s) => s.hypRegister > 0 || s.subAgentVerify > 0);

  // 全量口径（对照，用于看审计口径是否真的更该关注）
  const allWithHyp = stats.filter((s) => s.hypRegister > 0);

  const summary = {
    scannedSessions: stats.length,
    auditSessions: audit.length,
    triggerRate: {
      hypothesisRegister_inAudit: pct(auditWithHyp.length, audit.length),
      subAgentVerify_inAudit: pct(auditWithVerify.length, audit.length),
      anyDefense_inAudit: pct(auditWithAny.length, audit.length),
      hypothesisRegister_allTasks: pct(allWithHyp.length, stats.length),
    },
    counts: {
      auditWithHypRegister: auditWithHyp.length,
      auditWithSubAgentVerify: auditWithVerify.length,
      auditWithAnyDefense: auditWithAny.length,
      totalHypRegisterCalls: stats.reduce((a, s) => a + s.hypRegister, 0),
      totalHypChallengeCalls: stats.reduce((a, s) => a + s.hypChallenge, 0),
      totalSubAgentVerifyCalls: stats.reduce((a, s) => a + s.subAgentVerify, 0),
    },
  };

  if (json) {
    const out: any = { summary };
    if (listAudit) {
      out.auditZeroTrigger = audit
        .filter((s) => s.hypRegister === 0 && s.subAgentVerify === 0)
        .map((s) => ({ id: s.id, model: s.model, toolCalls: s.toolCalls, promptHead: s.promptHead }));
    }
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  const L: string[] = [];
  L.push("═══ 四环防线触发率 ═══");
  L.push(`扫描会话：${summary.scannedSessions}  其中审计核查类：${summary.auditSessions}`);
  L.push("");
  L.push("审计核查类任务里的防线触发率（分母 = 审计类会话数）：");
  L.push(`  hypothesis_register 被调用 ....... ${summary.triggerRate.hypothesisRegister_inAudit}  (${summary.counts.auditWithHypRegister}/${summary.auditSessions})`);
  L.push(`  sub_agent(verify) 被调用 ......... ${summary.triggerRate.subAgentVerify_inAudit}  (${summary.counts.auditWithSubAgentVerify}/${summary.auditSessions})`);
  L.push(`  任一防线被触发 ................... ${summary.triggerRate.anyDefense_inAudit}  (${summary.counts.auditWithAnyDefense}/${summary.auditSessions})`);
  L.push("");
  L.push(`对照·全量任务 hypothesis_register 触发率：${summary.triggerRate.hypothesisRegister_allTasks}`);
  L.push("");
  L.push("累计调用次数：");
  L.push(`  hypothesis_register: ${summary.counts.totalHypRegisterCalls}   hypothesis_challenge: ${summary.counts.totalHypChallengeCalls}   sub_agent(verify): ${summary.counts.totalSubAgentVerifyCalls}`);

  // 判读提示：触发率是决定"要不要做后续重型改造"的闸门
  L.push("");
  if (summary.auditSessions === 0) {
    L.push("判读：样本里没有审计核查类任务，无法评估——换更大 --limit 或攒些真实核查会话再跑。");
  } else if (auditWithAny.length === 0) {
    L.push("判读：审计类任务里防线【零触发】。印证文档 §0.5——防线是死功能，可见性边/触发域仍未接活。");
  } else if (auditWithAny.length / audit.length < 0.5) {
    L.push("判读：触发率偏低（<50%）。可见性边已部分接上但不稳，值得继续加强 nudge / 触发域。");
  } else {
    L.push("判读：触发率已上来（≥50%）。文档担心的'防线空转'已缓解——后续重型改造（分类器/出口硬门禁）性价比存疑，先别做。");
  }

  if (listAudit) {
    const zero = audit.filter((s) => s.hypRegister === 0 && s.subAgentVerify === 0);
    L.push("");
    L.push(`零触发的审计类会话（${zero.length} 个，抽查用）：`);
    for (const s of zero.slice(0, 30)) {
      L.push(`  ${s.id}  [${s.model ?? "?"}]  ${s.toolCalls} 工具调用  「${s.promptHead}」`);
    }
    if (zero.length > 30) L.push(`  … 还有 ${zero.length - 30} 个`);
  }

  process.stdout.write(L.join("\n") + "\n");
}

main();
