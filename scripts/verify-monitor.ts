#!/usr/bin/env bun
/**
 * verify-monitor —— monitor 缺陷的自动化验收（无人工）
 *
 * ## 它回答什么
 *
 * monitor 的四层实测（方案 20261109）暴露了 9 个缺陷，其中三个 P1 全在「退出路径」与
 * 「验收口径」上。这些问题**单测测不出来**：单测直调内部函数，而缺陷恰好长在真实入口
 * （`/quit` / 信号 / 崩溃 / 真实 `raw.jsonl`）与真实进程之间。本脚本是这些缺陷的验收工具：
 * 起真实 `-p` 会话、挂真实 monitor、发真实信号，断言只从轨迹与 `ps` 读。
 *
 * ## 三态（必须区分，否则会把「模型没按指令挂」误判成 PASS）
 *
 *   PASS    —— 全部断言通过
 *   FAIL    —— 修复未生效（或回归）
 *   INVALID —— 前置条件不成立（monitor 没挂上 / 场景没成立）→ 重跑该 case
 *
 * 为什么 INVALID 必须独立：`D1b-signal` 的断言是「宿主退出后子进程为空」，
 * 而模型若压根没挂 monitor，这个断言**天然成立**——把它算成 PASS 就是恒绿门禁。
 *
 * ## 五个 case（详见修复方案 §7.4 的表格）
 *
 * | case | 覆盖 | 修复前的预期 |
 * | --- | --- | --- |
 * | `D1b-signal` | D1-b 的 SIGHUP / SIGTERM 路径（每轮都跑 TERM + HUP） | FAIL |
 * | `D1b-sigkill` | D1-b 的 SIGKILL / OOM 路径（第 2 层启动扫描） | FAIL |
 * | `D2D3-audit` | D2 + D3（`wait-audit` 的 `monitor_ev` 口径） | FAIL |
 * | `D1b-orphan-scan-negative` | D1-b 第 2 层的**反向**用例：多会话不误杀 | PASS（无判据意义，见下） |
 * | `D4-discovery` | D4（模型是否自然发现 monitor） | FAIL（大概率；FIX-0 实测 3/3 PASS，天花板已满） |
 * | `D4-discovery-checks` | D4 的强场景：逐项检查结果（前台轮询的重灾区），判据只认实际调用 | FIX-3 采的修复前基线 |
 * | `D5-events` | D5（events.jsonl 的 MonitorEvent 条数 / seq 连续 / task_id 一致） | FAIL（D5 前 MonitorEvent 恒 0 条） |
 *
 * ⚠️ `D1b-orphan-scan-negative` 在启动扫描实现之前**恒 PASS**（没有扫描 → 自然不误杀）。
 * 它证明的是「没有误杀」，「该杀的杀了」由 `D1b-sigkill` 第 2 步负责，两条必须成对看。
 *
 * ## 两条硬口径（改脚本前先读）
 *
 * 1. **不读屏幕、不开 TUI**。`/quit` 在 `-p` 下不可用（`runHeadless` 直接拒绝），
 *    所以 D1 的 `case "quit"` 分支由单测覆盖（`D1-quit`），本脚本只覆盖信号路径。
 *    断言只允许来自 `events.jsonl` / `session.traj` / `ps` / `process.kill(pid, 0)`。
 * 2. **case 之间目录独立，case 内多次启动必须复用同一 `SID_CONFIG_DIR`**。
 *    D1-b 第 2 层的孤儿元数据落在 `sidPaths.tasks()`（由 `SID_CONFIG_DIR` 派生）：
 *    `D1b-sigkill` 第二次启动若换目录，启动扫描看不到第一次留下的孤儿元数据，
 *    第 5 步断言必 FAIL；`D1b-orphan-scan-negative` 的 A、B 若各用各的目录，
 *    B 根本扫不到 A 的元数据，「不误杀」是空真恒 PASS。
 *
 * 用法：
 *   bun scripts/verify-monitor.ts --case D1b-signal
 *   bun scripts/verify-monitor.ts --all
 *   bun scripts/verify-monitor.ts --all --json          # 机器可读，供 CI / 基线落盘
 *   bun scripts/verify-monitor.ts --case D4-discovery --binary ./sid-code-dev
 *
 * 退出码：有 FAIL 即 1；全 PASS / INVALID 为 0（INVALID 需人工重跑，不是修复失败）。
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

// ─────────────────────────── 类型 ───────────────────────────

export type Verdict = "PASS" | "FAIL" | "INVALID";

export type CaseName =
  | "D1b-signal"
  | "D1b-sigkill"
  | "D2D3-audit"
  | "D1b-orphan-scan-negative"
  | "D4-discovery"
  | "D4-discovery-checks"
  | "D5-events"
  | "D6-guidance-task-output"
  | "D6-guidance-workflow";

export const ALL_CASES: readonly CaseName[] = [
  "D1b-signal",
  "D1b-sigkill",
  "D2D3-audit",
  "D1b-orphan-scan-negative",
  "D4-discovery",
  "D4-discovery-checks",
  "D5-events",
  "D6-guidance-task-output",
  "D6-guidance-workflow",
] as const;

export interface Assertion {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface CaseResult {
  case: CaseName;
  verdict: Verdict;
  /** 一句话结论（INVALID 时写清为什么无效） */
  detail: string;
  assertions: Assertion[];
  /** 本 case 读的会话 id（便于人去轨迹里复查） */
  session?: string;
  durationMs: number;
}

