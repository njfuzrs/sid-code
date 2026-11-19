#!/usr/bin/env bun
/**
 * prompt-section-signal-rate —— 系统提示词「段规则 → 可观测行为」的信号计数（D-11 第一步）
 *
 * ## 为什么需要它
 *
 * D-11 的结论是：静态区 9195 tok 不存在预算压力（prompt cache 吸收，`resolvePromptMaxTokens`
 * 给的是窗口 90%），真正的问题是**注意力稀释**。所以体量分层的正确判据不是按 token 砍，
 * 而是按**触发率**砍 —— 先量出「每一段规则在真实轨迹里有没有产生过可观测的行为差异」，
 * 再由数据决定哪一段该改成条件注入。
 *
 * 本脚本只做**度量**，不决定改哪一段。判读口径参照 `harness-negative-yield-rules-inventory`
 * 的方法论：只看「这条规则有没有产生过可观测的行为差异」，不看「这段读起来重不重要」。
 *
 * ## 三条口径铁律（都是踩过的）
 *
 * 1. **定义不出可数信号的段必须显式标"不可度量"，不得默认算零触发。**
 *    零触发是"量了，没触发"，不可度量是"没量"。把后者写成前者，结论会从
 *    "不知道"静默变成"确定没用"，下一步就会删掉一段其实在起作用的规则。
 * 2. **每个信号必须能指到源字段。** `SessionStart` / `PreToolUse` 两种事件、
 *    `data.tool_name` 与 `data.input_summary` 两个字段，逐条写在本文件的 SIGNALS 里。
 *    说不出取数源的计数就是自我感觉。
 * 3. **不得调 LLM。** 与 `defense-trigger-rate.ts` / `northstar-snapshot.ts` 同一条禁令：
 *    度量脚本要确定性、离线、可重跑。
 *
 * ## 已知局限（读报告前先读这段）
 *
 * - **轨迹里没有"当时注入了哪一段"的记录。** 本脚本量的是**全局**行为信号（该工具被调了
 *   几次），不是"因为这段而调"的归因。某段零信号只说明"整个窗口里没有对应的行为"，
 *   不区分"段不在上下文里"与"段在但没起作用"。
 * - **相对计数（子代理 <output-file> 拉取）的绝对量天然偏低**：只有输出超过落盘阈值
 *   才会有 `<output-file>`，而在那之上模型常常直接读预览。它的计数不能直接和
 *   `cron_create` 的次数横向比，只能看跨版本的趋势。
 * - 弱信号（如 `context-management` 的落盘 write）混有大量与规则无关的写文件，
 *   脚本会给整行加「弱信号」标记，按 D-11 原文要求需人工抽检后再下结论。
 *
 * ## 用法
 *
 *   bun scripts/prompt-section-signal-rate.ts                    # 扫最近 30 天轨迹
 *   bun scripts/prompt-section-signal-rate.ts --days 7           # 换时间窗
 *   bun scripts/prompt-section-signal-rate.ts --dir <轨迹目录>    # 指定非默认轨迹目录
 *   bun scripts/prompt-section-signal-rate.ts --json             # 机器可读
 *   bun scripts/prompt-section-signal-rate.ts --self-test        # CI 用：只喂合成轨迹，不读真实数据
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "@sid-code/core/trace/digest.ts";

export interface PromptSectionSignal {
  /** 段名。用 `<tag>` 形态，与提示词里的段落标签同名，便于回源码定位 */
  section: string;
  /** 信号定义（人话）。不可度量的段在这里写清"为什么定义不出" */
  definition: string;
  /**
   * 计数函数。返回 null 表示**不可度量**（整段没有任何可数信号）。
   *
   * 契约：返回 0 是"量了、没触发"；返回 null 是"没量"。两者在报告里必须区分显示，
   * 调用方不得把 null 折算成 0（见文件头铁律 1）。
   */
  count: (ctx: ScanContext) => number | null;
  /** 弱信号：混有与规则无关的同形行为，需人工抽检 */
  weak?: boolean;
}

