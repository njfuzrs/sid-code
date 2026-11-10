#!/usr/bin/env bun
/**
 * tool-selection-audit —— 工具选择正确率的度量（方案 20261109 §三 D7 / FIX-6）
 *
 * ## 它回答什么
 *
 * wait-audit 回答「等待窗口里浪费了多少」，本脚本回答它回答不了的另一半：
 * **「这个场景该用 A，模型实际选了 B 没有」**——即工具选择的正确率。
 *
 * 为什么需要它（D7 的动机）：802 次前台轮询（`gh pr checks` 708 + `gh run watch` 94，
 * 2026-11-09 快照）里有多少是「该用 monitor / bash 后台却在前台干等」，此前无法归因。
 * D4/D6（引导）修复合入后，要用同一个脚本重跑对比 `selection_accuracy` 是否提升、
 * `misuse_count` 是否下降——没有本脚本就没有对照组，D8 的减法也没有依据。
 *
 * ## 口径（三条铁律，数字引用前先读）
 *
 * 1. **分母是「识别出的场景数」，不是会话数**。场景 = 命中了下面 SCENARIOS 表里
 *    任一信号（prompt 关键词 / 轮询命令形态）的一次会话；一个会话可能同时命中
 *    多个场景（各算一个场景），也可能一个都不命中（不进分母）。
 *    「3 个事件流场景」指的是 prompt 明确要求「每次发生都告诉我」的场景，
 *    不含「一次就好」的 CI 全绿类（那类期望是 bash 后台，见 SCENARIOS）。
 * 2. **调用次数口径 = session.traj 的 action 消息**（`message_type === "action" &&
 *    tool_name === X`，方案 §0.1 的合法口径之一）。禁用 events 行命中数 ÷ 3。
 * 3. **启发式有误判，先抽样再引用**：拿本脚本的数字下结论前，先 `--samples` 抽样
 *    人工核对 10~20 个场景的 prompt / 命令原文，确认分类合理后再引用（D7 风险段）。
 *    同一场景可有多个合理工具（「可接受替代」列），表里没有替代的才允许把合法用法判成误用。
 *
 * ## 指标
 *
 *   selection_accuracy = 选对次数（期望或可接受替代）/ 场景总数
 *   misuse_count       = 期望表判为误用的次数（如「事件流场景却前台轮询」）
 *   missed_opportunity = 该用 monitor 但一次都没用的场景数
 *
 * ## 用法
 *
 *   bun scripts/tool-selection-audit.ts <session-dir|session-id>
 *   bun scripts/tool-selection-audit.ts --all --json
 *   bun scripts/tool-selection-audit.ts --all --since 2026-11-10T06:59:00Z   # 按会话开始时间过滤
 *   bun scripts/tool-selection-audit.ts --all --samples 5                     # 输出抽样上下文供人工核对
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** traj 的行（与 wait-audit 同口径：action 的 tool_input 是结构化字段） */
type TrajRow = {
  message_type?: string;
  timestamp?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    run_in_background?: boolean;
    wait_until_seconds?: number;
    delay_seconds?: number;
  };
};

/** messages.json 提取出的用户真实输入（见 extractUserText） */
type UserPrompt = { text: string | null };

/**
 * 一次「模型实际做了什么选择」的观测，从 traj 的 action 序列归纳：
 *
 * - monitor：调过 `monitor` 工具；
 * - bash-bg：前台 bash 里至少一次 `run_in_background:true`（「CI 全绿」场景若带
 *   `wait_until_seconds` 属于期望形态；只 run_in_background 不带期限也按可接受替代计）；
 * - fg-poll：同一 subject（同一外部对象）出现 ≥2 次前台状态查询（偶数单查不算轮询）；
 * - wakeup：调过 `schedule_wakeup`。
 */
export interface Choice {
  monitor: boolean;
  bashBg: boolean;
  wakeup: boolean;
  /** 前台长 sleep（≥30s）：「定时提醒」场景的前台干等形态（文档表的误用信号） */
  fgSleep: boolean;
  /** run_in_background 的 bash 次数：event-stream 的「只用一次 bash 后台」误用判定需要 */
  bashBgCount: number;
  /** task_output 调用次数：起了后台任务却从不跟进，说明它没有承担通知职责 */
  taskOutputCount: number;
  /** 前台轮询的 subject 列表（如 `gh:pr:662`），供输出对账 */
  fgSubjects: string[];
  fgPollCount: number;
}