/** events.jsonl 的一行（只列本脚本用到的字段） */
export interface TraceEvent {
  event?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

/** session.traj 的一行（只列本脚本用到的字段） */
export interface TrajStep {
  message_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  content?: unknown;
  thought?: unknown;
  action?: unknown;
}

// ─────────────────────────── 常量 ───────────────────────────

/** monitor 事件批处理窗口（monitor-task.ts 的 EVENT_BATCH_MS）。D2D3-audit 的行间隔必须大于它 */
export const EVENT_BATCH_MS = 200;

/**
 * 真实配置根（与 sid-code 的解析优先级一致）。
 * ⚠️ 不要写死 `~/.sid-code`：用户可能把配置放在 SID_CODE_HOME / CLAUDE_CONFIG_DIR，
 *    那样复制 settings.json 会失败或拿到空配置，脚本表现成「没有 provider」这种难归因的失败。
 */
const SID_HOME =
  process.env.SID_CONFIG_DIR ||
  process.env.SID_CODE_HOME ||
  process.env.CLAUDE_CONFIG_DIR ||
  join(homedir(), ".sid-code");

/** 仓库根（脚本所在目录的上一级）——构建产物在这里，脚本从任意 cwd 跑都成立 */
const REPO_ROOT = join(import.meta.dir, "..");

/**
 * 排除「无头宿主自己」的正则。
 *
 * `-p` 会话的 argv 里带着 prompt，prompt 里带着带 token 的监控命令 ——
 * 不排除的话，**宿主自己会被算成 monitor 子进程**：① 宿主活着时 monitorPids() 永远非空；
 * ② D1b-sigkill 第二次启动（宿主 argv 同样含 token）的断言必失败。
 *
 * 宿主的二进制名有四个（`sid-code` / `sid-code-dev` / `sc` / `sc-dev`，见 CONTRIBUTING.md
 * 「双版本并存」）——漏了 `sc-dev` 会把「用推荐名验证本地改动」的会话算进 monitor 进程。
 * 也排除 `bun` / `node` 直跑源码的形态（argv 含 entrypoints/bootstrap.ts + -p）。
 */
// ⚠️ `sc(-dev)?` 的 `?` 不能省：`sc` 是四个二进制名之一，漏了它会让用 `sc` 验证的
// 会话被算成 monitor 子进程（单测里专门有一条覆盖这个形态）。
const HOST_HEADLESS_RE = /(sid-code(-dev)?|sc(-dev)?)\s+-p\b/;
const BUN_SOURCE_RE = /(bun|node)\s+.*entrypoints\/bootstrap\.ts\s/;
/**
 * 按 argv 形态排除宿主：`startHeadless` 起宿主固定带 `-p --dangerously-skip-permissions`，
 * monitor 子进程（`zsh -c <脚本>`）的命令行永远不含这一段。
 *
 * ⚠️ 只靠上面的二进制名正则不够：`--binary` 可以指向任意文件名。FIX-1 做端到端变异自证时
 * 用 `--binary /tmp/…/sid-code-mutC`，`sid-code-mutC -p` 不匹配 HOST_HEADLESS_RE，A 的宿主
 * （argv 带 token）被算成「A 的 monitor 子进程仍存活」——monitor 其实已被误杀，
 * 这条断言假通过，只靠 events 那条断言才判出 FAIL（2026-11-10 实测）。
 */
const HOST_ARGV_RE = /\s-p\s+--dangerously-skip-permissions\b/;

/**
 * 「启动扫描清理了孤儿 monitor」的日志匹配。
 *
 * ⚠️ 文案由 D1-b 第 2 层的实现决定，这里只认「同一行里既有 monitor 又有清理语义」。
 * 该实现调整日志措辞后，同步更新这两个模式（本文件是验收基建，随修复迭代是正常的）。
 */
const ORPHAN_LOG_MONITOR_RE = /monitor/i;
const ORPHAN_LOG_CLEAN_RE = /(orphan|孤儿|遗留|清理|回收|kill|终止|stale)/i;

// ─────────────────────────── 纯函数（单测覆盖，不碰进程/文件系统） ───────────────────────────

/** 生成 case 级唯一步骤 token：pid 定位、事件正文、日志断言都靠它 */
export function makeToken(tag: string, now = Date.now()): string {
  return `VERIFY${now}${tag.replace(/[^A-Za-z0-9]/g, "")}`;
}

/**
 * 从 `ps -Ao pid=,command=` 的输出里挑出 monitor 子进程 pid。
 *
 * 三条过滤规则（都踩过）：
 * 1. 只留命令行含 token 的行——monitor 子进程是 `bash -c "<含 token 的脚本>"`；
 * 2. 排除无头宿主（见 HOST_HEADLESS_RE / BUN_SOURCE_RE / HOST_ARGV_RE）；
 * 3. 首列必须是数字 pid。
 */
export function filterMonitorPids(psOutput: string, token: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.trim() || !line.includes(token)) continue;
    if (HOST_HEADLESS_RE.test(line) || BUN_SOURCE_RE.test(line) || HOST_ARGV_RE.test(line)) {
      continue;
    }
    const m = /^\s*(\d+)\s+\S/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

export interface MonitorEventScan {
  /** TaskLifecycle{phase:started, task_type:local_monitor} */
  started: boolean;
  /** WaitRegistered{kind:monitor} */
  registered: boolean;
  /** TaskLifecycle{phase:completed, task_type:local_monitor} */
  completed: boolean;
  /** TaskLifecycle{phase:completed} 的 status（killed / completed / failed） */
  completedStatus?: string;
  /** WaitReleased{kind:monitor} */
  released: boolean;
}

/**
 * 扫一遍 events.jsonl，回答「monitor 这一生落了哪些关键事件」。
 *
 * 只按 `task_type === "local_monitor"` 与 `kind === "monitor"` 过滤，不依赖 task_id：
 * 一个会话里可能挂多个 monitor，验收只关心「有没有落终态」这件事（按 id 关联是 D3 的活）。
 */
export function scanMonitorEvents(events: TraceEvent[]): MonitorEventScan {
  const out: MonitorEventScan = {
    started: false,
    registered: false,
    completed: false,
    released: false,
  };
  for (const e of events) {
    const d = e.data ?? {};
    if (e.event === "TaskLifecycle" && d.task_type === "local_monitor") {
      if (d.phase === "started") out.started = true;
      if (d.phase === "completed") {
        out.completed = true;
        if (typeof d.status === "string") out.completedStatus = d.status;
      }
    }
    if (e.event === "WaitRegistered" && d.kind === "monitor") out.registered = true;
    if (e.event === "WaitReleased" && d.kind === "monitor") out.released = true;
  }
  return out;
}

/**
 * 解析 `scripts/wait-audit.ts` 的人类可读输出。
 *
 * 只认两个字段：`monitor_ev=N`（或 `n/a`，未读 raw 时）与 `violations=N`。
 * 解析失败返回 null —— 调用方必须把「读不到」判成 INVALID/FAIL，不能默认 0。
 */
export function parseWaitAuditOutput(stdout: string): {
  monitorEv: number | null;
  violations: number | null;
} {
  const me = /monitor_ev=(n\/a|\d+)/.exec(stdout);
  const vi = /violations=(\d+)/.exec(stdout);
  return {
    monitorEv: me ? (me[1] === "n/a" ? null : Number(me[1])) : null,
    violations: vi ? Number(vi[1]) : null,
  };
}

export interface DiscoverySignal {
  /** 轨迹里真的调用了目标工具 */
  called: boolean;
  /** tool_search 的 query 里搜过目标工具（`select:<target>` 等） */
  searched: boolean;
  /** assistant 文本（含思考）提到过目标工具 —— 弱命中：想到了，但不确定用没用 */
  mentioned: boolean;
}

/**
 * D4/D6 的判据：模型有没有把目标工具纳入候选集。
 *
 * target 缺省 "monitor"（D4 的两个 case）。FIX-5 的 D6-guidance 场景测试
 * （task_output / workflow）传各自工具名——判据同 D4-discovery：调用 /
 * tool_search 搜过 / 回复提到，任一即命中。
 *
 * 为什么要读 session.traj 而不是 events：events 的 `PreToolUse` 只有 `tool_name` / `tool_use_id`，
 * **没有 query 与工具参数**——「搜过」只能从 traj 的 `tool_input` 读。
 *
 * ⚠️ 只看 assistant 侧文本（content / thought / action），跳过 observation：
 * observation 里可能带工具返回的文本，把它算成「模型提到」会假阳性。
 */
export function analyzeDiscovery(
  events: TraceEvent[],
  traj: TrajStep[],
  target = "monitor",
): DiscoverySignal {
  // 工具名是 [a-z0-9_]，转小写后做子串匹配即可（called 是全等，searched/mentioned 是包含）
  const needle = target.toLowerCase();
  let called = false;
  for (const e of events) {
    const name = e.data?.tool_name;
    if (typeof name === "string" && name === target) called = true;
  }
  let searched = false;
  let mentioned = false;
  for (const step of traj) {
    if (step.message_type === "observation") continue;
    if (step.tool_name === target) called = true;
    if (step.tool_name === "tool_search") {
      const q = step.tool_input?.query;
      if (typeof q === "string" && q.toLowerCase().includes(needle)) searched = true;
    }
    const text = [step.content, step.thought, step.action]
      .filter((x): x is string => typeof x === "string")
      .join("\n");
    if (text.toLowerCase().includes(needle)) mentioned = true;
  }
  return { called, searched, mentioned };
}

/** 从启动日志（audit.log / debug.log / stderr）里找孤儿 monitor 清理记录 */
export function findOrphanCleanupLog(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!ORPHAN_LOG_MONITOR_RE.test(line)) continue;
    if (!ORPHAN_LOG_CLEAN_RE.test(line)) continue;
    return line.trim().slice(0, 300);
  }
  return null;
}