/** 扫描期累积的上下文，只在 scanEvents 内部填充 */
export interface ScanContext {
  /** 工具名 → PreToolUse 次数 */
  toolCalls: Map<string, number>;
  /** 所有 bash 命令原文（已裁剪到合理长度，见 bashCommand） */
  bashCommands: string[];
  /** 所有 read / read_many / write 的 file_path */
  readPaths: string[];
  writePaths: string[];
}

function bashCommand(ev: any): string {
  const s = ev?.data?.input_summary;
  // input_summary 是轨迹里的摘要字段；拿不到就退化为空串（不猜）
  return typeof s?.command === "string" ? s.command : "";
}

function filePathOf(ev: any): string {
  const s = ev?.data?.input_summary;
  return typeof s?.file_path === "string" ? s.file_path : "";
}

/**
 * 信号表。**每一条都必须指到源字段**（文件头铁律 2）。
 *
 * 段名与来源：`packages/core/src/config/system-prompt.ts` 的 `buildSystemPrompt` 里
 * `coreParts.push(...)` 序列。新增段时在这里补一行；定义不出可数信号就照实写
 * `count: () => null` 并把理由写在 definition 里。
 */
export const SIGNALS: PromptSectionSignal[] = [
  {
    section: "<scheduling-capability>",
    definition:
      "cron_create / schedule_wakeup / cron_list / cron_delete 的 PreToolUse 次数（data.tool_name）",
    count: (c) =>
      ["cron_create", "schedule_wakeup", "cron_list", "cron_delete"].reduce(
        (a, n) => a + (c.toolCalls.get(n) ?? 0),
        0,
      ),
  },
  {
    section: "<waiting-capability>",
    definition:
      "monitor 的 PreToolUse 次数 + bash 命令里出现 `sid-wait` 的次数（data.tool_name / data.input_summary.command）",
    count: (c) =>
      (c.toolCalls.get("monitor") ?? 0) +
      c.bashCommands.filter((cmd) => cmd.includes("sid-wait")).length,
  },
  {
    section: "<subagent-result-policy>",
    definition:
      "read / read_many 的 file_path 命中子代理落盘的 `<tool-use-id>.output` 的次数（相对计数，绝对量天然偏低，见文件头局限）",
    // 落盘文件名由 task/disk-output.ts 生成：`${taskId}.output`，taskId 即工具调用 id
    // （形如 call_xxx）。只认这个形状，避免把普通 .output 文件算进来。
    count: (c) => c.readPaths.filter((p) => /(^|[/\\])call_[^/\\]+\.output$/.test(p)).length,
  },
  {
    section: "<context-management>",
    definition: "write 工具的 PreToolUse 次数（弱信号：混有大量与「落盘中间结果」无关的写文件）",
    weak: true,
    count: (c) => c.toolCalls.get("write") ?? 0,
  },
  {
    section: "<external-content-policy>",
    definition:
      "不可度量：该段约束的是「把外部内容当数据处理而不是当指令」，没有专属的可数行为——read 次数无法区分是否遇到了 <external-content> 包裹的不可信内容",
    count: () => null,
  },
  {
    section: "<identity> + <environment>",
    definition:
      "不可度量：身份与环境陈述不驱动任何专属行为（每个会话当然都会产生工具调用，但那不是这段规则的信号）",
    count: () => null,
  },
];

// ─────────────────────────── 扫描 ───────────────────────────