export interface ScenarioRule {
  /** 场景名（输出用） */
  name: string;
  /**
   * 识别信号：prompt 关键词（正则）。命中任一即识别为该场景（同会话可命中多个场景）。
   * 关键词刻意要求出现「告诉/通知/叫我」这类**等待语义**：只说「看下 CI 状态」
   * 没有等待请求，前台查一次是合法的，不能算场景（否则误报淹没真场景）。
   */
  promptRe: RegExp[];
  /** 期望工具（多选一命中即算选对） */
  expected: Array<"monitor" | "bashBg" | "wakeup">;
  /** 可接受替代（不算选对、也不算误用） */
  acceptable: Array<"monitor" | "bashBg" | "wakeup">;
  /**
   * 误用形态判定（文档期望表的「误用」列）：
   * 前台轮询对所有场景都是误用；event-stream 的「只用一次 bash 后台且从不 task_output
   * 跟进」、delayed-reminder 的前台长 sleep 是各自的专属误用形态。
   */
  isMisuseForm: (c: Choice) => boolean;
}

/**
 * 场景表（D7「期望工具表」）。⚠️ 修这张表 = 改指标定义，必须做变异自证：
 * 删掉 monitor 行的期望后 misuse_count/missed_opportunity 必须变化，否则判定没有生效。
 */
export const SCENARIOS: ScenarioRule[] = [
  {
    // 「每个 check 结束都告诉我」「每出现一行就告诉我」——事件流场景，期望 monitor
    name: "event-stream",
    promptRe: [
      /每[个条][^。！？\n]{0,12}(?:告诉|通知)/,
      /每出现[^。！？\n]{0,12}(?:告诉|通知)/,
      /(?:盯|盯住|盯一下)[^。！？\n]{0,20}(?:告诉|通知|出现)/,
    ],
    expected: ["monitor"],
    acceptable: [],
    isMisuseForm: (c) =>
      c.fgSubjects.length > 0 || (c.bashBg && c.bashBgCount <= 1 && c.taskOutputCount === 0),
  },
  {
    // 「CI 全绿告诉我」「等 CI 完成后告诉我」——单次通知场景，期望 bash 后台
    name: "ci-single",
    promptRe: [
      /(?:CI|ci)[^。！？\n]{0,10}(?:全绿|通过|完成)[^。！？\n]{0,10}(?:后)?[^。！？\n]{0,4}(?:告诉|通知|叫我)/,
      /(?:等|等下|等待)[^。！？\n]{0,8}(?:CI|ci|构建|检查|跑完|结束)[^。！？\n]{0,12}(?:告诉|通知|叫我|完成)/,
    ],
    expected: ["bashBg"],
    acceptable: ["monitor"],
    isMisuseForm: (c) => c.fgSubjects.length > 0,
  },
  {
    // 「N 分钟后提醒我」——定时场景，期望 schedule_wakeup / cron
    name: "delayed-reminder",
    promptRe: [
      /[0-9一二三四五六七八九十半]+\s*(?:分钟|小时|点半)[^。！？\n]{0,8}(?:后|之后)[^。！？\n]{0,10}(?:提醒|叫我|唤)/,
      /(?:分钟|小时)[^。！？\n]{0,6}后[^。！？\n]{0,10}提醒/,
    ],
    expected: ["wakeup"],
    acceptable: [],
    isMisuseForm: (c) => c.fgSleep || c.fgSubjects.length > 0,
  },
  {
    // 「日志里每出现 ERROR 就告诉我」——事件流场景的日志变体，期望 monitor
    name: "log-watching",
    promptRe: [
      /(?:日志|log)[^。！？\n]{0,14}(?:每|一旦)[^。！？\n]{0,14}(?:告诉|通知|出现)/,
      /每[个条]?\s*(?:ERROR|error|错误|异常)[^。！？\n]{0,10}(?:告诉|通知)/,
    ],
    expected: ["monitor"],
    acceptable: [],
    isMisuseForm: (c) =>
      c.fgSubjects.length > 0 || (c.bashBg && c.bashBgCount <= 1 && c.taskOutputCount === 0),
  },
];

