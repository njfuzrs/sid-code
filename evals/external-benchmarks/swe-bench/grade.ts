#!/usr/bin/env bun
/**
 * SWE-bench Verified 阶段 A —— 判定与报告（§6.3 第 7 步 + §6 验收标准）
 *
 * 事实源：`接入计划.md` §4.6（判定，不自己判）+ §6（验收标准，不含百分比字段）
 *
 * ## 这个文件的唯一职责：把官方 report 翻译成验收字段，一个数都不自己算
 *
 * §4.6 原话是「丢给 `swebench eval` 读回报告，映射结果类别」。所以这里：
 *   - **不跑测试**、**不判 pass/fail** —— 那是 harness 的事；
 *   - 只做两件事：调 harness、把它的 report.json 映射成 §6 那五个字段。
 *
 * ## ⚠️ 两个必须硬失败的地方（都是「假 0%」的同型陷阱）
 *
 * 1. **report.json 读不回来 → 不许当 0**。被否决的路径 A 的病灶就是 scorer
 *    硬编码 `return Score(value=0)`：那不是「模型没解出来」，是仪器没接上，
 *    但它长得和一个真实的 0 分完全一样。这里对应的形态是
 *    「harness 没跑起来 / report 缺失，却把 solved_count 记 0」。
 * 2. **`ungraded` 单独成类，不折叠**（§4.6）。harness 对没提到的实例记 ungraded，
 *    汇总时若当「未解出」处理，数据错会伪装成能力差 —— 实测手挑 subset 里
 *    有 3 条 id 不存在，那 30% 会静默变成「未解出」。
 *
 * ## 用法
 *
 *   # 判分（会真跑官方 harness，起容器）
 *   bun run evals/external-benchmarks/swe-bench/grade.ts --run-id smoke-1
 *
 *   # 只读回已有 report 并出报告（不重跑）
 *   ... --run-id smoke-1 --report-only
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSubset } from "./runner.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SWE_DIR = import.meta.dir;
/** §3 数据隔离：报告独立到 `evals/_reports/external/`，**不碰 `evals/_scores/`** */
const REPORT_DIR = join(REPO_ROOT, "evals/_reports/external");
const MODEL_NAME = "sid-code";

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 官方 report.json 里我们会用到的字段（其余忽略）。 */
export interface OfficialReport {
  total_instances?: number;
  submitted_instances?: number;
  completed_instances?: number;
  resolved_instances?: number;
  unresolved_instances?: number;
  empty_patch_instances?: number;
  error_instances?: number;
  resolved_ids?: string[];
  unresolved_ids?: string[];
  error_ids?: string[];
  empty_patch_ids?: string[];
  completed_ids?: string[];
  submitted_ids?: string[];
}

export type GradedOutcome = "solved" | "wrong_patch" | "no_patch" | "grader_error" | "ungraded";

/**
 * §6 的验收字段。**这个 interface 里刻意没有任何百分比字段** ——
 * §6 原话「报告模板不许含百分比字段」，理由在 D2：n=10 时
 * SE=14.5pp、95% CI 半宽 ±28pp，「10 题跑出的 60% 与 70% 在统计上无法区分」。
 *
 * 约束落在类型上而不是落在「大家别算百分比」这句话上：
 * **没有那个字段，就没人能把 10 题的比例画成 release 曲线。**
 */
export interface Acceptance {
  run_id: string;
  prompt_version: string;
  /**
   * 被测模型名与网关 host（**不含 key**）。
   *
   * ⚠️ 这两个字段是**可比性的前提，不是元数据装饰**：换了模型或换了网关的两次 run，
   * `solved_count` 之间没有可比性，而分数本身看不出来这件事。
   * null 表示这次 run 没记（旧 run 的兼容值）—— 读到 null 就该知道
   * **这个分数不能和别的 run 并排放**，而不是当作「默认模型」。
   */
  model: string | null;
  gateway_host: string | null;
  /**
   * 被测代码的身份 —— **`artifact_commit` 才是事实源**。
   *
   * 实测背景（2026-08-26）：`package.json` 停在 `0.1.601`，而 tag `v0.1.601` 打在
   * 8月21 的提交上；此后合入的 429 重试修复、权限修复都不在那个 tag 里。
   * 也就是说**同一个版本号对应了几十个不同的 commit** —— 只记 version 等于没记。
   *
   * ## ⚠️ 为什么 `git_commit` 不够，非要加 `artifact_commit`（F3）
   *
   * `git_commit` 记的是**跑评测时宿主的 HEAD**，而产物可能是任意时候编的 ——
   * 这两个值不一定相等，**而读报告的人会当它们相等**。F1 那个场景里
   * `git_commit` 是 8月26 的 HEAD、产物是 8月21 编的，于是 run-meta.json
   * 从"事实源"退化成了"一个看起来很可靠的错值"。
   *
   * 所以身份字段现在是两组：
   *   `artifact_commit` / `artifact_dirty` / `artifact_origin`  产物**自报**（编在字节里）
   *   `host_head_commit` / `git_dirty`                          宿主状态，仅供对照
   *
   * `artifact_identity_source` 是最要紧的一个：`mtime-fallback` 意味着这一轮
   * **没量到**产物身份（老产物或漏带 define），判据退化成了时间戳。
   * 它与 `embedded` 的区别绝不能塌掉 —— 「没量到」冒充「量到了且没变」正是
   * 本仓反复踩的那类假结论。
   *
   * `artifact_sha256` 仍是最后一道：上面全部字段都对而产物仍是旧的时，只有字节指纹能发现。
   *
   * 全部 null = 旧 run 的兼容值，读到 null 就该知道**不知道这个分数是哪份代码跑的**。
   */
  sid_code_version: string | null;
  /** 产物自报的 40 位 commit。**事实源。** null = 旧 run 没记。 */
  artifact_commit: string | null;
  artifact_branch: string | null;
  /** 产物构建时工作区是否脏。三态：`"unknown"` ≠ false（后者是替它断言"干净"）。 */
  artifact_dirty: boolean | "unknown" | null;
  /** `local` / `ci` / `release` / `source` —— 「本地随手编的」与「发布流水线出的」要分得开。 */
  artifact_origin: string | null;
  /** `embedded` = 真读到了身份；`mtime-fallback` = **没量到**，判据退化成时间戳。 */
  artifact_identity_source: string | null;
  /** G1 判定：ok / stale / foreign / no-identity / ...。非 ok 说明这一轮带着已知问题跑。 */
  artifact_gate_verdict: string | null;
  /** 用了哪些逃生舱（stale / foreign）。非空 = 这份分数不可与没用逃生舱的 run 并排。 */
  gate_bypassed: string[] | null;
  /** 跑评测时宿主的 HEAD。**不是产物身份**，仅供对照。旧字段 `git_commit` 的新名字。 */
  host_head_commit: string | null;
  git_commit: string | null;
  git_dirty: boolean | null;
  artifact_sha256: string | null;
  /**
   * 必控变量：推理档位与成本闸门。
   *
   * 这两项此前完全没记，而它们是被 `backfill-team-defaults` 悄悄塞进来的
   * （模板里 effortLevel=max / costLimit=100）—— 也就是说前几轮跑的是**谁也没选过**
   * 的值。`cost_limit_usd > 0` 时整轮可能在 exceeded 处静默 return，
   * 被记成 `no_patch`：一个预算闸门伪装成能力问题。
   */
  effort_level: string | null;
  cost_limit_usd: number | null;
  /**
   * 跑 agent 的并发度。**必控变量** —— 并发下多个容器争 docker daemon、
   * 宿主 CPU、同一份网关配额，每条实例的 agent_ms 都被别的实例拖长，
   * 于是 `solved_count` 与串行 run **不可并排**，而分数本身看不出来。
   *
   * ⚠️ 与判分并发（`SWE_GRADE_JOBS`）不同：判分不碰网关且是纯函数
   * （同一份 predictions 判两次结论必须一样），所以那个不影响可比性、不记在这里。
   */
  jobs: number | null;
  /**
   * 10/10 instance 产出非空 patch ← 二值
   *
   * ## ⚠️ 口径定死：这是「**单次**跑完的成功率」，不是「重试后的成功率」
   *
   * 它只看本次 run 目录里的 patch 字节数，**不合并任何复跑结果**。
   * 这个区分有实测背景（2026-08-25 smoke-2）：`django-13964`（1min exit 1）与
   * `matplotlib-26466`（6min exit 1）两条零 patch 让 link_ok=FAIL，
   * 而各自复跑一次**都产出了 patch**（1931B / 1417B）——
   * 所以那次 FAIL 反映的是**偶发故障**，不是「agent 做不出来」。
   *
   * 两种口径都有意义，但**混用会得到一个谁也不是的数**：
   *
   * - 单次口径（现在这个）度量的是**链路稳定性** —— 它该在偶发故障时报 FAIL，
   *   那正是它的用处：把「设施抖了」这件事暴露出来而不是被重试掩盖。
   * - 重试后口径度量的是**能力可达性**，属于阶段 C 的 pass^k 范畴（D2 已裁决不在阶段 A 上）。
   *
   * ⛔ **不要为了让 link_ok 变绿而在这里合并复跑**：那会让一条
   * 「跑三次才成功一次」的链路显示为 PASS，而链路不稳恰恰是阶段 A 要发现的东西。
   * 复跑结论应该写进 `unaccounted` / 报告正文，不改这个字段。
   *
   * 报告渲染层会把「单次」这两个字打出来 —— 只在类型注释里写不够，
   * 读报告的人看不到注释，会默认理解成"重试后仍失败"（那是更严重的结论）。
   */
  link_ok: boolean;
  /** 10/10 拿到 report.json（无 ungraded）← 二值 */
  graded_ok: boolean;
  /** gold patch 自检 ← 二值。null = 本次没跑 gold 自检 */
  gold_ok: boolean | null;
  /** 绝对数，不换算百分比、不进 release 曲线 */
  solved_count: number;
  /** 分母也要写出来，否则「solved_count: 6」读不出是 6/10 还是 6/15 */
  total_count: number;
  /** §4.5 那道硬检查的计数 */
  patch_touches_tests: number;
  /** 六类结果的逐条映射 */
  outcomes: Record<string, GradedOutcome>;
  /** ── 以下四个是 §6.3 要求的诚实字段 ── */
  /** 账没算平的部分。有值就是「这份报告自己知道它不完整」 */
  unaccounted: string | null;
  /** harness 自己的时钟，不是 agent 自报 */
  wall_ms: number;
  /** D4：无中立计价源，固定 null */
  meter: null;
  meter_note: string;
  /** 是否只跑了部分实例 */
  partial: boolean;
}