/**
 * 三态合成：INVALID 优先级最高（前置条件不成立时，断言结果没有意义）。
 * assertions 为空也算 INVALID——一个「什么都没断言」的 case 不能判 PASS。
 */
export function verdictOf(assertions: Assertion[], invalidReason?: string | null): Verdict {
  if (invalidReason) return "INVALID";
  if (assertions.length === 0) return "INVALID";
  return assertions.every((a) => a.pass) ? "PASS" : "FAIL";
}

export interface CliOptions {
  cases: CaseName[];
  json: boolean;
  binary?: string;
  help: boolean;
}

/** 解析 CLI 参数（纯函数，便于单测口径） */
export function parseArgs(argv: string[]): CliOptions {
  const cases: CaseName[] = [];
  let json = false;
  let binary: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") {
      cases.push(...ALL_CASES);
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--case") {
      const v = argv[++i];
      if (!v || !(ALL_CASES as readonly string[]).includes(v)) {
        throw new Error(`未知 case: ${v ?? "(缺失)"}；可选：${ALL_CASES.join(" / ")}`);
      }
      if (!cases.includes(v as CaseName)) cases.push(v as CaseName);
    } else if (a === "--binary") {
      binary = argv[++i];
      if (!binary) throw new Error("--binary 需要一个路径");
    } else {
      throw new Error(`未知参数: ${a}（用 --help 看用法）`);
    }
  }
  // 去重（--all 与 --case 混用时）
  const dedup = [...new Set(cases)];
  return { cases: dedup, json, binary, help };
}

// ─────────────────────────── 执行原语 ───────────────────────────

/**
 * 轮询等待条件成立（最多 timeoutMs），返回最终结果。
 *
 * ⚠️ **必须用异步 sleep**（`await Bun.sleep`），不能用 `Bun.sleepSync`：
 * 同步睡眠会**阻塞事件循环**，而 `HeadlessSession.waitExit` 依赖 child 的 `exit` 事件 /
 * `exitCode` 更新——事件回调排在事件循环里，同步睡眠期间永远不执行。
 * 实测后果：宿主 SIGTERM 后 213ms 就已退出（ps 显示 Z），但断言仍报「5s 内未退出」。
 */
async function waitFor(fn: () => boolean, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await Bun.sleep(intervalMs);
  }
  return fn();
}

function psOutput(): string {
  try {
    return execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function monitorPids(token: string): number[] {
  return filterMonitorPids(psOutput(), token);
}

/**
 * 杀一个进程/进程组。
 *
 * monitor 子进程是 `detached: true` 的进程组组长（为了 `kill(-pid)` 清孙进程），
 * 所以先试 `kill(-pid)`；失败（不是组长 / 已退出）再退回单 pid。
 */
function killTree(pid: number, sig: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(-pid, sig);
    return;
  } catch {
    /* 不是进程组组长，退回单 pid */
  }
  try {
    process.kill(pid, sig);
  } catch {
    /* 已退出 */
  }
}

/** case 级清理：宿主 + monitor 子进程 + case 自建的辅助进程（如 D4 的写文件循环） */
function cleanup(pid: number | undefined, token: string, extraPids: number[] = []): void {
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  for (const p of monitorPids(token)) killTree(p);
  for (const p of extraPids) killTree(p);
}

function readTextFile(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readEvents(sessionDir: string): TraceEvent[] {
  const p = join(sessionDir, "events.jsonl");
  const out: TraceEvent[] = [];
  for (const line of readTextFile(p).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as TraceEvent);
    } catch {
      // events.jsonl 可能因进程被杀留下半行：跳过，不让一行坏数据废掉整份验收
    }
  }
  return out;
}

function readTraj(sessionDir: string): TrajStep[] {
  const parsed = readTextFile(join(sessionDir, "session.traj"));
  if (!parsed) return [];
  try {
    const d = JSON.parse(parsed) as TrajStep[] | { trajectory?: TrajStep[] };
    return Array.isArray(d) ? d : (d.trajectory ?? []);
  } catch {
    return [];
  }
}

interface HeadlessSession {
  pid: number;
  /** 本会话的 SID_CONFIG_DIR（D1b-sigkill / negative 的多次启动必须复用它） */
  dir: string;
  /** 最近一次 mtime 的会话目录（同一 dir 多次启动时取最新） */
  sessionDir: () => string | null;
  sessionId: () => string | null;
  /** 已累积的 stdout + stderr（D1b-sigkill 的日志断言会读它） */
  output: () => string;
  /**
   * 宿主是否已退出。
   *
   * ⚠️ 必须用 child 的 exit 事件，**不能**用 `kill(pid, 0)`：宿主是本脚本 spawn 的
   * 直接子进程，退出后先进入僵尸态（未被 wait 回收），`kill(pid, 0)` 仍然成功 ——
   * 实测「SIGTERM 后 5s 内退出」因此恒判失败。
   */
  hasExited: () => boolean;
  waitExit: (timeoutMs: number) => Promise<boolean>;
}

function resolveBinary(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`--binary 指定的文件不存在: ${explicit}`);
    return explicit;
  }
  for (const name of ["sid-code", "sid-code-dev"]) {
    const p = join(REPO_ROOT, name);
    if (existsSync(p)) return p;
  }
  throw new Error(`找不到构建产物 ${join(REPO_ROOT, "sid-code")}，先 make build`);
}

/**
 * 起一个隔离的 `-p` 会话。
 *
 * prompt 必须由调用方传入：D1b-sigkill 的**第二次启动必须用「不挂 monitor」的 prompt**，
 * 否则它自己会再挂一个 monitor，`monitorPids()` 永远非空。
 *
 * reuseDir：同一个 case 内多次启动传**同一个目录**（孤儿元数据落在 SID_CONFIG_DIR 派生的
 * `sidPaths.tasks()`，换目录 = 启动扫描看不到，见文件头硬口径 2）。
 */
/**
 * @param cwd 会话工作目录。缺省为仓库根（D1/D2 系列 case 与发现性无关，沿用历史行为）。
 *   ⚠️ 发现性 case（D4-*）必须传一个**非 git 目录**：仓库根的 git 快照会把当前分支名 /
 *   最近提交写进系统提示，分支名形如 `fix/monitor-...` 时模型会把它读成「该用 monitor」
 *   的提示（FIX-3 实测：20261110-140743-a17f940f 的思考里原话「分支名是 fix/monitor-waiting-capability，
 *   提示用 monitor 工具」），修复前基线因此被污染。
 */