/**
 * 命令信号：前台反复查同一个外部状态 → 该会话存在「轮询形态」。
 * 与 SCENARIOS 的 prompt 关键词是「或」关系——只命中命令形态、prompt 没提等待，
 * 说明是模型自发选择了前台轮询，正是 misuse 要抓的对象；此时按场景归类为 event-stream
 * （事件流监控的最典型误用形态），期望仍是 monitor。
 */
const POLL_COMMAND_RE =
  /(?:gh\s+(?:pr\s+(?:checks|view|status)|run\s+(?:view|watch|list))|glab\s+(?:mr\s+view|ci\s+status)|kubectl\s+(?:rollout\s+status|get\s+(?:pods?|deployments?))|curl\s+[^\n]*(?:health|healthz|readyz|livez|status))/;

/** 会话的综合审计结果（单会话 + --all 汇总共用一个纯函数，供单测夹具复用） */
export interface SelectionAudit {
  session: string;
  /** 会话开始时间（metadata.json 的 start_time），--since 过滤与前后段切分都按它 */
  startedAt: string | null;
  /** 识别出的场景列表（name + 命中的信号样本），未识别出场景的会话不进分母 */
  scenarios: Array<{ name: string; signal: string }>;
  /** 模型实际的工具选择（见 Choice） */
  choice: Choice;
  /** 期望表的判定：matched = 选对（期望或替代）/ misused = 误用 / missed = 一次都没用 */
  verdict: "matched" | "misused" | "missed" | "no-scenario";
}

function readTraj(dir: string): TrajRow[] {
  const file = join(dir, "session.traj");
  if (!existsSync(file)) return [];
  const d = JSON.parse(readFileSync(file, "utf8")) as { trajectory?: TrajRow[] };
  return d.trajectory ?? [];
}

/** messages.json 里单条消息的形态 */
type MessageRow = { role: string; content?: Array<{ type: string; text?: string }>; ts?: string };

/**
 * 从 user 消息序列提取「用户真实说过的话」（纯函数，供脚本与单测共用）。
 *
 * 为什么不是首条：等待请求常出现在会话中途（「CI 绿了告诉我」在第 5 轮才说），
 * 只看首条会把这些场景整体漏掉（漏 = 分母偏小 = accuracy 虚高，比误报更隐蔽）。
 *
 * 两类注入文本要剥掉——它们不是用户说的话，里面出现「每个 check」「通知」这类
 * 与场景关键词撞车的文字会把没提过等待的会话误报成场景（D4 验收污染的同源问题）：
 * 1. `<system-reminder>…</system-reminder>`（harness 注入的上下文，可与真实 prompt 同块）；
 * 2. 整块以 `[系统通知 —— 非用户输入]` 开头的消息（后台任务事件转发成 user 消息，
 *    其中的 `<task-notification>` 正文是被监控进程的输出，属于外部不可信数据）。
 */