export const METER_NOTE = "无中立计价源；成本数字为 agent 自报，未交叉校验";

// ─────────────────────────────────────────────────────────────────────────────
// 映射：官方 report → 六类结果
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把官方 report 的各个 id 列表映射成逐实例结论。
 *
 * ⚠️ **`ungraded` 是兜底，且必须存在**：一个我们提交了、但 report 的
 * 任何一个列表里都没出现的实例，它的真实状态是**未知**，不是「未解出」。
 * 把它折叠进 unresolved 就是「数据错伪装成能力差」。
 *
 * ⚠️ 顺序有讲究：error 与 empty_patch 要在 unresolved 之前判 ——
 * 官方 report 里一个实例**可以同时**出现在 unresolved_ids 和 error_ids
 * （§4.6「`0 failed` 与 `Instances with errors: 1` 可同时成立，不矛盾」）。
 * 先判 unresolved 会把一次 grader 崩溃记成「模型改错了」。
 */
export function mapOutcomes(
  report: OfficialReport,
  submitted: string[],
): Record<string, GradedOutcome> {
  const set = (xs?: string[]) => new Set(xs ?? []);
  const resolved = set(report.resolved_ids);
  const errored = set(report.error_ids);
  const empty = set(report.empty_patch_ids);
  const unresolved = set(report.unresolved_ids);

  const out: Record<string, GradedOutcome> = {};
  for (const id of submitted) {
    if (resolved.has(id)) out[id] = "solved";
    else if (errored.has(id)) out[id] = "grader_error";
    else if (empty.has(id)) out[id] = "no_patch";
    else if (unresolved.has(id)) out[id] = "wrong_patch";
    else out[id] = "ungraded";
  }
  return out;
}

/** 一条实例的耗时（ms）。三段缺失时为 undefined —— 表示"没量"，不是 0。 */
export interface InstanceTiming {
  instance_id: string;
  wall_ms: number;
  setup_ms?: number;
  agent_ms?: number;
  extract_ms?: number;
}

/**
 * 这一轮的耗时画像。
 *
 * ## 为什么需要它：数据一直都在，只是没人看
 *
 * `wall_ms` 从 smoke-1 起就逐题落盘了，但报告只渲染了**总和**
 * （`- wall_ms（harness 时钟）：5652xxx`）。于是"10 题跑了 2-3 小时、
 * 定位不到哪道题慢"这个问题的答案一直躺在 `records.jsonl` 里没被读出来。
 *
 * 实测（smoke-8 记录，2026-08-26 重新汇总）：
 *   astropy-8872 22.2min / matplotlib-26466 17.0min / django-13964 12.6min
 *   … / astropy-12907 1.8min，合计 94.2min
 * **最慢一条是最快一条的 12 倍** —— 这个分布形态直接决定了优化方向
 * （并发能把墙钟压到最慢那条附近，而调 max-turns 只影响长尾那几条）。
 *
 * ⚠️ 只报绝对数与占比，**不报"提速百分比"** —— 与验收字段同一条纪律：
 * n=10 的耗时方差极大（模型延迟本身抖动就有数倍），两轮之间的差
 * 说明不了任何因果。这里的用处是**归因**（哪一段、哪一条），不是打分。
 */
export interface TimingProfile {
  /** 逐题耗时，按 wall_ms 降序 —— 最慢的排最前，那是唯一值得先看的 */
  per_instance: InstanceTiming[];
  total_wall_ms: number;
  /**
   * 三段各自的合计。**任一条实例缺分解就全部为 null** ——
   * 混着算会得到一个"部分实例的 setup + 全部实例的 wall"这种谁也不是的数。
   */
  total_setup_ms: number | null;
  total_agent_ms: number | null;
  total_extract_ms: number | null;
  /**
   * 串行跑的墙钟（= total_wall_ms）与"完美并发"下的理论墙钟（= 最慢一条）之比。
   *
   * 这是**并发能拿到多少**的上界，不是承诺：实测受 docker daemon、
   * 网关限流、宿主 CPU 三处制约，拿不到理论值。
   * 报它的意义是让"要不要开并发"有个数可依，而不是凭感觉。
   */
  serial_penalty_x: number | null;
}