/** 一个会话目录里的 events.jsonl 是否存在且落在时间窗内 */
function sessionInWindow(dir: string, sinceMs: number): boolean {
  const p = join(dir, "events.jsonl");
  if (!existsSync(p)) return false;
  try {
    return statSync(p).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

/**
 * 扫一个轨迹根目录下的全部会话，累加出 ScanContext。
 *
 * 轨迹目录形态与 `defense-trigger-rate.ts` 一致：`<sessionsDir>/<sessionId>/events.jsonl`，
 * 每行一个 JSON 事件。坏行跳过（半写入的尾部行很常见，不该让整次度量失败）。
 */
export function scanEvents(sessionsDir: string, sinceMs = 0): ScanContext {
  const ctx: ScanContext = {
    toolCalls: new Map(),
    bashCommands: [],
    readPaths: [],
    writePaths: [],
  };
  if (!existsSync(sessionsDir)) return ctx;

  for (const id of readdirSync(sessionsDir)) {
    if (id.startsWith(".")) continue;
    const dir = join(sessionsDir, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!sessionInWindow(dir, sinceMs)) continue;

    let raw: string;
    try {
      raw = readFileSync(join(dir, "events.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev?.event !== "PreToolUse") continue;
      const name = ev?.data?.tool_name;
      if (typeof name !== "string") continue;
      ctx.toolCalls.set(name, (ctx.toolCalls.get(name) ?? 0) + 1);
      if (name === "bash") ctx.bashCommands.push(bashCommand(ev));
      else if (name === "read" || name === "read_many") ctx.readPaths.push(filePathOf(ev));
      else if (name === "write") ctx.writePaths.push(filePathOf(ev));
    }
  }
  return ctx;
}

// ─────────────────────────── 报告 ───────────────────────────

export interface SectionRow {
  section: string;
  definition: string;
  /** null = 不可度量。**不得**在渲染时折算成 0 */
  count: number | null;
  weak: boolean;
}

export function computeRows(
  ctx: ScanContext,
  signals: PromptSectionSignal[] = SIGNALS,
): SectionRow[] {
  return signals.map((s) => ({
    section: s.section,
    definition: s.definition,
    count: s.count(ctx),
    weak: s.weak === true,
  }));
}

/**
 * 渲染三列（信号定义 / 计数 / 是否可度量）。
 *
 * 为什么单独一列"是否可度量"而不是用 `—` 混在计数列里：两者的下一步动作相反——
 * 可度量且 0 触发 → 候选条件注入；不可度量 → 先补信号定义，别动。
 */
export function renderRows(rows: SectionRow[]): string[] {
  const L: string[] = [];
  L.push("段 / 信号定义 / 计数 / 是否可度量");
  for (const r of rows) {
    const measurable = r.count !== null;
    const mark = measurable ? (r.weak ? "可度量（弱信号，需抽检）" : "可度量") : "不可度量";
    L.push("");
    L.push(`■ ${r.section}`);
    L.push(`  信号定义：${r.definition}`);
    L.push(`  计数：${measurable ? r.count : "—"}`);
    L.push(`  是否可度量：${mark}`);
  }
  return L;
}
// ─────────────────────────── self-test ───────────────────────────

/**
 * 合成轨迹自测。CI runner 上没有 `~/.sid-code/`，聚合真实数据只会得到 n=0 的"报告"，
 * 而 n=0 看起来像数据、比没有报告更危险——所以 CI 只跑这一条。
 *
 * 断言两类东西：
 * A) 计数正确：喂什么事件就算出什么数（含 easy-to-get-wrong 的形状匹配）；
 * B) 口径正确：不可度量的段**不得**被算成 0，渲染时必须显式写"不可度量"。
 *
 * 返回失败原因列表（空 = 全绿）。
 */
export function selfTest(): string[] {
  const errors: string[] = [];
  const ev = (tool: string, summary: Record<string, unknown> = {}, event = "PreToolUse") =>
    JSON.stringify({ event, data: { tool_name: tool, input_summary: summary } });

  const lines = [
    ev("cron_create", {}),
    ev("schedule_wakeup", {}),
    ev("cron_list", {}),
    ev("cron_delete", {}),
    ev("monitor", {}),
    ev("bash", { command: "sid-wait gh-pr 42" }),
    ev("bash", { command: "echo hi" }),
    // 子代理落盘的 read：必须是 `${call_xxx}.output` 才算
    ev("read", { file_path: "/home/u/.sid-code/tasks/call_abc123.output" }),
    ev("read", { file_path: "/tmp/notes.output" }),
    ev("write", { file_path: "/tmp/a.md" }),
    ev("write", { file_path: "/tmp/b.md" }),
    // 非 PreToolUse 事件不该计数
    ev("bash", { command: "sid-wait gh-pr 43" }, "PostToolUse"),
    "not-json",
  ];

  const ctx: ScanContext = {
    toolCalls: new Map(),
    bashCommands: [],
    readPaths: [],
    writePaths: [],
  };
  // 直接喂内存事件：与 scanEvents 的解析分支同一段代码，避免为了 self-test 建临时目录
  for (const line of lines) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.event !== "PreToolUse") continue;
    const name = e.data.tool_name;
    ctx.toolCalls.set(name, (ctx.toolCalls.get(name) ?? 0) + 1);
    if (name === "bash") ctx.bashCommands.push(bashCommand(e));
    else if (name === "read" || name === "read_many") ctx.readPaths.push(filePathOf(e));
    else if (name === "write") ctx.writePaths.push(filePathOf(e));
  }

  const rows = computeRows(ctx);
  const get = (s: string) => rows.find((r) => r.section === s);

  const expectCount = (section: string, want: number) => {
    const r = get(section);
    if (!r) return errors.push(`信号表里没有 ${section}`);
    if (r.count !== want) errors.push(`${section}: 期望 ${want}，实得 ${r.count}`);
  };

  expectCount("<scheduling-capability>", 4);
  expectCount("<waiting-capability>", 2); // monitor 1 + sid-wait 1（PostToolUse 的那条不算）
  expectCount("<subagent-result-policy>", 1); // /tmp/notes.output 不算
  expectCount("<context-management>", 2);

  // 不可度量不得退化成 0
  for (const section of ["<external-content-policy>", "<identity> + <environment>"]) {
    const r = get(section);
    if (!r) {
      errors.push(`信号表里没有 ${section}`);
      continue;
    }
    if (r.count !== null)
      errors.push(`${section}: 定义不出信号却给出了计数 ${r.count}（应是 null）`);
    const text = renderRows(rows).join("\n");
    const block = text.slice(text.indexOf(`■ ${section}`));
    const seg = block.slice(0, block.indexOf("■ ", 2) === -1 ? undefined : block.indexOf("■ ", 2));
    if (!seg.includes("不可度量")) errors.push(`${section}: 渲染里没有显式写「不可度量」`);
  }

  // 弱信号必须在渲染里被标出来，否则会被当成与强信号同档的证据
  const cm = renderRows(rows).join("\n");
  if (!/context-management>[\s\S]*?需抽检/.test(cm)) errors.push("弱信号未在渲染中标注");

  return errors;
}

// ─────────────────────────── CLI ───────────────────────────

/** 本脚本认得的全部 flag。未识别 flag 必须早退（同 northstar-snapshot 的 --health 教训） */
export const KNOWN_FLAGS = new Set(["--json", "--days", "--dir", "--self-test"]);

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));

  const unknown = [...flags].filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    process.stderr.write(
      `⚠ 未识别参数: ${unknown.join(" ")}\n可用参数: ${[...KNOWN_FLAGS].join(" ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (flags.has("--self-test")) {
    const errors = selfTest();
    if (errors.length > 0) {
      process.stderr.write("❌ prompt-section-signal-rate self-test 失败:\n");
      for (const e of errors) process.stderr.write(`  · ${e}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      "✅ prompt-section-signal-rate self-test 通过（合成轨迹，未读真实数据）\n",
    );
    return;
  }

  const daysRaw = argOf(args, "--days");
  const days = daysRaw === undefined ? 30 : Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write(`⚠ --days 需要一个正数，实得: ${daysRaw}\n`);
    process.exitCode = 1;
    return;
  }
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const dirArg = argOf(args, "--dir");
  const sessionsDir = dirArg ?? resolvePaths().sessionsDir;
  if (!existsSync(sessionsDir)) {
    process.stderr.write(`未找到轨迹目录：${sessionsDir}\n`);
    process.exitCode = 1;
    return;
  }

  const ctx = scanEvents(sessionsDir, sinceMs);
  const rows = computeRows(ctx);

  if (flags.has("--json")) {
    process.stdout.write(JSON.stringify({ days, sessionsDir, rows }, null, 2) + "\n");
    return;
  }

  const totalTools = [...ctx.toolCalls.values()].reduce((a, b) => a + b, 0);
  const head = [
    "═══ 提示词分段信号计数（D-11 第一步）═══",
    `轨迹目录：${sessionsDir}`,
    `时间窗：最近 ${days} 天   工具调用总数：${totalTools}`,
    "⚠ 这是全局行为信号，不是「因为这段而调」的归因；零信号 ≠ 该段无效（见脚本文件头「已知局限」）",
  ];
  process.stdout.write([...head, "", ...renderRows(rows)].join("\n") + "\n");
}

if (import.meta.main) main();