export function extractUserText(messages: MessageRow[]): string | null {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    let text = (msg.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
    if (text.startsWith("[系统通知")) continue; // 整块是任务事件转发，不是用户输入
    text = text.trim();
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function readUserPrompt(dir: string): UserPrompt {
  const file = join(dir, "messages.json");
  if (!existsSync(file)) return { text: null };
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as { messages?: MessageRow[] };
    return { text: extractUserText(m.messages ?? []) };
  } catch {
    return { text: null };
  }
}

/**
 * 会话开始时间：优先 metadata.json 的 start_time；缺文件时回退解析会话 ID 前缀。
 *
 * 为什么需要回退：metadata.json 在会话结束时才写，进行中/异常终止的会话没有它，
 * startedAt=null 的会话会**穿透 --since 过滤**（既不排除也不确认）——进行中的会话
 * 恰恰是最新的，全落在「后段」里，把前后段切分污染成「后段=正在跑的会话」。
 * 会话 ID 形如 `20261110-152006-77684ab7`，前 15 字符是本地时间（实测
 * `20261109-223949-b177b927` 的 start_time 为 `14:39:49.876Z`，本地 +8）。
 */
function readStartTime(dir: string): string | null {
  const file = join(dir, "metadata.json");
  if (existsSync(file)) {
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as { start_time?: string };
      if (typeof m.start_time === "string") return m.start_time;
    } catch {
      /* 落到 ID 回退 */
    }
  }
  const id = dir.split("/").pop() ?? "";
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  if (!m) return null;
  const t = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** 前台长 sleep 的阈值：低于它的 sleep 多是命令内部节流，不是「干等一个时刻」 */
const FG_SLEEP_MS = 30_000;

/** 从 traj 归纳「实际选择」（Choice 的语义见接口注释） */
function inferChoice(traj: TrajRow[]): Choice {
  const c: Choice = {
    monitor: false,
    bashBg: false,
    wakeup: false,
    fgSleep: false,
    bashBgCount: 0,
    taskOutputCount: 0,
    fgSubjects: [],
    fgPollCount: 0,
  };
  /** subject（外部对象）→ 前台查询次数，≥2 次才算「轮询形态」 */
  const fgBySubject = new Map<string, number>();
  for (const r of traj) {
    if (r.message_type !== "action" || !r.tool_name) continue;
    const input = r.tool_input ?? {};
    if (r.tool_name === "monitor") c.monitor = true;
    if (r.tool_name === "schedule_wakeup") c.wakeup = true;
    if (r.tool_name === "task_output") c.taskOutputCount++;
    if (r.tool_name === "bash") {
      const cmd = input.command ?? "";
      if (input.run_in_background === true) {
        c.bashBg = true;
        c.bashBgCount++;
      } else {
        // 前台长 sleep（≥30s）：定时场景的干等形态（`sleep 300 && …` / 独立 `sleep 60`）
        for (const m of cmd.matchAll(/\bsleep\s+([0-9.]+)s?\b/g)) {
          const secs = Number(m[1]);
          if (Number.isFinite(secs) && secs * 1000 >= FG_SLEEP_MS) c.fgSleep = true;
        }
        // 前台（非 run_in_background）命中轮询命令表：按对象归并计数
        if (POLL_COMMAND_RE.test(cmd)) {
          c.fgPollCount++;
          const subject = pollSubject(cmd);
          fgBySubject.set(subject, (fgBySubject.get(subject) ?? 0) + 1);
        }
      }
    }
  }
  c.fgSubjects = [...fgBySubject.entries()].filter(([, n]) => n >= 2).map(([s]) => s);
  return c;
}

/** 从命令里抽「被查询对象」的签名（PR 号 / run id / host），供轮询归并与输出对账 */
function pollSubject(command: string): string {
  const pr = /gh\s+pr\s+(?:checks|view|status)\s+(\d+)/.exec(command);
  if (pr) return `gh:pr:${pr[1]}`;
  const run = /gh\s+run\s+(?:view|watch)\s+(\d+)/.exec(command);
  if (run) return `gh:run:${run[1]}`;
  const url = /(https?:\/\/[^\s'"|;]+)/.exec(command);
  if (url) return url[1]!;
  return "other";
}

/** 判定一次场景的选择对错（纯函数，单测直接覆盖） */
export function judge(choice: Choice, rule: ScenarioRule): "matched" | "misused" | "missed" {
  // 任一期望或可接受替代被选中 → matched。
  // 注意 wakeup 不在 ci-single 的替代里：文档期望表的可接受替代只有 monitor——
  // 排了唤醒又全程前台轮询不算选对（wakeup 只解决「定时叫醒」，不解决「等待期别空转」）。
  for (const k of [...rule.expected, ...rule.acceptable]) {
    if (choice[k]) return "matched";
  }
  // 场景专属的误用形态（期望表的「误用」列）：前台轮询 / 前台长 sleep /
  // event-stream 的「只用一次 bash 后台且从不 task_output 跟进」
  if (rule.isMisuseForm(choice)) return "misused";
  // 什么等待工具都没用 → missed（错失的改进机会）
  return "missed";
}

/** 单会话审计（纯函数核心，供脚本与单测共用） */
export function auditSession(input: {
  session: string;
  traj: TrajRow[];
  prompt: string | null;
  startedAt?: string | null;
}): SelectionAudit {
  const choice = inferChoice(input.traj);
  const scenarios: Array<{ name: string; signal: string }> = [];
  for (const rule of SCENARIOS) {
    for (const re of rule.promptRe) {
      const m = input.prompt ? re.exec(input.prompt) : null;
      if (m) {
        scenarios.push({ name: rule.name, signal: `prompt:${m[0]}` });
        break;
      }
    }
  }
  // 命令信号：prompt 没提等待、模型却在前台反复查同一对象 → 也算一个场景。
  // 归类为 ci-single（期望 bash 后台）：前台轮询的最常见形态是「等 CI/等 PR 状态」，
  // 期望工具是「bash 后台 + wait_until_seconds」（一次通知即可），monitor 是可接受替代
  // —— 归为 event-stream（期望 monitor）会把「已用 bash 后台但混了前台轮询」的会话
  // 全部判成误用，misuse_count 虚高（首版实测 201/211，口径修正的意义就在这里）。
  if (choice.fgSubjects.length > 0 && scenarios.length === 0) {
    scenarios.push({ name: "ci-single", signal: `cmd:fg-poll:${choice.fgSubjects.join(",")}` });
  }
  let verdict: SelectionAudit["verdict"] = "no-scenario";
  if (scenarios.length > 0) {
    // 多场景时按最差判定汇总：有误用算误用，否则有 missed 算 missed，剩下 matched
    let misused = false;
    let missed = false;
    let matched = false;
    for (const s of scenarios) {
      const rule = SCENARIOS.find((r) => r.name === s.name)!;
      const v = judge(choice, rule);
      if (v === "misused") misused = true;
      else if (v === "missed") missed = true;
      else matched = true;
    }
    verdict = misused ? "misused" : missed ? "missed" : matched ? "matched" : "no-scenario";
  }
  return {
    session: input.session,
    startedAt: input.startedAt ?? null,
    scenarios,
    choice,
    verdict,
  };
}

function sessionsRoot(): string {
  return process.env.SID_CONFIG_DIR
    ? join(process.env.SID_CONFIG_DIR, "trajectories", "sessions")
    : join(homedir(), ".sid-code", "trajectories", "sessions");
}

interface Totals {
  sessions: number;
  /** 有场景的会话数（分母按场景数，不按会话数——一会话可多场景） */
  sessionsWithScenario: number;
  scenarioCount: number;
  matched: number;
  misused: number;
  missed: number;
  selection_accuracy: number;
  /** 误用形态次数（前台轮询 / 前台长 sleep / 一次性后台不跟进） */
  misuse_count: number;
  /** 该用 monitor 的场景一次都没用 monitor 的次数 */
  missed_opportunity: number;
  /** 按场景分解：文档口径「该用 monitor 却前台轮询」= monitor 类场景（event-stream / log-watching）的 misused 数 */
  byScenario: Record<string, { matched: number; misused: number; missed: number }>;
}

function summarize(results: SelectionAudit[]): Totals {
  let matched = 0;
  let misused = 0;
  let missed = 0;
  let scenarioCount = 0;
  let missedOpp = 0;
  const byScenario: Totals["byScenario"] = {};
  for (const r of results) {
    if (r.scenarios.length === 0) continue;
    scenarioCount += r.scenarios.length;
    for (const s of r.scenarios) {
      const rule = SCENARIOS.find((x) => x.name === s.name)!;
      const v = judge(r.choice, rule);
      const b = (byScenario[rule.name] ??= { matched: 0, misused: 0, missed: 0 });
      if (v === "matched") {
        matched++;
        b.matched++;
      } else if (v === "misused") {
        misused++;
        b.misused++;
      } else {
        missed++;
        b.missed++;
        if (rule.expected.includes("monitor")) missedOpp++;
      }
    }
  }
  const total = matched + misused + missed;
  return {
    sessions: results.length,
    sessionsWithScenario: results.filter((r) => r.scenarios.length > 0).length,
    scenarioCount,
    matched,
    misused,
    missed,
    selection_accuracy: total > 0 ? Math.round((matched / total) * 1000) / 10 : 0,
    misuse_count: misused,
    missed_opportunity: missedOpp,
    byScenario,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const samplesIdx = args.indexOf("--samples");
  const samples = samplesIdx >= 0 ? Number(args[samplesIdx + 1] ?? 0) : 0;
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const flagValues = new Set(
    [samplesIdx >= 0 ? args[samplesIdx + 1] : undefined, since].filter(Boolean) as string[],
  );
  const target = args.find((a) => !a.startsWith("--") && !flagValues.has(a));

  const root = sessionsRoot();
  let results: SelectionAudit[] = [];

  const auditOne = (dir: string): SelectionAudit | null => {
    if (!existsSync(join(dir, "session.traj"))) return null;
    const startedAt = readStartTime(dir);
    if (since && startedAt && startedAt < since) return null;
    const { text } = readUserPrompt(dir);
    return auditSession({
      session: dir.split("/").pop() ?? dir,
      traj: readTraj(dir),
      prompt: text,
      startedAt,
    });
  };

  if (all) {
    if (!existsSync(root)) {
      process.stderr.write(`没有轨迹目录: ${root}\n`);
      process.exit(1);
    }
    for (const name of readdirSync(root)) {
      const r = auditOne(join(root, name));
      if (r) results.push(r);
    }
  } else if (target) {
    const dir = target.includes("/") ? target : join(root, target);
    const r = auditOne(dir);
    if (!r) {
      process.stderr.write(`会话 ${target} 无轨迹（或被 --since 过滤）\n`);
      process.exit(1);
    }
    results = [r];
  } else {
    process.stderr.write(
      "用法: bun scripts/tool-selection-audit.ts <session-dir|session-id> [--json]\n" +
        "      bun scripts/tool-selection-audit.ts --all [--json] [--since <ISO>] [--samples N]\n",
    );
    process.exit(1);
  }

  if (json) {
    const totals = summarize(results);
    console.log(JSON.stringify({ totals, sessions: results }, null, 2));
    return;
  }

  for (const r of results) {
    if (r.scenarios.length === 0 && !target) continue; // 人类可读输出只列有场景的
    console.log(
      `${r.session}: verdict=${r.verdict} scenarios=[${r.scenarios.map((s) => `${s.name}(${s.signal})`).join(", ")}] ` +
        `monitor=${r.choice.monitor ? 1 : 0} bash_bg=${r.choice.bashBg ? 1 : 0} ` +
        `wakeup=${r.choice.wakeup ? 1 : 0} fg_polls=${r.choice.fgPollCount} ` +
        `fg_subjects=[${r.choice.fgSubjects.join(",")}]`,
    );
  }
  const t = summarize(results);
  console.log(
    `合计 ${t.sessions} 个会话: 场景=${t.scenarioCount} matched=${t.matched} ` +
      `misused=${t.misused} missed=${t.missed} ` +
      `selection_accuracy=${t.selection_accuracy}% misuse_count=${t.misuse_count} ` +
      `missed_opportunity=${t.missed_opportunity}`,
  );
  for (const [name, b] of Object.entries(t.byScenario)) {
    console.log(`  ${name}: matched=${b.matched} misused=${b.misused} missed=${b.missed}`);
  }
  if (samples > 0) {
    console.log(`\n-- 抽样（人工核对场景分类用，前 ${samples} 个场景会话）--`);
    let n = 0;
    for (const r of results) {
      if (r.scenarios.length === 0 || n >= samples) continue;
      n++;
      const dir = target ? undefined : join(root, r.session);
      if (!dir) continue;
      const { text } = readUserPrompt(dir);
      console.log(`\n[${n}] ${r.session} verdict=${r.verdict}`);
      console.log(`  scenarios: ${JSON.stringify(r.scenarios)}`);
      console.log(`  prompt: ${(text ?? "<无 messages.json>").slice(0, 300)}`);
    }
  }
}

if (import.meta.main) main();