/**
 * 从 records.jsonl 的原始行汇总耗时画像。
 *
 * ⚠️ 判据全部走 `typeof === "number"` 而不是 `?? 0`：
 * 旧 run 没有三段字段，`?? 0` 会让它们静默参与求和，
 * 于是报告里出现"setup 合计 3 分钟"（实际是 10 条里只有 2 条有值）——
 * 一个残缺的分解看起来和完整的一模一样。
 */
export function buildTimingProfile(
  records: Array<{
    instance_id?: string;
    wall_ms?: number;
    setup_ms?: number;
    agent_ms?: number;
    extract_ms?: number;
  }>,
): TimingProfile {
  const per: InstanceTiming[] = records
    .filter((r) => r.instance_id)
    .map((r) => ({
      instance_id: r.instance_id!,
      wall_ms: r.wall_ms ?? 0,
      setup_ms: typeof r.setup_ms === "number" ? r.setup_ms : undefined,
      agent_ms: typeof r.agent_ms === "number" ? r.agent_ms : undefined,
      extract_ms: typeof r.extract_ms === "number" ? r.extract_ms : undefined,
    }))
    .sort((a, b) => b.wall_ms - a.wall_ms);

  const totalWall = per.reduce((s, r) => s + r.wall_ms, 0);
  // 全员都有分解才汇总。空数组也算"没有分解"（不是 0）——
  // 否则一个空 run 会报出一份"三段全 0"的分解，读起来像"什么都没花时间"。
  const allHave =
    per.length > 0 &&
    per.every(
      (r) =>
        typeof r.setup_ms === "number" &&
        typeof r.agent_ms === "number" &&
        typeof r.extract_ms === "number",
    );
  const slowest = per.length ? per[0]!.wall_ms : 0;
  return {
    per_instance: per,
    total_wall_ms: totalWall,
    total_setup_ms: allHave ? per.reduce((s, r) => s + r.setup_ms!, 0) : null,
    total_agent_ms: allHave ? per.reduce((s, r) => s + r.agent_ms!, 0) : null,
    total_extract_ms: allHave ? per.reduce((s, r) => s + r.extract_ms!, 0) : null,
    // 只有一条时并发没有意义，报 null 而不是 1.0（1.0 会被读成"并发也没用"，
    // 而真相是"这个样本量说不了这件事"）。
    serial_penalty_x: per.length > 1 && slowest > 0 ? totalWall / slowest : null,
  };
}

/**
 * 把逐题 `records.jsonl` 的权限字段汇总成报告输入（A7.13.2）。
 *
 * ## ⚠️ 唯一容易写错的地方：`null` 不是 `0`
 *
 * `permission_denials == null` 的两种来源 ——
 *   `null`      = 本次跑了但遥测取不回（容器崩在建遥测之前）
 *   `undefined` = 旧 run 压根没这个字段
 * —— 对读报告的人是**同一件事**：「这条的权限拒绝数不知道」。两者都归 notMeasured。
 *
 * ⛔ **不许写 `permTotal += r.permission_denials ?? 0`**。那会把两种"不知道"
 * 都折成"没被拒"，于是「仪器没接上」伪装成「防线全绿」—— 而那正是 A7.13.2
 * 这条缺陷本身的形态（原判据把「字段不存在」读成了「值为 0」）。
 * 在修它的过程里重演一次会格外讽刺，所以本函数**单独抽出来并配了变异测试**：
 * 内联在 runGrade 里时那个 `?? 0` 的错法能一路通过全部断言（实测过）。
 */
export function aggregatePermissionDenials(
  records: Array<{
    instance_id?: string;
    permission_denials?: number | null;
    permission_denials_by_reason?: Record<string, number>;
    permission_denials_log_proxy?: number;
  }>,
): {
  total: number;
  byInstance: Record<string, number>;
  byReasonType: Record<string, number>;
  notMeasuredIds: string[];
  proxyDivergedIds: string[];
} {
  const byInstance: Record<string, number> = {};
  const byReasonType: Record<string, number> = {};
  const notMeasuredIds: string[] = [];
  const proxyDivergedIds: string[] = [];
  let total = 0;

  for (const r of records) {
    const id = r.instance_id ?? "";
    if (!id) continue;
    if (r.permission_denials == null) {
      notMeasuredIds.push(id);
      continue;
    }
    total += r.permission_denials;
    if (r.permission_denials > 0) byInstance[id] = r.permission_denials;
    for (const [k, n] of Object.entries(r.permission_denials_by_reason ?? {})) {
      byReasonType[k] = (byReasonType[k] ?? 0) + n;
    }
    // 双源背离：结构化 0 而日志字符串 >0 → 埋点漏了一条鉴权路径。
    // 反方向（结构化 >0 而字符串 0，即文案改了）**不进这里** ——
    // 那不影响本字段的正确性，record.ts 已在逐题 note 里记过一笔。
    if (r.permission_denials === 0 && (r.permission_denials_log_proxy ?? 0) > 0) {
      proxyDivergedIds.push(id);
    }
  }

  return { total, byInstance, byReasonType, notMeasuredIds, proxyDivergedIds };
}

/**
 * 组装验收字段。
 *
 * `graded_ok` 的判据是**没有任何 ungraded**，而不是「report 里 total 对得上」——
 * total 对得上但某条落在所有列表之外时，那条的状态仍然是未知的。
 */