function startHeadless(
  prompt: string,
  reuseDir?: string,
  cwd: string = REPO_ROOT,
): HeadlessSession {
  const dir = reuseDir ?? mkdtempSync(join(tmpdir(), "sid-verify-"));
  // 不带 settings.json 会没有 provider，模型调用直接失败——表现成难归因的 INVALID
  const src = join(SID_HOME, "settings.json");
  if (existsSync(src) && !existsSync(join(dir, "settings.json"))) {
    writeFileSync(join(dir, "settings.json"), readFileSync(src));
  }
  const child: ChildProcess = spawn(
    resolveBinary(optsBinary),
    ["-p", "--dangerously-skip-permissions", prompt],
    {
      // 构建产物在仓库根；spawn 用绝对路径二进制 + 绝对 cwd，脚本从任意 cwd 跑都成立
      cwd,
      env: { ...process.env, SID_CONFIG_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buf = "";
  child.stdout?.on("data", (d) => {
    buf += String(d);
  });
  child.stderr?.on("data", (d) => {
    buf += String(d);
  });
  // 宿主退出判定：必须靠 exit 事件，不能用 `kill(pid, 0)` —— 它是本脚本的直接子进程，
  // 退出后先进入僵尸态（未被 wait 回收），`kill(pid, 0)` 仍然成功。实测这会让
  // 「SIGTERM 后 5s 内退出」恒判失败（见 2026-11-10 的 D1b-signal 实跑）。
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const hasExited = (): boolean => exited || child.exitCode !== null || child.signalCode !== null;
  const pid = child.pid;
  if (!pid) throw new Error("spawn 失败：没有 pid");
  const sessionDir = (): string | null => {
    const base = join(dir, "trajectories", "sessions");
    if (!existsSync(base)) return null;
    const ids = readdirSync(base)
      .map((n) => ({ n, t: statSync(join(base, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return ids[0] ? join(base, ids[0].n) : null;
  };
  return {
    pid,
    dir,
    sessionDir,
    sessionId: () => {
      const d = sessionDir();
      return d ? basename(d) : null;
    },
    output: () => buf,
    hasExited,
    waitExit: (timeoutMs: number) => waitFor(hasExited, timeoutMs, 200),
  };
}

/** 发现性 case 的工作目录：tmpdir 下新建的空目录（tmpdir 不在任何 git 仓库里） */
function makeNonGitWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "sid-verify-ws-"));
}

/** 每行间隔 ≥ EVENT_BATCH_MS 的 5 行脚本：让「收尾事件」的时序可复现（D3 的成因） */
function buildTickScript(token: string, lines = 5, intervalSec = 0.5, total = lines): string {
  return `for i in $(seq 1 ${total}); do echo ${token}-tick-$i; sleep ${intervalSec}; done`;
}

/** 让模型挂一个长跑 monitor（200 行 × 1s，远超验收时长，保证信号到达时它还活着） */
function buildMonitorPrompt(token: string, timeoutMs: number): string {
  const cmd = `for i in $(seq 1 200); do echo ${token}-$i; sleep 1; done`;
  return (
    `用 tool_search 的 select:monitor 激活 monitor 工具，然后调用 monitor 监控这个脚本` +
    `（timeout_ms 设 ${timeoutMs}）：${cmd}`
  );
}

/** 读启动日志：audit.log 是零配置常驻的 WARN 日志（`log.warn("DIAG", …)` 会落这里） */
function readStartupLogs(dir: string, captured: string): string {
  const parts = [captured];
  for (const name of ["audit.log", "debug.log"]) {
    parts.push(readTextFile(join(dir, name)));
  }
  return parts.join("\n");
}

// optsBinary 由 main 设置（case 函数只关心「用哪个二进制」）
let optsBinary: string | undefined;

// ─────────────────────────── case 实现 ───────────────────────────

type CaseBody = Omit<CaseResult, "durationMs">;

/** 等会话落出 WaitRegistered（monitor 真的挂上了）——它是所有 case 的有效性前提 */
async function waitMonitorRegistered(
  s: HeadlessSession,
  timeoutMs = 90_000,
): Promise<string | null> {
  const ok = await waitFor(() => {
    const d = s.sessionDir();
    return d !== null && scanMonitorEvents(readEvents(d)).registered;
  }, timeoutMs);
  return ok ? s.sessionDir() : null;
}

interface SignalRound {
  assertions: Assertion[];
  invalid: string | null;
  session?: string;
}

/**
 * 一轮信号路径验收。
 *
 * 时序必须等 WaitRegistered 落盘再发信号：否则 monitor 还没挂上，杀进程只会留下
 * 「什么都没发生」的假 PASS（§7.4 的 D1b-signal 时序细节）。
 */
async function runSignalRound(signal: "SIGTERM" | "SIGHUP"): Promise<SignalRound> {
  const token = makeToken(signal);
  const s = startHeadless(buildMonitorPrompt(token, 300_000));
  try {
    const dir = await waitMonitorRegistered(s);
    if (!dir) {
      return {
        assertions: [],
        invalid: `90s 内等不到 WaitRegistered（monitor 没挂上，模型行为波动）`,
        session: s.sessionId() ?? undefined,
      };
    }
    try {
      process.kill(s.pid, signal);
    } catch {
      /* 已退出 */
    }
    const exited = await s.waitExit(5_000);
    // 宿主退出瞬间子进程可能还在被回收：给 3s 收敛，再判定「是否残留」
    await waitFor(() => monitorPids(token).length === 0, 3_000, 200);
    const leaked = monitorPids(token);
    const ev = scanMonitorEvents(readEvents(dir));
    return {
      assertions: [
        {
          name: `${signal} 后 5s 内 sid-code 退出`,
          pass: exited,
          detail: exited ? undefined : "宿主仍在运行",
        },
        {
          name: `${signal} 后 monitor 子进程为空`,
          pass: leaked.length === 0,
          detail: leaked.length > 0 ? `残留 pid ${leaked.join(",")}（PPID=1 的孤儿）` : undefined,
        },
        {
          name: "events 落 monitor 终态（TaskLifecycle{completed} + WaitReleased）",
          pass: ev.completed && ev.released,
          detail: `completed=${ev.completed}(${ev.completedStatus ?? "-"}) released=${ev.released} registered=${ev.registered}`,
        },
      ],
      invalid: null,
      session: basename(dir),
    };
  } finally {
    cleanup(s.pid, token);
  }
}

/**
 * D1-b 的信号路径（SIGHUP / SIGTERM）。
 *
 * 两条信号都跑：它们共用 `onSignal`，但 SIGHUP 有单独的接管逻辑（防 SessionEnd 丢失），
 * 只测 TERM 会漏掉「HUP 分支忘了调清理」这种改法。
 */
async function runD1bSignal(): Promise<CaseBody> {
  const rounds: Array<{ signal: "SIGTERM" | "SIGHUP"; r: SignalRound }> = [];
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    rounds.push({ signal, r: await runSignalRound(signal) });
  }
  const assertions = rounds.flatMap(({ signal, r }) =>
    r.assertions.map((a) => ({ ...a, name: `[${signal}] ${a.name}` })),
  );
  const invalid = rounds.find((x) => x.r.invalid)?.r.invalid ?? null;
  const sessions = rounds.map((x) => x.r.session).filter((x): x is string => typeof x === "string");
  const ok = assertions.length > 0 && assertions.every((a) => a.pass);
  return {
    case: "D1b-signal",
    verdict: verdictOf(assertions, invalid),
    detail: invalid
      ? invalid
      : ok
        ? "TERM 与 HUP 两条信号路径都已清理子进程并落终态"
        : "信号路径未清理 monitor 子进程 / 终态事件缺失",
    assertions,
    session: sessions.join(",") || undefined,
  };
}

/**
 * D1-b 的 SIGKILL / OOM 路径（第 2 层兜底：启动扫描）。
 *
 * 两次启动必须复用同一个 SID_CONFIG_DIR：孤儿元数据落在它派生的 `sidPaths.tasks()`，
 * 换目录时启动扫描扫的是新目录，看不到上一轮留下的孤儿元数据（见文件头硬口径 2）。
 */
async function runD1bSigkill(): Promise<CaseBody> {
  const token = makeToken("sigkill");
  const dir = mkdtempSync(join(tmpdir(), "sid-verify-sigkill-"));
  const first = startHeadless(buildMonitorPrompt(token, 300_000), dir);
  let second: HeadlessSession | undefined;
  try {
    const firstDir = await waitMonitorRegistered(first);
    if (!firstDir) {
      return {
        case: "D1b-sigkill",
        verdict: "INVALID",
        detail: "90s 内等不到 WaitRegistered（monitor 没挂上，模型行为波动）",
        assertions: [],
        session: first.sessionId() ?? undefined,
      };
    }
    // 模拟 OOM / kill -9：不可捕获，宿主侧第 1 层没有任何机会执行
    try {
      process.kill(first.pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
    await first.waitExit(5_000);
    await Bun.sleep(1_000);
    const surviving = monitorPids(token);
    if (surviving.length === 0) {
      // 基线不成立：子进程已经没了，无法区分「启动扫描清掉了」还是「它自己结束」
      return {
        case: "D1b-sigkill",
        verdict: "INVALID",
        detail: "SIGKILL 后 monitor 子进程已消失，第 2 层兜底无法验证（基线不成立）",
        assertions: [],
        session: first.sessionId() ?? undefined,
      };
    }
    // 第二次启动：prompt 明确不挂 monitor，只为触发启动扫描
    second = startHeadless("只回复 ok，不要调用任何工具。", dir);
    await second.waitExit(120_000);
    await Bun.sleep(500); // 等 stderr 管道 flush（日志断言读它）
    // 扫描发生在启动早期；给 10s 收敛
    await waitFor(() => monitorPids(token).length === 0, 10_000, 200);
    const remaining = monitorPids(token);
    const logHit = findOrphanCleanupLog(readStartupLogs(dir, second.output()));
    const assertions: Assertion[] = [
      {
        name: "基线：SIGKILL 后 monitor 子进程仍存活（证明第 1 层修不了）",
        pass: true,
        detail: `pid ${surviving.join(",")} 在宿主死后仍运行`,
      },
      {
        name: "第二次启动后 monitor 子进程为空（该杀的杀了）",
        pass: remaining.length === 0,
        detail: remaining.length > 0 ? `仍残留 pid ${remaining.join(",")}` : undefined,
      },
      {
        name: "启动日志有孤儿 monitor 清理记录",
        pass: logHit !== null,
        detail: logHit ?? "未命中（启动扫描定稿日志文案后同步更新本脚本的匹配模式）",
      },
    ];
    return {
      case: "D1b-sigkill",
      verdict: verdictOf(assertions),
      detail: assertions.every((a) => a.pass)
        ? "SIGKILL 留下的孤儿子进程已被下次启动的扫描清理"
        : remaining.length > 0
          ? "启动扫描未清理孤儿 monitor（第 2 层兜底缺失 / 未生效）"
          : "子进程已清理，但启动日志没有清理记录",
      assertions,
      session: first.sessionId() ?? undefined,
    };
  } finally {
    cleanup(first.pid, token);
    if (second) cleanup(second.pid, token);
  }
}

/**
 * D1-b 第 2 层的**反向用例**：多会话共享配置目录时，启动扫描不能误杀别人正在用的 monitor。
 *
 * A、B 必须共用同一 SID_CONFIG_DIR（真实场景就是多个 sid-code 会话共享 `~/.sid-code`）：
 * 各用各的目录时 B 根本扫不到 A 的元数据，「不误杀」是空真恒 PASS，反向用例形同虚设。
 *
 * ⚠️ 启动扫描实现之前本 case 恒 PASS —— 它证明的是「没有误杀」，
 *    「该杀的杀了」由 `D1b-sigkill` 负责，两条必须成对看。
 */
async function runD1bOrphanScanNegative(): Promise<CaseBody> {
  const token = makeToken("negative");
  const dir = mkdtempSync(join(tmpdir(), "sid-verify-negative-"));
  const a = startHeadless(buildMonitorPrompt(token, 300_000), dir);
  let b: HeadlessSession | undefined;
  try {
    const aDir = await waitMonitorRegistered(a);
    if (!aDir) {
      return {
        case: "D1b-orphan-scan-negative",
        verdict: "INVALID",
        detail: "A 会话 90s 内等不到 WaitRegistered（monitor 没挂上，模型行为波动）",
        assertions: [],
        session: a.sessionId() ?? undefined,
      };
    }
    // B：不挂 monitor，启动后自然退出；它启动时会跑启动扫描
    b = startHeadless("只回复 ok，不要调用任何工具。", dir);
    const bExited = await b.waitExit(120_000);
    await Bun.sleep(2_000); // 给 B 的启动扫描时间
    const aMonitorAlive = monitorPids(token).length > 0;
    const ev = scanMonitorEvents(readEvents(aDir));
    const assertions: Assertion[] = [
      {
        name: "B 的启动扫描确实跑过（B 已退出）",
        pass: bExited,
        detail: bExited ? undefined : "B 未在 120s 内退出，扫描可能没发生",
      },
      {
        name: "A 的 monitor 子进程仍存活（未被 B 的启动扫描误杀）",
        pass: aMonitorAlive,
        detail: aMonitorAlive
          ? "A 的子进程仍在运行"
          : "A 的子进程消失：启动扫描误杀了父进程还活着的 monitor",
      },
      {
        name: "A 的 events 没有 completed / WaitReleased（未被误判终态）",
        pass: !ev.completed && !ev.released,
        detail: `completed=${ev.completed} released=${ev.released}`,
      },
    ];
    return {
      case: "D1b-orphan-scan-negative",
      verdict: verdictOf(assertions),
      detail: assertions.every((a2) => a2.pass)
        ? "B 的启动扫描没有误杀 A 正在使用的 monitor"
        : "启动扫描误杀了父进程仍存活的 monitor（本 FIX 最容易写错的地方）",
      assertions,
      session: a.sessionId() ?? undefined,
    };
  } finally {
    cleanup(a.pid, token);
    if (b) cleanup(b.pid, token);
  }
}

/**
 * D2 + D3：`wait-audit` 的 `monitor_ev` 口径。
 *
 * 脚本只跑 5 行、每行间隔 0.5s 后 exit 0（不是长脚本 + kill）：
 * 只有脚本自己正常结束，「WaitReleased 与最后一批事件」的时序关系才可复现（D3 的成因）。
 * 每行间隔必须 ≥ EVENT_BATCH_MS（200ms）：批处理窗口内的行会合并成**一条**事件，
 * 无间隔连打 5 行只会产生 1 条，`monitor_ev=5` 恒 FAIL。
 */
async function runD2D3Audit(): Promise<CaseBody> {
  const token = makeToken("audit");
  const lines = 5;
  const cmd = buildTickScript(token, lines, 0.5);
  const prompt =
    `用 tool_search 的 select:monitor 激活 monitor 工具，然后调用 monitor 监控这个脚本` +
    `（timeout_ms 设 60000）：${cmd}`;
  const s = startHeadless(prompt);
  try {
    const dir = await waitMonitorRegistered(s);
    if (!dir) {
      return {
        case: "D2D3-audit",
        verdict: "INVALID",
        detail: "90s 内等不到 WaitRegistered（monitor 没挂上，模型行为波动）",
        assertions: [],
        session: s.sessionId() ?? undefined,
      };
    }
    const sessionId = basename(dir);
    // monitor 5 秒内跑完，宿主随后收尾；给足 180s（含模型多轮）
    await s.waitExit(180_000);
    await Bun.sleep(1_000); // 等 events/raw 落盘 flush
    const ev = scanMonitorEvents(readEvents(dir));
    if (!ev.completed) {
      return {
        case: "D2D3-audit",
        verdict: "INVALID",
        detail: "monitor 没有跑到终态（会话被中断 / 模型没挂上），事件数断言无意义",
        assertions: [],
        session: sessionId,
      };
    }
    let stdout = "";
    try {
      stdout = execFileSync("bun", ["scripts/wait-audit.ts", sessionId, "--with-raw"], {
        cwd: REPO_ROOT,
        env: { ...process.env, SID_CONFIG_DIR: s.dir },
        encoding: "utf8",
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      stdout = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? e.message ?? "");
    }
    const parsed = parseWaitAuditOutput(stdout);
    const assertions: Assertion[] = [
      {
        name: "wait-audit 输出能被解析（monitor_ev / violations）",
        pass: parsed.monitorEv !== null && parsed.violations !== null,
        detail: stdout.trim().slice(0, 300) || "(无输出)",
      },
      {
        name: `monitor_ev === ${lines}（${lines} 行、每行间隔 ≥${EVENT_BATCH_MS}ms）`,
        pass: parsed.monitorEv === lines,
        detail: `实际 monitor_ev=${parsed.monitorEv ?? "n/a"}（D2 未修 → 0；D3 未修 → ${lines - 1}）`,
      },
      {
        name: "violations === 0",
        pass: parsed.violations === 0,
        detail: `实际 violations=${parsed.violations ?? "n/a"}`,
      },
    ];
    return {
      case: "D2D3-audit",
      verdict: verdictOf(assertions),
      detail: assertions.every((a) => a.pass)
        ? `wait-audit 数到了全部 ${lines} 条事件，无承诺违背`
        : `monitor_ev 口径不对（${parsed.monitorEv ?? "n/a"} ≠ ${lines}），D2/D3 未修好`,
      assertions,
      session: sessionId,
    };
  } finally {
    cleanup(s.pid, token);
  }
}

/**
 * D5：events.jsonl 里的 MonitorEvent 是否齐全、seq 是否连续。
 *
 * 与 D2D3-audit 同款会话（5 行、每行间隔 ≥ EVENT_BATCH_MS），断言全部从
 * events.jsonl 读——这是 D5 的点：monitor 事件的审计口径不再依赖解析 raw.jsonl。
 */
export interface MonitorEventCollection {
  /** MonitorEvent 的条数 */
  count: number;
  /** 按落盘顺序的 seq 值 */
  seqs: number[];
  /** 出现过的 task_id（去重） */
  taskIds: string[];
  /** dropped > 0 的条数（限流截断的现场计数，D5 验收第 2 条用） */
  droppedCount: number;
}

/** 收集 events.jsonl 里的 MonitorEvent（seq / task_id / dropped），供 D5-events 断言 */
export function collectMonitorEvents(events: TraceEvent[]): MonitorEventCollection {
  const seqs: number[] = [];
  const taskIds = new Set<string>();
  let droppedCount = 0;
  for (const e of events) {
    if (e.event !== "MonitorEvent") continue;
    const seq = e.data?.seq;
    const taskId = e.data?.task_id;
    if (typeof seq === "number") seqs.push(seq);
    if (typeof taskId === "string") taskIds.add(taskId);
    if (typeof e.data?.dropped === "number" && e.data.dropped > 0) droppedCount++;
  }
  return { count: seqs.length, seqs, taskIds: [...taskIds], droppedCount };
}

async function runD5Events(): Promise<CaseBody> {
  const token = makeToken("d5ev");
  const lines = 5;
  const cmd = buildTickScript(token, lines, 0.5);
  const prompt =
    `用 tool_search 的 select:monitor 激活 monitor 工具，然后调用 monitor 监控这个脚本` +
    `（timeout_ms 设 60000）：${cmd}`;
  const s = startHeadless(prompt);
  try {
    const dir = await waitMonitorRegistered(s);
    if (!dir) {
      return {
        case: "D5-events",
        verdict: "INVALID",
        detail: "90s 内等不到 WaitRegistered（monitor 没挂上，模型行为波动）",
        assertions: [],
        session: s.sessionId() ?? undefined,
      };
    }
    const sessionId = basename(dir);
    await s.waitExit(180_000);
    await Bun.sleep(1_000); // 等 events 落盘 flush
    const scan = scanMonitorEvents(readEvents(dir));
    if (!scan.completed) {
      return {
        case: "D5-events",
        verdict: "INVALID",
        detail: "monitor 没有跑到终态（会话被中断 / 模型没挂上），事件数断言无意义",
        assertions: [],
        session: sessionId,
      };
    }
    const collected = collectMonitorEvents(readEvents(dir));
    // seq 连续 = 从 1 起逐一递增（1,2,…,count）；中间断号说明丢事件或计数错
    const seqContiguous = collected.seqs.every((v, i) => v === i + 1);
    const assertions: Assertion[] = [
      {
        name: `MonitorEvent 条数 === ${lines}（批处理后的投递数）`,
        pass: collected.count === lines,
        detail: `实际 ${collected.count} 条（D5 未接线 → 0；批合并 → 少于 ${lines}）`,
      },
      {
        name: `seq 连续（1..${lines}）`,
        pass: collected.count === lines && seqContiguous,
        detail: `实际 seq=[${collected.seqs.join(",")}]`,
      },
      {
        name: "task_id 一致（单个 monitor，单一 task_id）",
        pass: collected.count === lines && collected.taskIds.length === 1,
        detail: `实际 task_id=[${collected.taskIds.join(",")}]`,
      },
    ];
    return {
      case: "D5-events",
      verdict: verdictOf(assertions),
      detail: assertions.every((a) => a.pass)
        ? `MonitorEvent ${collected.count} 条、seq 连续、task_id 一致`
        : `MonitorEvent 口径不对（${collected.count} 条 / seq=[${collected.seqs.join(",")}]），D5 未生效`,
      assertions,
      session: sessionId,
    };
  } finally {
    cleanup(s.pid, token);
  }
}

/**
 * D4：模型能不能**自然发现** monitor。
 *
 * prompt 刻意不提 monitor（「盯一下文件，每出现一行就告诉我」），同时后台每 2 秒写一行，
 * 制造「每次发生都要通知」这个 monitor 的定义域场景。判据只从轨迹读：
 * 调用了 monitor / tool_search 搜过 monitor / assistant 文本提到过 monitor。
 *
 * 选本地文件而不是真实 CI：不依赖 gh 网络与仓库状态（第 4 层实测就是因为 PR 已合并而无效），
 * 场景明确、完全可控可重复。样本量小：建议跑 3 次取 2 次，结论只能证伪不能证实。
 *
 * ⚠️ 写循环用**脚本文件**启动（命令行 `bash <dir>/writer.sh` 不含 token）：
 *    若命令行含 token，它会被 `monitorPids()` 当成 monitor 子进程，污染其它 case 的断言。
 */
async function runD4Discovery(): Promise<CaseBody> {
  const token = makeToken("discovery");
  const dir = mkdtempSync(join(tmpdir(), "sid-verify-discovery-"));
  const logPath = join(dir, `${token}.log`);
  const writerScript = join(dir, "writer.sh");
  writeFileSync(
    writerScript,
    `#!/bin/bash\nfor i in $(seq 1 30); do echo "line-$i" >> ${JSON.stringify(logPath)}; sleep 2; done\n`,
    { mode: 0o755 },
  );
  const writer = spawn("bash", [writerScript], { stdio: "ignore", detached: true });
  writer.unref();
  const writerPid = writer.pid;
  // 工作目录与配置目录分开且都不在 git 仓库里：防分支名 / 提交信息泄漏提示（见 startHeadless 注释）
  const s = startHeadless(`盯一下 ${logPath}，每出现一行就告诉我`, dir, makeNonGitWorkspace());
  try {
    const wrote = await waitFor(() => existsSync(logPath) && statSync(logPath).size > 0, 20_000);
    if (!wrote) {
      return {
        case: "D4-discovery",
        verdict: "INVALID",
        detail: "目标文件没有写入，场景不成立（写循环没跑起来）",
        assertions: [],
      };
    }
    // 若模型挂了 monitor，宿主在监控结束前不会退出；最多等 120s 后主动收尾
    const exited = await s.waitExit(120_000);
    if (!exited) {
      try {
        process.kill(s.pid, "SIGTERM");
      } catch {
        /* 已退出 */
      }
      await s.waitExit(10_000);
    }
    await Bun.sleep(500);
    const sessionDir = s.sessionDir();
    if (!sessionDir) {
      return {
        case: "D4-discovery",
        verdict: "INVALID",
        detail: "会话目录不存在（会话没起来）",
        assertions: [],
      };
    }
    const signal = analyzeDiscovery(readEvents(sessionDir), readTraj(sessionDir));
    const hit = signal.called || signal.searched || signal.mentioned;
    const assertions: Assertion[] = [
      {
        name: "命中 monitor：调用 / tool_search 搜过 / 回复里提到",
        pass: hit,
        detail: `called=${signal.called} searched=${signal.searched} mentioned=${signal.mentioned}`,
      },
    ];
    return {
      case: "D4-discovery",
      verdict: verdictOf(assertions),
      detail: hit
        ? `模型把 monitor 纳入候选集（${signal.called ? "实际调用" : signal.searched ? "tool_search 搜过" : "文本提到"}）`
        : "模型完全没提 monitor（用了前台轮询 / bash 后台），发现性引导未生效",
      assertions,
      session: basename(sessionDir),
    };
  } finally {
    cleanup(s.pid, token);
    if (writerPid) killTree(writerPid);
  }
}

/** `D4-discovery-checks` 的 CI 模拟脚本：四项检查依次结束，第三项 fail（纯函数，单测锁形态） */
export function buildChecksSimScript(statusPath: string, stepSec = 15): string {
  const names = ["lint", "unit", "e2e", "build"];
  const finals = ["pass", "pass", "fail", "pass"];
  const states: string[] = [];
  for (let done = 0; done <= names.length; done++) {
    states.push(
      JSON.stringify(names.map((name, i) => ({ name, status: i < done ? finals[i] : "pending" }))),
    );
  }
  const q = (x: string): string => `'${x.replace(/'/g, "'\\''")}'`;
  const lines = ["#!/bin/bash", `f=${q(statusPath)}`];
  states.forEach((st, i) => {
    lines.push(`printf '%s\\n' ${q(st)} > "$f.tmp" && mv "$f.tmp" "$f"`);
    lines.push(`sleep ${i === states.length - 1 ? 60 : stepSec}`);
  });
  return lines.join("\n") + "\n";
}

/**
 * 统计一次会话里「前台轮询」的形态：读同一个目标文件的工具调用次数（bash / read 都算）。
 *
 * 只用于 `D4-discovery-checks` 的 detail，不参与判定——它回答「没用 monitor 时模型拿什么扛的」，
 * 修复前后对比时这个数字比 PASS/FAIL 更能看出行为差异。
 */
export function countForegroundPolls(traj: TrajStep[], target: string): number {
  let n = 0;
  for (const step of traj) {
    if (step.message_type === "observation") continue;
    if (step.tool_name !== "bash" && step.tool_name !== "read") continue;
    const input = JSON.stringify(step.tool_input ?? {});
    if (input.includes(target)) n++;
  }
  return n;
}

/**
 * D4 的强场景：逐项检查结果（FIX-3 新增）。
 *
 * ## 为什么要第二个 case
 *
 * FIX-0 实测 `D4-discovery`（「盯文件，每出现一行就告诉我」）修复前就 3/3 命中：
 * 「每出现一行」几乎是 monitor 描述的原话，又是工具名单里唯一像「监控」的名字，
 * 天花板已经打满，证明不了引导段有没有用。真实轨迹里的缺口在另一处——
 * 802 次 `gh pr checks` / `gh run watch` 前台轮询，即「每个检查结束都告诉我」。
 *
 * 所以这里换成 CI 形态：一个 JSON 状态文件，四项检查依次从 pending 变成 pass/fail，
 * prompt 用用户的说法（「每个检查跑完告诉我结果」），不出现「监控 / 盯 / 每出现一行」。
 *
 * ## 判据只认实际调用
 *
 * `D4-discovery` 的「文本提到」是弱命中；这里**只认 called**（events 的
 * `PreToolUse{tool_name:"monitor"}` 或 traj 的 action），否则「想到了但用 sleep 循环扛」
 * 也会判 PASS。前台轮询次数写进 detail 供前后对比。
 *
 * 不依赖 gh 网络与真实 PR 状态，理由同 `D4-discovery`。
 */
async function runD4DiscoveryChecks(): Promise<CaseBody> {
  const token = makeToken("checks");
  const dir = mkdtempSync(join(tmpdir(), "sid-verify-checks-"));
  const statusPath = join(dir, `${token}-checks.json`);
  const writerScript = join(dir, "ci-sim.sh");
  // 四项检查依次结束（约 15s 一项），第三项失败——「沉默不等于成功」也在场景里。
  // 每个状态先写 .tmp 再 mv，避免模型读到半截 JSON。
  writeFileSync(writerScript, buildChecksSimScript(statusPath), { mode: 0o755 });
  const writer = spawn("bash", [writerScript], { stdio: "ignore", detached: true });
  writer.unref();
  const writerPid = writer.pid;
  const s = startHeadless(
    `本地 CI 正在跑，四项检查的状态写在 ${statusPath}（JSON 数组，每项 name/status，status 会从 pending 变成 pass 或 fail）。` +
      `每个检查跑完都告诉我它的结果，全部结束后给我一个总结。`,
    dir,
    makeNonGitWorkspace(),
  );
  try {
    const wrote = await waitFor(() => existsSync(statusPath), 20_000);
    if (!wrote) {
      return {
        case: "D4-discovery-checks",
        verdict: "INVALID",
        detail: "状态文件没有写入，场景不成立（CI 模拟脚本没跑起来）",
        assertions: [],
      };
    }
    // 四项检查约 60s 跑完；留足模型收尾时间，最多 150s 后主动收尾
    const exited = await s.waitExit(150_000);
    if (!exited) {
      try {
        process.kill(s.pid, "SIGTERM");
      } catch {
        /* 已退出 */
      }
      await s.waitExit(10_000);
    }
    await Bun.sleep(500);
    const sessionDir = s.sessionDir();
    if (!sessionDir) {
      return {
        case: "D4-discovery-checks",
        verdict: "INVALID",
        detail: "会话目录不存在（会话没起来）",
        assertions: [],
      };
    }
    const traj = readTraj(sessionDir);
    const signal = analyzeDiscovery(readEvents(sessionDir), traj);
    const polls = countForegroundPolls(traj, statusPath);
    const assertions: Assertion[] = [
      {
        name: "实际调用 monitor（只认调用，提到 / 搜过不算）",
        pass: signal.called,
        detail: `called=${signal.called} searched=${signal.searched} mentioned=${signal.mentioned} foreground_polls=${polls}`,
      },
    ];
    return {
      case: "D4-discovery-checks",
      verdict: verdictOf(assertions),
      detail: signal.called
        ? `模型调用了 monitor（前台读状态文件 ${polls} 次）`
        : `模型没调用 monitor，前台读状态文件 ${polls} 次${signal.searched || signal.mentioned ? "（想到了但没用）" : ""}`,
      assertions,
      session: basename(sessionDir),
    };
  } finally {
    cleanup(s.pid, token);
    if (writerPid) killTree(writerPid);
  }
}

/**
 * D6 的场景测试（FIX-5）：guidance 速查段把「何时该用」映射到延迟工具。
 *
 * 与 D4 系列同构：prompt 用自然语言表达意图、**不出现工具名**（测的是意图映射，
 * 不是复读），判据 = analyzeDiscovery 的三档命中（调用 / tool_search 搜过 / 回复提到），
 * 任一即 PASS。方案 §D6 验收指定 task_output 与 workflow 各一条。
 *
 * 工作目录必须是非 git 目录（同 D4 系列）：仓库根的 git 快照会把分支名写进系统提示，
 * 分支名含 "task"/"workflow" 字样时会污染发现性判据（FIX-3 实测的分支名泄漏形态）。
 */
async function runD6Guidance(
  caseName: "D6-guidance-task-output" | "D6-guidance-workflow",
  target: string,
  prompt: string,
): Promise<CaseBody> {
  const token = makeToken("d6");
  const dir = mkdtempSync(join(tmpdir(), "sid-verify-d6-"));
  const s = startHeadless(prompt, dir, makeNonGitWorkspace());
  try {
    const exited = await s.waitExit(150_000);
    if (!exited) {
      try {
        process.kill(s.pid, "SIGTERM");
      } catch {
        /* 已退出 */
      }
      await s.waitExit(10_000);
    }
    await Bun.sleep(500);
    const sessionDir = s.sessionDir();
    if (!sessionDir) {
      return {
        case: caseName,
        verdict: "INVALID",
        detail: "会话目录不存在（会话没起来）",
        assertions: [],
      };
    }
    const signal = analyzeDiscovery(readEvents(sessionDir), readTraj(sessionDir), target);
    const hit = signal.called || signal.searched || signal.mentioned;
    const assertions: Assertion[] = [
      {
        name: `命中 ${target}：调用 / tool_search 搜过 / 回复里提到`,
        pass: hit,
        detail: `called=${signal.called} searched=${signal.searched} mentioned=${signal.mentioned}`,
      },
    ];
    return {
      case: caseName,
      verdict: verdictOf(assertions),
      detail: hit
        ? `guidance 把意图映射到了 ${target}（${signal.called ? "实际调用" : signal.searched ? "tool_search 搜过" : "文本提到"}）`
        : `模型完全没提 ${target}，速查段未把该意图映射过去`,
      assertions,
      session: basename(sessionDir),
    };
  } finally {
    cleanup(s.pid, token);
  }
}

/** D6 的 task_output 场景：后台跑命令 + 自然语言「回看输出」（不出现工具名） */
async function runD6GuidanceTaskOutput(): Promise<CaseBody> {
  const token = makeToken("taskout");
  const cmd = `for i in $(seq 1 10); do echo ${token}-$i; sleep 1; done`;
  const prompt =
    `在后台跑这个命令（run_in_background=true）：${cmd}。` +
    `跑起来之后，回看它目前已经输出的内容并告诉我。`;
  return runD6Guidance("D6-guidance-task-output", "task_output", prompt);
}

/** D6 的 workflow 场景：自然语言表达「大规模穷尽编排」意图（不出现工具名） */
async function runD6GuidanceWorkflow(): Promise<CaseBody> {
  const prompt =
    "我有一件单轮对话装不下的穷尽检查要派给很多个子代理并行做、每路结果都要逐路收集汇总成一张表。" +
    "这种规模的编排你会用什么工具来做？先别真跑，说明你的做法，并把要用的工具激活好。";
  return runD6Guidance("D6-guidance-workflow", "workflow", prompt);
}

async function runCase(name: CaseName): Promise<CaseBody> {
  switch (name) {
    case "D1b-signal":
      return runD1bSignal();
    case "D1b-sigkill":
      return runD1bSigkill();
    case "D2D3-audit":
      return runD2D3Audit();
    case "D1b-orphan-scan-negative":
      return runD1bOrphanScanNegative();
    case "D4-discovery":
      return runD4Discovery();
    case "D4-discovery-checks":
      return runD4DiscoveryChecks();
    case "D5-events":
      return runD5Events();
    case "D6-guidance-task-output":
      return runD6GuidanceTaskOutput();
    case "D6-guidance-workflow":
      return runD6GuidanceWorkflow();
  }
}

// ─────────────────────────── 输出 ───────────────────────────

function printHelp(): void {
  console.log(
    [
      "verify-monitor —— monitor 缺陷的自动化验收（无人工）",
      "",
      "用法：",
      "  bun scripts/verify-monitor.ts --case <name>",
      "  bun scripts/verify-monitor.ts --all [--json]",
      "  bun scripts/verify-monitor.ts --all --binary ./sid-code-dev",
      "",
      `case：${ALL_CASES.join(" / ")}`,
      "",
      "三态：PASS 全部断言通过 / FAIL 修复未生效 / INVALID 前置条件不成立（重跑该 case）",
      "退出码：有 FAIL 即 1；全 PASS / INVALID 为 0",
    ].join("\n"),
  );
}

function printResult(r: CaseResult): void {
  const icon = r.verdict === "PASS" ? "✅" : r.verdict === "FAIL" ? "❌" : "⚪";
  console.log(
    `${icon} ${r.case}: ${r.verdict} (${(r.durationMs / 1000).toFixed(1)}s) — ${r.detail}`,
  );
  if (r.session) console.log(`   会话: ${r.session}`);
  for (const a of r.assertions) {
    const mark = a.pass ? "  ✓" : "  ✗";
    console.log(`${mark} ${a.name}${a.detail ? ` — ${a.detail}` : ""}`);
  }
}

function printSummary(results: CaseResult[]): void {
  const count = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
  console.log(
    `\n汇总: PASS ${count("PASS")} / FAIL ${count("FAIL")} / INVALID ${count("INVALID")}` +
      `（共 ${results.length} 个 case）`,
  );
  const invalid = results.filter((r) => r.verdict === "INVALID").map((r) => r.case);
  if (invalid.length > 0) {
    console.log(`⚠️ INVALID 需重跑：${invalid.join(", ")}（前置条件不成立，不是修复失败）`);
  }
  // 反向用例在启动扫描实现前恒 PASS：显式提醒读者不要把它当「扫描写对了」的证据
  if (results.some((r) => r.case === "D1b-orphan-scan-negative" && r.verdict === "PASS")) {
    console.log(
      "ℹ️ D1b-orphan-scan-negative 的 PASS 只证明「没有误杀」，" +
        "「该杀的杀了」看 D1b-sigkill（成对判读）",
    );
  }
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  if (opts.help || opts.cases.length === 0) {
    printHelp();
    process.exit(opts.help ? 0 : 2);
  }
  optsBinary = opts.binary;
  try {
    resolveBinary(opts.binary);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const results: CaseResult[] = [];
  for (const name of opts.cases) {
    if (!opts.json) console.log(`\n▶ ${name} …`);
    const t0 = Date.now();
    let result: CaseResult;
    try {
      result = { ...(await runCase(name)), durationMs: Date.now() - t0 };
    } catch (err) {
      result = {
        case: name,
        verdict: "FAIL",
        detail: `脚本异常：${(err as Error)?.message ?? String(err)}`,
        assertions: [],
        durationMs: Date.now() - t0,
      };
    }
    results.push(result);
    if (!opts.json) printResult(result);
  }
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printSummary(results);
  }
  process.exit(results.some((r) => r.verdict === "FAIL") ? 1 : 0);
}

if (import.meta.main) await main();