export function buildAcceptance(input: {
  runId: string;
  promptVersion: string;
  report: OfficialReport | null;
  submitted: string[];
  patchBytesById: Record<string, number>;
  touchesTestsIds: string[];
  goldOk: boolean | null;
  wallMs: number;
  expectedTotal: number;
  /** 被测模型名。缺省 null，且此时 unaccounted 会写明「不可与别的 run 并排」 */
  model?: string | null;
  /** 网关 host（**只要 host，不要完整 URL、绝不要 key**） */
  gatewayHost?: string | null;
  /** 被测代码身份，见 Acceptance 同名字段。缺省 null = 旧 run，unaccounted 会点破 */
  sidCodeVersion?: string | null;
  artifactCommit?: string | null;
  artifactBranch?: string | null;
  artifactDirty?: boolean | "unknown" | null;
  artifactOrigin?: string | null;
  artifactIdentitySource?: string | null;
  artifactGateVerdict?: string | null;
  gateBypassed?: string[] | null;
  hostHeadCommit?: string | null;
  gitCommit?: string | null;
  gitDirty?: boolean | null;
  artifactSha256?: string | null;
  /** 必控变量：推理档位 / 成本闸门 / 并发度，见 Acceptance 同名字段 */
  effortLevel?: string | null;
  costLimitUsd?: number | null;
  jobs?: number | null;
  /**
   * subset 读不回来、`expectedTotal` 退化成 `submitted.length` 时置 true。
   *
   * 必须点破的理由：退化之后 `partial` **恒为 false**（分母 == 分子），
   * 于是一个可能只跑了三条的 run 看起来像「跑满了」。
   * 这是「账没算平却装作算平了」，正是 unaccounted 这个字段存在的意义。
   */
  subsetReadFailed?: boolean;
  /**
   * 零 patch 且**编辑全打在仓库外**的实例（改自己的复现脚本、没碰被测源码）。
   *
   * 为什么要一路带到报告：这个形态在 `solved_count` / `link_ok` 上与
   * 「完全没动手」一模一样，而两者处置完全不同 ——
   * 前者是「定位到了但没留下动手的轮次」（抬 max_turns 可能有用），
   * 后者是「不知道从哪下手」（抬轮数只会更贵）。实测见 A7.11.4 的 django-13964。
   */
  editsOnlyOutsideRepoIds?: string[];
  /**
   * 权限拒绝汇总（A7.13.2）。取自 `records.jsonl` 的结构化字段，不是数日志字符串。
   *
   * ## 为什么必须进报告，而不是只躺在 records.jsonl 里
   *
   * 「被权限层打残」是**分数掺了非能力因素**的直接证据：smoke-8 有三条实例过半轮次
   * 是被拒绝烧掉的，却被记成「40 轮预算用尽」，读起来像能力不够。
   * 这个信号不进 unaccounted，就要靠每次有人想起来去翻 records.jsonl ——
   * 而 `grade.ts` 自己在耗时分解那节抱怨过同一件事（「答案一直躺在 records.jsonl 里没被读出来」）。
   *
   * ⚠️ `notMeasuredIds` 与 `denials: 0` **不可合并**：
   *   前者 = 遥测没取回 → **不知道**有没有被拒（该 run 这一项不可信）
   *   后者 = 量到了、确实没被拒 → 干净
   * 合并会让「仪器没接上」伪装成「防线全绿」，那正是 A7.13.2 本身的形态。
   */
  permissionDenials?: {
    /** 逐题拒绝数之和（只统计量到的题） */
    total: number;
    /** 有拒绝的题 → 次数，用于点出「哪几条被打残了」 */
    byInstance: Record<string, number>;
    /** 成因分解合并（reason_type → 次数）：回答「该不该动手」 */
    byReasonType: Record<string, number>;
    /** 遥测未取回的题 —— 这几条的「有没有被拒」是未知，不是 0 */
    notMeasuredIds: string[];
    /** 双源背离的题（结构化 0 而 agent.log 有「权限拒绝」字样）→ 埋点漏路径 */
    proxyDivergedIds: string[];
  };
}): Acceptance {
  const notes: string[] = [];

  // report 读不回来 → 全部 ungraded，且 unaccounted 必须写明。
  // **绝不返回 solved_count: 0 然后装作跑完了。**
  if (!input.report) {
    notes.push(
      "官方 report.json 未读回 —— 所有实例记 ungraded。" +
        "⚠️ 这不是「0 条解出」，是判分没发生；把它当 0 就是被否决的路径 A 那个假 0%。",
    );
  }

  const outcomes = input.report
    ? mapOutcomes(input.report, input.submitted)
    : Object.fromEntries(input.submitted.map((id) => [id, "ungraded" as GradedOutcome]));

  const ungradedIds = Object.entries(outcomes)
    .filter(([, v]) => v === "ungraded")
    .map(([k]) => k);
  if (ungradedIds.length && input.report) {
    notes.push(`${ungradedIds.length} 条 ungraded（不计入未解出）：${ungradedIds.join(", ")}`);
  }

  if (input.subsetReadFailed) {
    notes.push(
      "读不到 verified-subset.yaml —— expectedTotal 退化成本次提交条数，" +
        "**`partial` 因此恒为 false，不能当作「跑满了」**",
    );
  }

  // 零 patch 但改了仓库外的文件 —— 必须点破，否则它在 solved_count / link_ok 上
  // 与「完全没动手」不可区分（A7.11.4：django-13964 编辑 2 次全在 /tmp/repro/）。
  const onlyOutside = input.editsOnlyOutsideRepoIds ?? [];
  if (onlyOutside.length) {
    notes.push(
      `${onlyOutside.length} 条零 patch 但**编辑全在仓库外**（改复现脚本、未碰被测源码）：` +
        `${onlyOutside.join(", ")} —— 与「完全没动手」在 solved_count 上不可区分，` +
        `但成因不同（定位到了却没留下动手的轮次），处置也不同`,
    );
  }

  // ── A7.13.2：权限拒绝进 unaccounted ──
  //
  // 三条各自独立，任一条成立都说明这份报告有它自己知道的不完整之处：
  //  1. 有拒绝     → 分数掺了非能力因素（该查权限档，不是该抬 max_turns）
  //  2. 有没量到的 → 那几条的「有没有被打残」是未知；**不许当 0 读**
  //  3. 有背离的   → 埋点漏了一条鉴权路径，是 A7.13.2 修复的回归
  const perm = input.permissionDenials;
  if (perm) {
    if (perm.total > 0) {
      const worst = Object.entries(perm.byInstance)
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${id}×${n}`)
        .join(", ");
      const byReason = Object.entries(perm.byReasonType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}×${n}`)
        .join(", ");
      notes.push(
        `被权限层拒绝共 ${perm.total} 次工具调用（${worst}）—— 每次都烧掉一轮而未做成任何事，` +
          `**这一轮的分数掺了非能力因素**。成因 [${byReason}]：` +
          `\`other\` 多为 headless 把 ask 自动拒了（查权限档），\`rule\` 是 deny 规则按预期生效`,
      );
    }
    if (perm.notMeasuredIds.length) {
      notes.push(
        `${perm.notMeasuredIds.length} 条未取回遥测、权限拒绝数为 **null（不知道）而非 0**：` +
          `${perm.notMeasuredIds.join(", ")} —— 这几条不能当作"没被权限层打残"来读`,
      );
    }
    if (perm.proxyDivergedIds.length) {
      notes.push(
        `🔴 ${perm.proxyDivergedIds.length} 条**双源背离**（结构化事件 0 条，而 agent.log 有「权限拒绝」字样）：` +
          `${perm.proxyDivergedIds.join(", ")} —— 大概率是产品侧新增了鉴权路径却没发 ` +
          `\`permission_deny\` 埋点（A7.13.2 的回归形态）。这几条的拒绝在结构化源里是隐身的`,
      );
    }
  }

  const nonEmpty = input.submitted.filter((id) => (input.patchBytesById[id] ?? 0) > 0);
  const partial = input.submitted.length < input.expectedTotal;
  if (partial) {
    notes.push(
      `只跑了 ${input.submitted.length}/${input.expectedTotal} 条 —— ` +
        `solved_count 的分母是前者，不要与全量口径混用`,
    );
  }

  // 模型名缺失时**必须在 unaccounted 里点破**。只把字段记成 null 是不够的：
  // 读报告的人会自动把 null 读成「默认那个」，而两次 run 用的模型可能压根不同。
  if (!input.model) {
    notes.push(
      "未记录被测模型名 —— 这份 solved_count **不能与其他 run 并排比较**（不知道跑的是哪个模型）",
    );
  }

  // 同理，被测代码身份缺失也必须点破，理由更强：模型至少还能从网关侧查，
  // 而"跑的是哪份代码"事后无从追溯。
  // ⚠️ 判据是 commit 而不是 sid_code_version —— 版本号在两次发布之间不动，
  // 同一个 0.1.601 对应过几十个 commit（2026-08-26 实测），有它等于没有。
  //
  // ⚠️ 判据优先 artifact_commit（产物自报）而不是 host_head_commit：
  // 后者是"跑评测时宿主在哪个 commit"，与"跑的是哪份代码"是两件事（F3）。
  if (!input.artifactCommit && !input.gitCommit) {
    notes.push(
      "未记录产物 commit —— 事后无法确定这一轮跑的是哪份代码" +
        "（版本号不够：`make build` 不 bump，同一版本号对应过多个 commit）",
    );
  } else if (!input.artifactCommit || input.artifactCommit === "unknown") {
    // 有 host HEAD 但没有产物 commit = 旧 run（本机制上线之前跑的）。
    // 这不是"通过"，是**这一轮的身份没量到** —— 必须与量到了的 run 区分开。
    notes.push(
      "未记录 artifact_commit（产物自报的 commit）—— " +
        `只有 host_head_commit=${(input.hostHeadCommit ?? input.gitCommit ?? "?").slice(0, 8)}，` +
        "而那是**跑评测时宿主的 HEAD**，不是产物编自哪个 commit。" +
        "产物可能是几天前编的，这两个值不一定相等",
    );
  }

  // 身份"没量到"必须与"量到了且没变"分开。塌成一个的后果：一个跑了旧产物的 run
  // 看起来与跑了当前代码的 run 一样干净。
  if (input.artifactIdentitySource === "mtime-fallback") {
    notes.push(
      "产物身份**没量到**（artifact_identity_source=mtime-fallback）—— " +
        "老产物或构建时漏带 --define，本轮判据退化成 mtime。" +
        "⚠️ mtime 两个方向都会错（`cp` 重置成「现在」、docs 提交推进 HEAD 时间），" +
        "所以「产物是新的」这件事本轮**没有得到验证**",
    );
  }

  // 逃生舱留痕。逃生舱本身不是问题，**用了却不留痕**才是 —— 一个用了
  // SWE_ALLOW_STALE_ARTIFACT 的 run 与一个正常 run 在分数上完全看不出区别。
  if (input.gateBypassed && input.gateBypassed.length > 0) {
    const which = input.gateBypassed.join(", ");
    notes.push(
      `产物身份门禁被绕过（gate_bypassed=[${which}]）—— ` +
        (input.gateBypassed.includes("stale")
          ? "**这一轮测的不是当前代码**（产物编出来之后编译输入又改过）；"
          : "") +
        (input.gateBypassed.includes("foreign")
          ? "产物来自另一条线（不在当前 HEAD 的历史里）；"
          : "") +
        "这份 solved_count 不可与未绕过门禁的 run 并排",
    );
  } else if (
    input.artifactGateVerdict &&
    !["ok", "no-identity"].includes(input.artifactGateVerdict)
  )
    notes.push(`产物身份门禁判定 ${input.artifactGateVerdict} —— 这一轮带着已知的产物问题跑`);

  // 产物**构建时**工作区脏 → commit 只描述基线，改动内容无记录。
  // ⚠️ 与宿主脏（git_dirty）刻意分开：一个从干净 commit 编出的好产物，
  // 不该因为宿主此刻有未提交改动而被打上"只可自比"的标签。
  if (input.artifactDirty === true) {
    notes.push(
      `产物编自脏工作区（artifact_dirty=true，基线 ${(input.artifactCommit ?? "?").slice(0, 8)}）` +
        "—— commit 只描述了基线、改动内容无记录，这一轮**只可自比，不可与其他 run 外比**",
    );
  } else if (input.artifactDirty === undefined || input.artifactDirty === null) {
    if (input.gitDirty) {
      // 旧 run 的路径：只有宿主脏这一个信号，语义弱得多但仍要点破。
      notes.push(
        `宿主工作区不干净（git_dirty=true，HEAD ${(input.gitCommit ?? "?").slice(0, 8)}）—— ` +
          "旧 run 没有 artifact_dirty，无法区分「产物编自脏工作区」与「只是宿主此刻脏」，" +
          "保守起见按只可自比处理",
      );
    }
  }

  // 发布制品跑的评测与本地包跑的评测是两件事，值得能看出来 —— 但都不拦。
  if (input.artifactOrigin === "source") {
    notes.push("artifact_origin=source（源码直跑，不是编译产物）—— 与产物 run 的耗时不可并排");
  }
  // 成本闸门开着 = 整轮可能在 exceeded 处静默 return，被记成 no_patch。
  // 这条必须报出来：它让一个预算问题长得像能力问题。
  if (typeof input.costLimitUsd === "number" && input.costLimitUsd > 0) {
    notes.push(
      `成本闸门开启（cost_limit_usd=${input.costLimitUsd}）—— ` +
        "撞上时整轮静默结束并被记成零 patch，零 patch 的归因需先排除它",
    );
  }
  if (!input.effortLevel) {
    notes.push("未记录 effort_level —— 它直接决定推理预算与成本，是必控变量");
  }
  // 并发跑的 run 不可与串行 run 并排 —— 这条必须报，因为分数上完全看不出来。
  if (typeof input.jobs === "number" && input.jobs > 1) {
    notes.push(
      `并发跑（jobs=${input.jobs}）—— 多容器争 docker daemon / 宿主 CPU / 网关配额，` +
        "agent_ms 被互相拖长，**这份 solved_count 不可与串行 run 并排**",
    );
  }

  return {
    run_id: input.runId,
    prompt_version: input.promptVersion,
    model: input.model ?? null,
    gateway_host: input.gatewayHost ?? null,
    sid_code_version: input.sidCodeVersion ?? null,
    artifact_commit: input.artifactCommit ?? null,
    artifact_branch: input.artifactBranch ?? null,
    artifact_dirty: input.artifactDirty ?? null,
    artifact_origin: input.artifactOrigin ?? null,
    artifact_identity_source: input.artifactIdentitySource ?? null,
    artifact_gate_verdict: input.artifactGateVerdict ?? null,
    gate_bypassed: input.gateBypassed ?? null,
    host_head_commit: input.hostHeadCommit ?? input.gitCommit ?? null,
    git_commit: input.gitCommit ?? null,
    git_dirty: input.gitDirty ?? null,
    artifact_sha256: input.artifactSha256 ?? null,
    effort_level: input.effortLevel ?? null,
    cost_limit_usd: input.costLimitUsd ?? null,
    jobs: input.jobs ?? null,
    link_ok: nonEmpty.length === input.submitted.length && input.submitted.length > 0,
    graded_ok: !!input.report && ungradedIds.length === 0,
    gold_ok: input.goldOk,
    solved_count: Object.values(outcomes).filter((v) => v === "solved").length,
    total_count: input.submitted.length,
    patch_touches_tests: input.touchesTestsIds.length,
    outcomes,
    unaccounted: notes.length ? notes.join(" | ") : null,
    wall_ms: input.wallMs,
    meter: null,
    meter_note: METER_NOTE,
    partial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告渲染
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 渲染 markdown 报告。
 *
 * ⚠️ 渲染层同样不许出现百分比 —— 光在 interface 里去掉字段不够，
 * 「在报告里现算一个 6/10 = 60%」是同一件事的另一种写法。
 */
/**
 * 渲染耗时画像段。
 *
 * ⚠️ **一行一条实例，不做"平均耗时"** —— smoke-8 里最慢/最快差 12 倍，
 * 均值在这种分布上不描述任何一条题，而报告的用处是"先看哪一条"。
 * 这与北极星那条「一律看 p95/p99，均值会骗人」同源。
 */
export function renderTimingSection(t: TimingProfile): string[] {
  if (!t.per_instance.length) return [];
  const min = (ms: number) => (ms / 60000).toFixed(1);
  const lines: string[] = ["", "## 耗时画像（harness 时钟，非 agent 自报）", ""];

  if (t.total_setup_ms === null) {
    lines.push(
      "> ⚠️ 本轮缺三段分解（setup/agent/extract）—— 旧 run 或中途改过计时点。",
      "> 只报 wall，**不用 wall 顶替 agent**：那会凭空造出一份「全是模型耗时」的分解。",
      "",
    );
  } else {
    // ## 只报绝对分钟数，**不报占比百分号**
    //
    // §6 那条「报告里不许出现 数字+%」的门禁只扫 renderReport()，
    // 技术上这里写 % 不会红。但那条门禁的理由是「钝是故意的 ——
    // 在正文里现算一个比例和加一个 percent 字段是同一件事」，
    // 而耗时同样是 n=10 的高方差量（模型延迟本身抖动就有数倍）。
    // 三段绝对数已经足够回答「该优化 harness 还是调 prompt」，
    // 占比只会让人拿两轮的百分比作差 —— 那个差说明不了任何因果。
    lines.push(
      `- 合计 **${min(t.total_wall_ms)} min** = ` +
        `搬运 ${min(t.total_setup_ms)} + 模型 ${min(t.total_agent_ms!)}` +
        ` + 收尾 ${min(t.total_extract_ms!)}（单位均为 min）`,
      "  > 搬运 = docker run + 解压 + cp 产物/题面；收尾 = 提取 patch + 取回轨迹。",
      "  > 这两段与模型能力无关 —— **它们的量级大就说明该优化 harness 而不是调 prompt**。",
      "",
    );
  }

  if (t.serial_penalty_x !== null) {
    lines.push(
      `- 串行代价：**${t.serial_penalty_x.toFixed(1)}×** ` +
        `（串行 ${min(t.total_wall_ms)} min vs 最慢单条 ${min(t.per_instance[0]!.wall_ms)} min）`,
      "  > 这是并发的**上界不是承诺** —— 实测受 docker daemon、网关限流、宿主 CPU 三处制约。",
      "  > 报它是为了让「要不要开 SWE_JOBS」有个数可依，而不是凭感觉。",
      "",
    );
  }

  lines.push(
    "逐题（按耗时降序，**先看最上面那条**）：",
    "",
    t.total_setup_ms === null ? "| instance | wall |" : "| instance | wall | 搬运 | 模型 | 收尾 |",
    t.total_setup_ms === null ? "| --- | --- |" : "| --- | --- | --- | --- | --- |",
    ...t.per_instance.map((r) =>
      t.total_setup_ms === null
        ? `| \`${r.instance_id}\` | ${min(r.wall_ms)} min |`
        : `| \`${r.instance_id}\` | **${min(r.wall_ms)} min** | ${min(r.setup_ms!)} | ` +
          `${min(r.agent_ms!)} | ${min(r.extract_ms!)} |`,
    ),
  );
  return lines;
}

/**
 * 身份那几行。抽出来是因为它有 6 个分支，内联进 renderReport 的数组字面量里读不动。
 *
 * ## 渲染层的三条硬约束（都是"注释里写了不够"那一类）
 *
 * 1. **`mtime-fallback` 必须在正文里写「没量到」这三个字**，不能只显示字段值。
 *    读报告的人看不到类型注释，看到一个填着值的字段就会当它是量到的结果。
 * 2. **产物 commit 与宿主 HEAD 分两行**，且不一致时明确标出来。
 * 3. **逃生舱要显眼**。一个用了 `SWE_ALLOW_STALE_ARTIFACT` 的 run 与正常 run
 *    在分数上完全看不出区别，这一行是唯一的区别。
 */
export function renderIdentityLines(a: Acceptance): string[] {
  const lines: string[] = [];
  const measured = a.artifact_identity_source === "embedded";
  const noIdentity = a.artifact_identity_source === "mtime-fallback";

  if (measured && a.artifact_commit) {
    lines.push(
      `- **被测产物**：commit \`${a.artifact_commit}\`` +
        `（分支 \`${a.artifact_branch ?? "?"}\`，origin \`${a.artifact_origin ?? "?"}\`）` +
        `${a.artifact_dirty === true ? " ⚠️ **产物编自脏工作区，只可自比**" : ""}` +
        " ← 产物自报，**事实源**",
    );
  } else if (noIdentity) {
    lines.push(
      "- **被测产物**：⚠️ **身份没量到**（产物不含构建身份 —— 老产物，或构建时漏带 " +
        "`--define process.env.SID_CODE_BUILD_INFO`）。本轮判据退化成 mtime，" +
        "而 mtime 两个方向都会错 —— **「跑的是当前代码」这件事没有得到验证**",
    );
  } else {
    lines.push(
      `- **被测产物**：commit 未记录（本机制上线之前的 run）—— ` + "不知道这个分数是哪份代码跑的",
    );
  }

  const host = a.host_head_commit ?? a.git_commit;
  lines.push(
    `- 宿主 HEAD：\`${host ?? "未记录"}\`` +
      `${a.git_dirty ? " ⚠️ 宿主工作区脏" : ""}` +
      "（跑评测时宿主在哪个 commit，**不是产物身份**，仅供对照）" +
      (measured && a.artifact_commit && host && a.artifact_commit !== host
        ? " ⚠️ **与产物 commit 不一致**（在 PR 分支上验证改动时这是正常的）"
        : ""),
  );

  if (a.gate_bypassed && a.gate_bypassed.length > 0) {
    lines.push(
      `- ⛔ **产物身份门禁被绕过**：\`${a.gate_bypassed.join(", ")}\` —— ` +
        "这份 solved_count **不可与未绕过门禁的 run 并排**",
    );
  }

  lines.push(
    `- 版本号：\`${a.sid_code_version ?? "未记录"}\`（**仅供对照** —— ` +
      "`make build` 不 bump，同一版本号对应过几十个 commit）",
  );
  return lines;
}

export function renderReport(a: Acceptance): string {
  const b = (v: boolean | null) => (v === null ? "未跑" : v ? "PASS" : "FAIL");
  const counts = Object.values(a.outcomes).reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
  return [
    `# SWE-bench Verified 二值 smoke —— ${a.run_id}`,
    "",
    "> 数据隔离：本报告独立于 sid-code 自家评测（不写 baseline_scores、不进 grader registry）。",
    "> **不含百分比字段**：n=10 时 SE=14.5pp、0.95 置信区间半宽 ±28pp，",
    "> 六成与七成统计上无法区分，所以这里只报绝对数，且**不进 release 曲线**。",
    "> （连这段说明里也不出现百分号：门禁是机械的 —— 报告里出现 `数字+%` 即判违规。",
    "> 门禁做得这么钝是**故意的**，「在正文里现算一个 6/10 得六成」和加一个",
    "> percent 字段是同一件事，而只拦字段名拦不住前者。)",
    "",
    `- prompt 版本：\`${a.prompt_version}\``,
    `- 被测模型：\`${a.model ?? "未记录（该分数不可与其他 run 并排）"}\``,
    `- 网关 host：\`${a.gateway_host ?? "未记录"}\``,
    // ⚠️ 顺序本身在传达哪个是事实源：产物 commit 第一、宿主 HEAD 第二、version 最后
    // 且带「仅供对照」。反过来写会让人拿 version 去复算，而同一个版本号
    // 对应过多个 commit（2026-08-26 实测）。
    //
    // ⚠️ 「产物 commit」与「宿主 HEAD」必须分两行印（F3）。合成一行的旧写法
    // 让读者把它们当成同一件事 —— 而产物可能是几天前编的。
    ...renderIdentityLines(a),
    `- 产物指纹：\`${a.artifact_sha256 ?? "未记录"}\``,
    `- 必控变量：effort \`${a.effort_level ?? "未记录"}\`，` +
      `成本闸门 ${a.cost_limit_usd === 0 ? "不限" : `$${a.cost_limit_usd ?? "未记录"}`}，` +
      `并发 ${a.jobs ?? "未记录"}${a.jobs && a.jobs > 1 ? " ⚠️ **不可与串行 run 并排**" : ""}`,
    // ⚠️ 「单次」两个字必须出现在报告正文里：这个字段是单次口径（不合并复跑），
    // 而读的人默认会理解成「重试后仍失败」—— 那是严重得多的结论。
    // 详见 Acceptance.link_ok 的注释。
    `- link_ok（**单次**跑完即产出非空 patch；不合并复跑）：**${b(a.link_ok)}**`,
    ...(a.link_ok
      ? []
      : [
          "  > ⚠️ FAIL 只说明**这一次**有实例零 patch，**不等于 agent 做不出来**。",
          "  > 偶发故障（网关抖动、容器起不来）与能力不足在这个字段上长得一样，",
          "  > 要分开必须复跑那几条并把结论写进正文 —— 见 ZZ.5 第 4 条。",
        ]),
    `- graded_ok（拿到 report 且无 ungraded）：**${b(a.graded_ok)}**`,
    `- gold_ok（环境自检）：**${b(a.gold_ok)}**`,
    `- solved_count：**${a.solved_count} / ${a.total_count}**（绝对数）`,
    `- patch_touches_tests：**${a.patch_touches_tests}**`,
    `- wall_ms（harness 时钟，非 agent 自报）：${a.wall_ms}`,
    `- meter：\`null\` —— ${a.meter_note}`,
    `- partial：${a.partial}`,
    `- unaccounted：${a.unaccounted ?? "无"}`,
    "",
    "## 六类结果分布",
    "",
    ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 逐条",
    "",
    "| instance_id | outcome |",
    "| --- | --- |",
    ...Object.entries(a.outcomes).map(([k, v]) => `| ${k} | ${v} |`),
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 官方 report 定位
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 找官方 report.json。
 *
 * 官方把摘要写成 `<model>.<run_id>.json` 放在 `--report-dir`（默认 cwd）。
 * ⚠️ **找不到就返回 null，绝不返回一个空对象** —— 空对象会让下游
 * 把「没判分」算成「全 0」，那正是本文件头两条要防的东西。
 */
export function findReport(dir: string, runId: string): OfficialReport | null {
  const exact = join(dir, `${MODEL_NAME}.${runId}.json`);
  if (existsSync(exact)) {
    try {
      return JSON.parse(readFileSync(exact, "utf8")) as OfficialReport;
    } catch {
      return null;
    }
  }
  if (!existsSync(dir)) return null;
  const cand = readdirSync(dir).find((f) => f.endsWith(`.${runId}.json`));
  if (!cand) return null;
  try {
    return JSON.parse(readFileSync(join(dir, cand), "utf8")) as OfficialReport;
  } catch {
    return null;
  }
}

/**
 * 从 `runs/gold/` 里读 gold 自检结果，判断**本次提交的这批实例**是否都过了 gold。
 *
 * ⚠️ 判据是「submitted 的每一条都有 gold 通过记录」，不是「gold 目录里有东西」：
 * gold 是逐题跑的（`exec-swebench.sh gold <iid>`，一个文件一题），
 * 少跑了哪题就说明**那题的环境没验证过**。少一条就返 null（= 未跑），
 * 不返 false —— false 的语义是「跑了且失败」，那是要停下来查环境的信号；
 * 把「没跑」记成 false 会让人去查一个根本没发生的失败。
 *
 * 反过来，把「没跑」当成 true 更糟：gold_ok 的全部意义就是把
 * **环境错**与**能力差**分开，默认 true 等于放弃这个区分。
 */
export function readGoldOk(goldDir: string, submitted: string[]): boolean | null {
  if (!existsSync(goldDir) || submitted.length === 0) return null;
  const files = readdirSync(goldDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;

  const resolved = new Set<string>();
  const attempted = new Set<string>();
  for (const f of files) {
    let rep: OfficialReport;
    try {
      rep = JSON.parse(readFileSync(join(goldDir, f), "utf8")) as OfficialReport;
    } catch {
      continue;
    }
    for (const id of rep.submitted_ids ?? []) attempted.add(id);
    for (const id of rep.resolved_ids ?? []) resolved.add(id);
  }

  // 有实例压根没跑过 gold → 未跑（null），不是失败
  if (submitted.some((id) => !attempted.has(id))) return null;
  // 全都跑过了，那么判据就是「是否全部 resolved」
  return submitted.every((id) => resolved.has(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  let runId = "";
  let reportOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run-id") runId = argv[++i] ?? "";
    else if (argv[i] === "--report-only") reportOnly = true;
  }
  if (!runId) {
    console.error("必须给 --run-id。⚠️ 同一 run_id 重跑会复用 harness 缓存（§4.6）");
    process.exit(2);
  }

  const runDir = join(SWE_DIR, "runs", runId);
  const predPath = join(runDir, "predictions.jsonl");
  if (!existsSync(predPath)) {
    console.error(`❌ 找不到 ${predPath.replace(REPO_ROOT + "/", "")} —— 先跑 runner.ts`);
    process.exit(2);
  }

  const preds = readFileSync(predPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { instance_id: string; model_patch: string });
  const submitted = preds.map((p) => p.instance_id);
  const patchBytesById = Object.fromEntries(
    preds.map((p) => [p.instance_id, (p.model_patch ?? "").length]),
  );

  const recPath = join(runDir, "records.jsonl");
  const records: Array<{
    instance_id?: string;
    patch_touches_tests?: boolean;
    wall_ms?: number;
    setup_ms?: number;
    agent_ms?: number;
    extract_ms?: number;
    edits_inside_repo?: number;
    edits_outside_repo?: number;
    // A7.13.2：null 是合法值且语义 = "没量到"，与 undefined（旧 run 无此字段）
    // 在这里刻意都走 `== null` 归到 notMeasured —— 两者对读报告的人是同一件事。
    permission_denials?: number | null;
    permission_denials_by_reason?: Record<string, number>;
    permission_denials_log_proxy?: number;
  }> = existsSync(recPath)
    ? readFileSync(recPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const touchesTestsIds: string[] = records
    .filter((r) => r.patch_touches_tests)
    .map((r) => r.instance_id ?? "")
    .filter(Boolean);
  // 逐题 wall_ms 累加 = 这一轮真正花在跑 agent 上的时间（harness 自己的时钟，
  // 由 exec-swebench.sh 的 now_ms() 量，不是 agent 自报）。
  const recordsWallMs = records.reduce((sum, r) => sum + (r.wall_ms ?? 0), 0);

  // 「零 patch + 编辑全在仓库外」的实例（A7.11.4 的 django-13964 形态）。
  // ⚠️ 用 `?? 0` 而不是 `!== undefined` 判在不在：旧 run 没这两个字段，
  // 缺省成 0 之后 `outside > 0` 恒 false → **旧 run 自然不会被误标**，
  // 这正是想要的行为（没量到就不声称）。
  const editsOnlyOutsideRepoIds: string[] = records
    .filter(
      (r) =>
        (patchBytesById[r.instance_id ?? ""] ?? 0) === 0 &&
        (r.edits_outside_repo ?? 0) > 0 &&
        (r.edits_inside_repo ?? 0) === 0,
    )
    .map((r) => r.instance_id ?? "")
    .filter(Boolean);

  const permissionDenials = aggregatePermissionDenials(records);

  // run-meta.json 由 exec-swebench.sh 的 run 步写。读不到就传 null ——
  // buildAcceptance 会在 unaccounted 里写明「该分数不可与其他 run 并排」，
  // **不做任何猜测式的默认值**。
  let metaModel: string | null = null;
  let metaHost: string | null = null;
  let metaVersion: string | null = null;
  let metaCommit: string | null = null;
  let metaDirty: boolean | null = null;
  let metaArtifactSha: string | null = null;
  let metaArtifactCommit: string | null = null;
  let metaArtifactBranch: string | null = null;
  let metaArtifactDirty: boolean | "unknown" | null = null;
  let metaArtifactOrigin: string | null = null;
  let metaIdentitySource: string | null = null;
  let metaGateVerdict: string | null = null;
  let metaGateBypassed: string[] | null = null;
  let metaHostHead: string | null = null;
  let metaEffort: string | null = null;
  let metaCostLimit: number | null = null;
  let metaJobs: number | null = null;
  const metaPath = join(runDir, "run-meta.json");
  if (existsSync(metaPath)) {
    try {
      const m = JSON.parse(readFileSync(metaPath, "utf8")) as {
        model?: string;
        gateway_host?: string;
        sid_code_version?: string;
        git_commit?: string;
        git_dirty?: boolean;
        artifact_sha256?: string;
        effort_level?: string;
        cost_limit_usd?: number;
        jobs?: number;
        artifact_commit?: string;
        artifact_branch?: string;
        artifact_dirty?: boolean | string;
        artifact_origin?: string;
        artifact_identity_source?: string;
        artifact_gate_verdict?: string;
        gate_bypassed?: string[];
        host_head_commit?: string;
      };
      metaModel = m.model ?? null;
      metaHost = m.gateway_host ?? null;
      metaVersion = m.sid_code_version ?? null;
      metaCommit = m.git_commit ?? null;
      // ⚠️ `?? null` 而不是 `?? false`：旧 run 没这个字段时是"不知道脏不脏"，
      // 记成 false 就是替它断言"干净"—— 那正是这个字段要防的事。
      metaDirty = m.git_dirty ?? null;
      metaArtifactSha = m.artifact_sha256 ?? null;
      // 产物身份（本机制上线之后的 run 才有）。**"unknown" 一律折成 null** ——
      // 让下游只需判 null，不必在每个消费点各自记得 "unknown" 也算没有。
      const nn = (v: string | undefined): string | null => (v && v !== "unknown" ? v : null);
      metaArtifactCommit = nn(m.artifact_commit);
      metaArtifactBranch = nn(m.artifact_branch);
      metaArtifactOrigin = nn(m.artifact_origin);
      metaIdentitySource = nn(m.artifact_identity_source);
      metaGateVerdict = nn(m.artifact_gate_verdict);
      metaGateBypassed = Array.isArray(m.gate_bypassed) ? m.gate_bypassed : null;
      metaHostHead = nn(m.host_head_commit);
      // artifact_dirty 是**三态**：true / false / "unknown"。
      // 这里刻意保留 "unknown" 那一档（不折成 null）—— 它的语义是
      // 「产物里就是没记 dirty」，与「旧 run 没有这个字段」不是一回事。
      metaArtifactDirty =
        typeof m.artifact_dirty === "boolean"
          ? m.artifact_dirty
          : m.artifact_dirty === "unknown"
            ? "unknown"
            : null;
      metaEffort = m.effort_level ?? null;
      metaCostLimit = m.cost_limit_usd ?? null;
      metaJobs = m.jobs ?? null;
    } catch {
      // 读坏了也走 null 那条路：一个残缺的 meta 不比没有 meta 更可信
    }
  }

  // ## expectedTotal 从 subset 现取，**不硬编码 10**
  //
  // 它是 `partial` 的分母。硬编码的话，改了 subset 大小之后 `partial` 会**静默说谎**：
  // subset 缩到 5 条、5 条全跑完了，`5 < 10` 仍判 partial=true，
  // 报告里写「只跑了 5/10」—— 一个已经跑满的 run 被记成跑了一半。
  // 反过来 subset 扩到 15 条时更坏：跑了 10 条会判 partial=false（看着像跑满），
  // **一个只覆盖三分之二的 run 被记成全量。**
  //
  // 读不到 subset 时回落到 `submitted.length`（= 就按这次提交的当分母），
  // 并在 unaccounted 里点破 —— **不静默假装 10**。
  let expectedTotal = submitted.length;
  let subsetReadFailed = false;
  try {
    const n = parseSubset(readFileSync(join(SWE_DIR, "verified-subset.yaml"), "utf8")).length;
    if (n === 0) throw new Error("subset instances 段为空");
    expectedTotal = n;
  } catch {
    expectedTotal = submitted.length;
    subsetReadFailed = true;
  }

  if (!reportOnly) {
    console.error("⚠️ 判分需要官方 harness（起容器）。用 exec-swebench.sh grade 走那一步，");
    console.error("本文件的 --report-only 负责把已产出的 report.json 映射成验收字段。");
    process.exit(3);
  }

  const report = findReport(runDir, runId) ?? findReport(process.cwd(), runId);
  const acceptance = buildAcceptance({
    runId,
    promptVersion: "prompt-v1",
    report,
    submitted,
    patchBytesById,
    touchesTestsIds,
    goldOk: readGoldOk(join(SWE_DIR, "runs", "gold"), submitted),
    // ⚠️ wall_ms 必须是**跑 agent 的累计耗时**（从 records.jsonl 汇总），
    // 不是这个判分脚本自己的耗时。旧写法是 `performance.now() - t0`，
    // 而 t0 到这里只隔了几行纯 I/O —— 实测输出 `wall_ms: 0`。
    // 一个恒为 0 的「耗时」字段比没有这个字段更坏：它看起来像「快到测不出」。
    wallMs: recordsWallMs,
    editsOnlyOutsideRepoIds,
    permissionDenials,
    expectedTotal,
    model: metaModel,
    gatewayHost: metaHost,
    sidCodeVersion: metaVersion,
    artifactCommit: metaArtifactCommit,
    artifactBranch: metaArtifactBranch,
    artifactDirty: metaArtifactDirty,
    artifactOrigin: metaArtifactOrigin,
    artifactIdentitySource: metaIdentitySource,
    artifactGateVerdict: metaGateVerdict,
    gateBypassed: metaGateBypassed,
    hostHeadCommit: metaHostHead,
    gitCommit: metaCommit,
    gitDirty: metaDirty,
    artifactSha256: metaArtifactSha,
    effortLevel: metaEffort,
    costLimitUsd: metaCostLimit,
    jobs: metaJobs,
    subsetReadFailed,
  });

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonOut = join(REPORT_DIR, `swe-bench-verified.${runId}.json`);
  const mdOut = join(REPORT_DIR, `swe-bench-verified.${runId}.md`);
  // 耗时画像挂在 JSON 的 timing 下（不进 Acceptance —— 那个类型是**验收字段**，
  // 加进去会让"验收"与"性能观测"混成一件事，而前者有"不许出现百分比"的硬约束）。
  const timing = buildTimingProfile(records);
  writeFileSync(jsonOut, JSON.stringify({ ...acceptance, timing }, null, 2) + "\n");
  const md = renderReport(acceptance) + renderTimingSection(timing).join("\n") + "\n";
  writeFileSync(mdOut, md);
  console.log(md);
  console.log(`\n已写入：\n  ${jsonOut.replace(REPO_ROOT + "/", "")}`);
  console.log(`  ${mdOut.replace(REPO_ROOT + "/", "")}`);
  // report 缺失是**硬失败**，不能 exit 0 —— 那会让 CI/人误读成「判分完成」
  process.exit(report ? 0 : 3);
}

if (import.meta.main) await main();
