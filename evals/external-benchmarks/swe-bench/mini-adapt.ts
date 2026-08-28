#!/usr/bin/env bun
/**
 * 路 B 对照侧适配器 —— 把 mini-SWE-agent 的产物转成本仓 `grade.ts` 认的形状
 *
 * 事实源：`docs-research/.../01-coding-agent评测集全景与sid-code接入方案.md`
 * A7.12.4（路 B 定义）+ A7.14.4（一题实测）+ A7.14.8（预算裁决）
 *
 * ## 这个文件的唯一职责：格式转换 + 必控变量落盘。一个指标都不重算
 *
 * 路 B 要的是「同一个模型下，sid-code 比标准 scaffold 好多少」。
 * 差值有意义的前提是**除 harness 外全部必控变量对齐**，所以这里做两件事：
 *
 *   1. `preds.json`（dict-of-dict）→ `predictions.jsonl`（一行一条）
 *      —— 判分仍归官方 harness，我们不判 pass/fail。
 *   2. 从 traj.json 抽出**mini 真的有**的过程字段 → `records.jsonl`
 *      —— 抽的是 mini 自己记的数，不是我们替它算的数。
 *
 * ## ⚠️ 最容易做错的一件事：mini 没有的字段必须落 null，不能落 0
 *
 * `RunRecord` 有 20 多个字段，mini 只提供其中一小部分。缺的那些分两类，
 * **两类的正确缺省值相反**，这是本文件唯一容易搞错的地方：
 *
 *   A. **结构性不适用**（mini 这个 harness 压根没有这个概念）
 *      例：`permission_denials` —— mini 没有权限层，不是"没量到"，是"不存在"。
 *      → 落 `null` 并在 `unaccounted` 里写明"该 harness 无此机制"。
 *
 *   B. **同概念但取数源不同**（两边都有，只是字段名/口径不一样）
 *      例：`agent_ms` —— mini 记 wall-clock，我们记 docker exec 区间。
 *      → 落真值，但**口径差异必须写进 unaccounted**，否则会被并排比较。
 *
 * 落 0 的后果与 A7.13.2 同型：把「这个 harness 没有这层防线」伪装成
 * 「这个 harness 一次都没被拦」——前者是不可比，后者是一个优势结论。
 * **两者在数据上完全同形，而结论方向相反。**
 *
 * ## ⚠️ 为什么不复用 record.ts
 *
 * `record.ts` 的输入是**容器里 git diff 的原始输出**（numstat + diff 两段），
 * 它做的是「从 raw 提取 patch」；而 mini 的 `preds.json` 里已经是成品 patch。
 * 复用等于先把成品拆回 raw 再解析一遍，凭空多一层可失败的转换。
 *
 * 但两处**刻意共用** runner.ts 的既有函数，不自己重写：
 *   - `isTestPath` / `parseUnifiedDiffPaths` —— 「哪些路径算测试文件」是判断，
 *     两侧口径必须逐字节一致，否则 `patch_touches_tests` 不可比。
 *   - `normalizePatch` —— patch 末尾换行那条（GNU patch 拒收）对两侧同样成立。
 *
 * ## 用法
 *
 *   bun run evals/external-benchmarks/swe-bench/mini-adapt.ts \
 *     --mini-dir /tmp/mini-routeb --run-id routeb-mini
 *
 * 产物写进 `runs/<run-id>/`，之后照常：
 *
 *   bun run evals/external-benchmarks/swe-bench/grade.ts --run-id routeb-mini
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isTestPath, normalizePatch, patchOnlyAddsFiles, type RunRecord } from "./runner.ts";

/** mini 的 `preds.json` 单条（源码：`run/benchmarks/swebench.py` 的 `update_preds_file`）。 */
interface MiniPred {
  model_name_or_path?: string;
  instance_id?: string;
  model_patch?: string;
}

/**
 * mini 的 `<iid>.traj.json` 里我们会用到的字段。
 *
 * 形状取自 `agents/default.py` 的 `serialize()`（`trajectory_format: mini-swe-agent-1.1`）。
 * ⚠️ 全部可选：mini 在 agent 构造失败时也会落一份 traj，那份只有 `info.exit_status`。
 * 用 `?` 而不是断言存在，是因为**缺字段要能被识别成"缺"**而不是崩掉整轮转换。
 */
interface MiniTraj {
  info?: {
    exit_status?: string;
    submission?: string;
    mini_version?: string;
    model_stats?: { instance_cost?: number; api_calls?: number };
    config?: {
      agent?: { step_limit?: number; cost_limit?: number; wall_time_limit_seconds?: number };
      agent_type?: string;
    };
    /** agent 构造/运行抛异常时才有 */
    traceback?: string;
    exception_str?: string;
  };
  messages?: Array<{ role?: string; content?: unknown; extra?: Record<string, unknown> }>;
  trajectory_format?: string;
}

/**
 * mini 的 exit_status → 我们的过程类 outcome。
 *
 * ⚠️ **`Submitted` 不等于 solved**（A7.14.4 实测点破）：mini 的 exit_status 只说
 * "提交了 patch"，判分要另外跑官方 harness。所以这里映射到的是
 * `patch_produced` 这个**过程**结论，与 sid-code 侧同一个枚举。
 *
 * 未知状态一律 `agent_error` 而不是猜 —— 一个没见过的 exit_status 被映射成
 * "正常提交"，会让链路故障伪装成低分。
 */
export function mapMiniExitStatus(
  exitStatus: string | undefined,
  patchBytes: number,
): { outcome: RunRecord["outcome"]; agentExit: number; note: string | null } {
  const s = (exitStatus ?? "").trim();
  if (!s) {
    return {
      outcome: patchBytes > 0 ? "patch_produced" : "no_patch",
      agentExit: -1,
      note: "traj 里没有 exit_status —— agent_exit 落 -1（未知），不猜 0",
    };
  }
  // mini 的正常收尾。`Submitted` 是唯一表示"跑完并交了 patch"的状态。
  if (s === "Submitted") {
    // ⚠️ 交了但 patch 是空的 —— 这个组合在 mini 侧是可能的
    // （`submission` 为空串时 update_preds_file 照样写一条）。
    // 报成 patch_produced 会让一条空提交混进"有产出"那桶。
    if (patchBytes === 0) {
      return {
        outcome: "no_patch",
        agentExit: 0,
        note: "exit_status=Submitted 但 patch 为空 —— 交了个空的，不计入有产出",
      };
    }
    return { outcome: "patch_produced", agentExit: 0, note: null };
  }
  // 预算类：mini 用 `LimitsExceeded` 系列。它对应我们侧的"轮次/成本预算用尽"，
  // 是**过程受限**而非 harness 故障，所以仍按有无 patch 归桶，但必须留痕。
  if (/limit|exceeded/i.test(s)) {
    return {
      outcome: patchBytes > 0 ? "patch_produced" : "no_patch",
      agentExit: 0,
      note: `exit_status=${s} —— 预算用尽（对应我方 hit_max_turns 形态），非 harness 故障`,
    };
  }
  // 其余一律当故障。含 mini 记的异常类名（如 `RuntimeError`）。
  return {
    outcome: "agent_error",
    agentExit: 1,
    note: `exit_status=${s} —— 非正常收尾，按 agent_error 处理（不猜它是否等价于"没解出来"）`,
  };
}

/**
 * 从 unified diff 里取被改动的文件路径。
 *
 * 我方 record.ts 走的是 `git diff --numstat -z`（结构化），这里只有成品 patch
 * 文本，所以必须自己解析 —— 但**判据仍复用 `isTestPath`**，否则
 * `patch_touches_tests` 两侧口径不一致，那个字段就不可比了。
 *
 * ⚠️ 判据用 `diff --git a/X b/X` 头，**不用 `+++ b/X`**。两条理由：
 *   1. 纯删除文件的 hunk 里 `+++` 是 `/dev/null`，路径只在 `diff --git` 行上；
 *   2. `newFilePaths`（runner.ts）已经用同一个正则，两处口径必须一致 ——
 *      否则 `patch_only_adds_files` 拿到的 allPaths 与它自己算的新建集合不同源。
 */
export function parseDiffPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    // 与 runner.ts `newFilePaths` 同一形态：取 b 侧路径（新名）。
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) out.push(m[2]);
  }
  return [...new Set(out)].sort();
}

/**
 * 把一条 mini 结果转成 `RunRecord`。
 *
 * ## 逐字段的缺省决定（这段是本文件的实质，不是实现细节）
 *
 * | 字段 | mini 有吗 | 落什么 | 为什么 |
 * | --- | --- | --- | --- |
 * | `patch_bytes` | 有（成品 patch） | 真值 | 与我方同口径（都是 normalizePatch 后的字节数） |
 * | `patch_touches_tests` | 可从 diff 推 | 真值 | 判据复用 `isTestPath`，两侧一致 |
 * | `hit_max_turns` | 有（exit_status） | 真值 | mini 的 LimitsExceeded ≈ 我方达到 max-turns |
 * | `patch_only_adds_files` | 可从 patch 推 | 真值 | 判据只需 patch 文本，复用 `patchOnlyAddsFiles` |
 * | `permission_denials` | **没有这个机制** | `null` | 落 0 = 把"没这层防线"说成"没被拦过" |
 * | `edits_inside/outside_repo` | **没有** | 0 + 点破 | 见下方长注释：这两个是数值型，0 有歧义 |
 * | `agent_ms` | 有但口径不同 | 真值 + 点破 | mini 记宿主 wall-clock，我方记 docker exec 区间 |
 * | `setup_ms`/`extract_ms` | **没有** | 省略 | 省略 = 旧 run 形态，grade.ts 已会跳过分解不做假汇总 |
 * | `host_slept_ms` | 没量 | `null` | null=没量到（与我方同语义），0 会伪装成"已验证没休眠" |
 */
export function buildMiniRecord(input: {
  instanceId: string;
  patch: string;
  traj: MiniTraj | null;
  wallMs: number;
}): RunRecord {
  const { instanceId, traj, wallMs } = input;
  const patch = normalizePatch(input.patch ?? "");
  const patchBytes = patch.length;

  const paths = parseDiffPaths(patch);
  const testFiles = paths.filter(isTestPath);
  const onlyAdds = patchBytes > 0 && patchOnlyAddsFiles(patch, paths);

  const exitStatus = traj?.info?.exit_status;
  const mapped = mapMiniExitStatus(exitStatus, patchBytes);

  const notes: string[] = [];
  if (mapped.note) notes.push(mapped.note);

  if (traj === null) {
    notes.push(
      `traj.json 未找到 —— 过程字段（api_calls / instance_cost / exit_status）全部不可用。` +
        `patch 仍取自 preds.json，判分不受影响`,
    );
  } else if (traj.trajectory_format && traj.trajectory_format !== "mini-swe-agent-1.1") {
    // 形状变了要说出来：字段名一改，下面这些 optional 读取会静默全 undefined，
    // 而记录看起来"只是这一轮没量到"。
    notes.push(
      `⚠️ trajectory_format=${traj.trajectory_format}（预期 mini-swe-agent-1.1）—— ` +
        `mini 侧产物结构可能已变，过程字段的缺失可能是解析失败而非真的没量`,
    );
  }
  if (traj?.info?.exception_str) {
    notes.push(`mini 侧抛异常：${traj.info.exception_str}`);
  }
  // 与我方 record.ts 同一条标注（同口径可比）：只新建文件、一行既有源码没改
  // = 大概率卡在复现阶段。**不改判定**，判分仍归官方 harness。
  if (onlyAdds) {
    notes.push(
      `patch 只新建文件、未修改任何既有源码（${paths.length} 个：${paths.join(", ")}）` +
        ` —— 大概率卡在复现阶段而非做出修复。**这不影响判分**`,
    );
  }

  // ── 必控变量对账：这一段是路 B 能不能成立的判据，不是装饰 ──
  //
  // A7.14.8 裁决：`SWE_MAX_TURNS=80` ↔ `step_limit=80`（数值直接相等），
  // 两边 `cost_limit` 均取 0（不限）。这里**不改值、只核对并点破** ——
  // 适配器悄悄"修正"必控变量，等于让一轮不可比的数据长得可比。
  const stepLimit = traj?.info?.config?.agent?.step_limit;
  const costLimit = traj?.info?.config?.agent?.cost_limit;
  if (stepLimit !== undefined && stepLimit !== EXPECTED_STEP_LIMIT) {
    notes.push(
      `🔴 **必控变量不对齐**：mini 侧 step_limit=${stepLimit}，裁决值是 ${EXPECTED_STEP_LIMIT}` +
        `（A7.14.8）—— 这一题比的是"谁预算多"，**不可与 sid-code 侧并排**`,
    );
  }
  if (costLimit !== undefined && costLimit !== 0) {
    notes.push(
      `🔴 **必控变量不对齐**：mini 侧 cost_limit=${costLimit}，裁决值是 0（不限）—— ` +
        `mini 默认 3.0 会**硬停**，被停掉的题看起来像"没解出来"`,
    );
  }

  // ── 结构性不适用的字段：逐条点破，不留白 ──
  //
  // ⚠️ 为什么必须写进 unaccounted 而不是「读的人自己知道 mini 没有权限层」：
  // 报告是给半年后的人看的，那时"mini 没有权限层"这个前提已经不在任何人脑子里。
  // 一个 null 不解释，就会被当成"这一轮没量到"，进而被"下次记得量"。
  notes.push(
    `本 harness（mini-swe-agent）结构性缺以下机制，相应字段落 null/0 **不表示"表现更好"**：` +
      `权限层（permission_denials=null）、` +
      `编辑落点追踪（edits_inside/outside_repo=0，mini 只发 bash 命令、不区分编辑落点）、` +
      `三段耗时分解（setup/extract 省略）`,
  );

  // ⚠️ agent_ms 的口径差异必须点破。两侧都是"真值"，但不是同一个区间：
  //   我方 agent_ms  = docker exec 跑 sid-code 的区间（不含起容器、不含取回产物）
  //   mini 这里      = 我们在外面量的整个 mini 子进程 wall-clock（含它自己起容器）
  // 直接并排比会把 mini 的基础设施耗时算进它的"能力账"，方向是**高估我方优势**。
  if (wallMs > 0) {
    notes.push(
      `⚠️ 耗时口径不同源：本条 wall_ms/agent_ms 是**外部量的 mini 进程墙钟**（含它自建容器），` +
        `而 sid-code 侧 agent_ms 是 docker exec 区间（不含起容器）。` +
        `直接并排会高估我方优势，**耗时对比须限定在同口径字段上或明确折价**`,
    );
  }

  return {
    instance_id: instanceId,
    patch_bytes: patchBytes,
    patch_touches_tests: testFiles.length > 0,
    test_files_touched: testFiles,
    // ✅ 这个**可以**算，且必须算：判据只需要 patch 文本（`patchOnlyAddsFiles`
    // 从 `diff --git` + `new file mode` 推），与 harness 有没有编辑追踪无关。
    // 复用我方同一个函数 → 「卡在复现阶段」这个形态两侧同口径可比。
    patch_only_adds_files: onlyAdds,
    hit_max_turns: /limit|exceeded/i.test(exitStatus ?? ""),
    // mini 没有"LLM 致命错误"这个分类；异常会走 exit_status → agent_error。
    llm_fatal: false,
    // 🔴 结构性不适用 → null。见文件头「最容易做错的一件事」。
    permission_denials: null,
    permission_denials_log_proxy: 0,
    // ⚠️ 这两个是 number 型，没有 null 可落 —— 只能 0 + 上面那条统一点破。
    // 之所以不改类型：`RunRecord` 是 sid-code 侧的事实源，为一个对照 harness
    // 放宽它的类型，会让我方将来"没量到"也能悄悄落 null 而不被发现。
    edits_inside_repo: 0,
    edits_outside_repo: 0,
    edit_paths_outside_repo: [],
    wall_ms: wallMs,
    // setup_ms / extract_ms **刻意省略**（不是落 0）：grade.ts 对缺字段的处理是
    // 「跳过分解、不做假汇总」，正是我们要的。落 0 会让不变量
    // `setup+agent+extract===wall` 被破坏而报账不平。
    agent_ms: wallMs,
    // null = 没量到（与我方同语义）。mini 侧我们没做休眠检测。
    host_slept_ms: null,
    agent_exit: mapped.agentExit,
    outcome: mapped.outcome,
    meter: null,
    meter_note:
      `无中立计价源；成本数字为 mini 自报（litellm 本地 cost map）。` +
      `⚠️ 与 sid-code 侧的自报成本**不同源**（litellm 本地表 vs 网关回传 usage），不可逐分比较`,
    prompt_version: "mini-swebench-yaml",
    unaccounted: notes.join(" | "),
  };
}

/**
 * A7.14.8 的裁决值。**写成常量而不是参数**，因为它是一个已经做出的决定，
 * 做成可调旋钮就会有人在跑不出想要结果时调它 —— 而调完之后两边不可比，
 * 报告上却看不出来。要改这个值，改这里并同步更新那份文档。
 */
export const EXPECTED_STEP_LIMIT = 80;

/**
 * `grade.ts` 认的那份 run-meta（它只读 `runs/<id>/run-meta.json` 这个**固定文件名**）。
 *
 * ## 为什么必须单独产出这一份，而不是让 grade.ts 去读 run-meta.mini.json
 *
 * 实测踩到（2026-08-28，路 B 第一次真跑）：mini 侧 `run-meta.mini.json` 里
 * 模型名、网关、必控变量**全都在**，而 `grade.ts` 产出的报告却写着
 *
 *   - 被测模型：`未记录（该分数不可与其他 run 并排）`
 *   - 网关 host：`未记录`
 *   - 必控变量：effort `未记录`，成本闸门 $未记录，并发 未记录
 *
 * 成因是纯文件名错配：`grade.ts:1065` 读 `run-meta.json`，
 * 而适配器写的是 `run-meta.mini.json`。
 *
 * **这条正好打在 A7.18 的验收判据上**：「两侧 grade.ts 报告能并排」——
 * 而 mini 侧报告自己声明"不可与其他 run 并排比较"。
 * 形态是**两份产物各自都对，合起来的结论是错的**，且没有任何一层报错。
 *
 * ## 为什么不改 grade.ts 去认第二个文件名
 *
 * `grade.ts` 的职责是「把官方 report 翻译成验收字段，一个数都不自己算」。
 * 让它按 harness 分支去找不同文件名，等于把「谁产出的」这件事塞进翻译层 ——
 * 下一个对照 harness 又要在那里加一个分支。
 * **适配器的职责本来就是"产出下游认的形状"**，文件名是形状的一部分。
 *
 * ## ⚠️ 缺的字段一律**不写这个键**，不是写 null 或占位串
 *
 * `grade.ts` 对缺失字段的处理是「在 unaccounted 里点破」，那正是我们要的：
 * mini 没有"产物 commit"这个概念（它是 pip 装的包，不是我们编的二进制），
 * 所以报告里就该出现「未记录产物 commit」。
 * 塞一个 `"n/a"` 进去会让那条点破**消失**，于是
 * 「这个 harness 没有这个概念」被伪装成「已记录且没问题」——
 * 与 A7.13.2（null vs 0）完全同型。
 */
export interface MiniGradeMeta {
  /**
   * mini 的模型名（`anthropic/claude-sonnet-5`）。grade.ts 用它判"可否并排"。
   *
   * ⚠️ **取不到就不写这个键**，不要落 `"unknown"` 之类的占位串 ——
   * grade.ts 的判据是 `!input.model`，任何非空串都会**抑制**
   * 那条「不可与其他 run 并排比较」的点破。见 buildMiniGradeMeta 里的说明。
   */
  model?: string;
  /** 网关 host。**只要 host，绝不要完整 URL、绝不要 key**。同上：取不到就不写 */
  gateway_host?: string;
  /** 必控变量：mini 的 step_limit ↔ 我方 SWE_MAX_TURNS（A7.14.8 裁决数值相等） */
  max_turns: number | null;
  /** mini 的 cost_limit（0 = 不限）。语义与我方 cost_limit_usd 一致 */
  cost_limit_usd: number | null;
  /** mini 串行跑（-w 1）时为 1。>1 时 grade.ts 会点破"不可与串行 run 并排" */
  jobs: number | null;
  /** 本 harness 标识，进报告便于人一眼看出这不是 sid-code 那一侧 */
  harness: "mini-swe-agent";
  /**
   * mini 的版本号。**刻意不填 `sid_code_version`** —— 那个字段的语义是
   * "被测 sid-code 的版本"，填 mini 的版本进去是张冠李戴。
   */
  mini_version: string | null;
}

/** mini 侧 run-meta：必控变量落盘。缺任何一项都要能看出来是"缺"。 */
export interface MiniRunMeta {
  harness: "mini-swe-agent";
  mini_version: string | null;
  agent_type: string | null;
  model_name: string | null;
  step_limit: number | null;
  cost_limit: number | null;
  wall_time_limit_seconds: number | null;
  trajectory_format: string | null;
  instances: number;
  /** 与 sid-code 侧 run-meta 的对账提示，进报告 */
  comparability_notes: string[];
}

export function buildMiniRunMeta(trajs: Array<MiniTraj | null>, preds: MiniPred[]): MiniRunMeta {
  // 取第一份**有 config 的** traj 作为必控变量来源，并核对其余各份是否一致 ——
  // 逐题不一致意味着中途改了配置，那一轮整体不可比。
  const withCfg = trajs.filter((t): t is MiniTraj => !!t?.info?.config?.agent);
  const first = withCfg[0];
  const notes: string[] = [];

  const stepLimits = new Set(withCfg.map((t) => t.info?.config?.agent?.step_limit));
  const costLimits = new Set(withCfg.map((t) => t.info?.config?.agent?.cost_limit));
  if (stepLimits.size > 1) {
    notes.push(
      `🔴 同一轮内 step_limit 不一致（${[...stepLimits].join(", ")}）—— 中途改过配置，整轮不可比`,
    );
  }
  if (costLimits.size > 1) {
    notes.push(`🔴 同一轮内 cost_limit 不一致（${[...costLimits].join(", ")}）—— 整轮不可比`);
  }
  const models = new Set(preds.map((p) => p.model_name_or_path).filter(Boolean));
  if (models.size > 1) {
    notes.push(
      `🔴 同一轮内出现多个模型名（${[...models].join(", ")}）—— ` +
        `模型是路 B 的第一必控变量，不一致则整轮作废`,
    );
  }
  if (withCfg.length === 0) {
    notes.push(
      `⚠️ 没有任何 traj 带 config —— 必控变量全部落 null（"未取到"），` +
        `**无法证明两边预算对齐**，这一轮的差值不可用于归因`,
    );
  }

  const sl = first?.info?.config?.agent?.step_limit ?? null;
  const cl = first?.info?.config?.agent?.cost_limit ?? null;
  if (sl !== null && sl !== EXPECTED_STEP_LIMIT) {
    notes.push(`🔴 step_limit=${sl} ≠ 裁决值 ${EXPECTED_STEP_LIMIT}（A7.14.8）`);
  }
  if (cl !== null && cl !== 0) {
    notes.push(`🔴 cost_limit=${cl} ≠ 裁决值 0（不限）—— mini 默认 3.0 会硬停`);
  }

  return {
    harness: "mini-swe-agent",
    mini_version: first?.info?.mini_version ?? null,
    agent_type: first?.info?.config?.agent_type ?? null,
    model_name: [...models][0] ?? null,
    step_limit: sl,
    cost_limit: cl,
    wall_time_limit_seconds: first?.info?.config?.agent?.wall_time_limit_seconds ?? null,
    trajectory_format: first?.trajectory_format ?? null,
    instances: preds.length,
    comparability_notes: notes,
  };
}

/**
 * 把 mini 侧 run-meta 翻成 `grade.ts` 认的形状（见 `MiniGradeMeta` 的长注释）。
 *
 * `gatewayHost` 由调用方传入（跑 mini 时用的网关，`run-mini.sh` 已对账过与
 * smoke-10 同源）——**不从 traj 里猜**：mini 的 traj 只记 `model_name`，
 * 不记 base_url，猜一个出来就是造数据。传 undefined 时该键不写，
 * 于是报告里出现「网关 host：未记录」，那是诚实的。
 */
export function buildMiniGradeMeta(meta: MiniRunMeta, gatewayHost?: string | null): MiniGradeMeta {
  const out: MiniGradeMeta = {
    max_turns: meta.step_limit,
    cost_limit_usd: meta.cost_limit,
    // mini 由 run-mini.sh 写死 `-w 1`（并发会污染耗时口径，见那里的注释）。
    // 这里不硬编码 1，而是留 null —— 硬编码等于宣称"一定是串行跑的"，
    // 而 MINI_WORKERS 是个环境变量，宣称一件没核过的事正是本文件在防的形态。
    jobs: null,
    harness: "mini-swe-agent",
    mini_version: meta.mini_version,
  };
  // ⚠️ `model` 与 `gateway_host` 都是**取到才写这个键**，取不到就不写。
  //
  // 这里曾写成 `model: meta.model_name ?? "unknown"`，理由是"unknown 既触发点破又可读"
  // —— **那句理由是错的，且变异自证当场抓到了它**：`grade.ts` 的判据是
  // `if (!input.model)`，而 `"unknown"` 是 truthy，于是那条
  // 「不可与其他 run 并排比较」的点破**被抑制掉**。
  // 形态正是本文件通篇在防的那个：把「没取到」伪装成「取到了且没问题」（A7.13.2）。
  //
  // 判据统一成"键在不在"之后，缺失一律走 grade.ts 的点破分支，两个字段同一套语义。
  if (meta.model_name) out.model = meta.model_name;
  if (gatewayHost) out.gateway_host = gatewayHost;
  return out;
}

/** 读一条实例的 traj。找不到返回 null（**不抛**）—— 缺 traj 只让过程字段不可用，patch 仍有效。 */
export function findTraj(miniDir: string, instanceId: string): MiniTraj | null {
  // mini 的落点：`<output>/<instance_id>/<instance_id>.traj.json`
  const p = join(miniDir, instanceId, `${instanceId}.traj.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as MiniTraj;
  } catch {
    // 解析失败与文件不存在在下游是同一件事（过程字段不可用），
    // 但**必须区分记录**——buildMiniRecord 会因 traj===null 写进 unaccounted。
    return null;
  }
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const miniDir = arg("mini-dir", argv);
  const runId = arg("run-id", argv);
  // 跑 mini 时用的网关 host。**不给就不写那个键**（报告里显示"未记录"）——
  // 从 traj 里猜不出来（mini 只记 model_name，不记 base_url），猜就是造数据。
  const gatewayHost = arg("gateway-host", argv);
  if (!miniDir || !runId) {
    console.error(
      "用法：bun run mini-adapt.ts --mini-dir <mini 的 -o 目录> --run-id <本仓 run id>\n" +
        "        [--gateway-host <host>]   跑 mini 时用的网关 host（缺则报告显示未记录）\n" +
        "  产物写进 runs/<run-id>/，之后跑 grade.ts --run-id <run-id>",
    );
    process.exit(2);
  }

  const predsPath = join(miniDir, "preds.json");
  if (!existsSync(predsPath)) {
    console.error(`❌ 找不到 ${predsPath} —— mini 那一轮没跑完或 -o 目录给错了`);
    process.exit(2);
  }

  // mini 的 preds.json 是 **dict-of-dict**（key=instance_id），不是 jsonl。
  // 这个差异是本适配器存在的首要原因。
  const predsObj = JSON.parse(readFileSync(predsPath, "utf8")) as Record<string, MiniPred>;
  const ids = Object.keys(predsObj).sort();
  if (ids.length === 0) {
    console.error(`❌ preds.json 是空的 —— 一题都没跑成，不生成产物（生成空产物会让 grade 报 0%）`);
    process.exit(2);
  }

  const outDir = join(import.meta.dir, "runs", runId);
  mkdirSync(outDir, { recursive: true });

  const predLines: string[] = [];
  const recLines: string[] = [];
  const trajs: Array<MiniTraj | null> = [];
  const preds: MiniPred[] = [];

  for (const id of ids) {
    const pred = predsObj[id] ?? {};
    preds.push(pred);
    const traj = findTraj(miniDir, id);
    trajs.push(traj);

    const rec = buildMiniRecord({
      instanceId: id,
      patch: pred.model_patch ?? "",
      traj,
      // ⚠️ mini 不记逐题墙钟（traj 里没有这个字段），所以这里是 0 = **没量**。
      // 想要耗时对比，得在跑 mini 时自己在外面计时并喂进来 —— 那是另一件事，
      // 不在本适配器里假造一个数。0 让 grade.ts 跳过耗时分解，正是想要的。
      wallMs: 0,
    });
    recLines.push(JSON.stringify(rec));
    predLines.push(
      JSON.stringify({
        instance_id: id,
        // ⚠️ 保留 mini 自己的 model_name_or_path，**不改写成 "sid-code"**：
        // 官方 harness 用它做产物目录名，改写会让两轮的 harness 缓存互相覆盖，
        // 形态是"第二轮秒出结果且分数与第一轮一致"。
        model_name_or_path: pred.model_name_or_path ?? "mini-swe-agent",
        model_patch: normalizePatch(pred.model_patch ?? ""),
      }),
    );
  }

  writeFileSync(join(outDir, "predictions.jsonl"), predLines.join("\n") + "\n");
  writeFileSync(join(outDir, "records.jsonl"), recLines.join("\n") + "\n");

  const meta = buildMiniRunMeta(trajs, preds);
  writeFileSync(join(outDir, "run-meta.mini.json"), JSON.stringify(meta, null, 2) + "\n");
  // ⚠️ 第二份**不是冗余**：grade.ts 只读 `run-meta.json` 这个固定文件名。
  // 少了它，mini 侧报告会写"被测模型未记录 → 不可与其他 run 并排比较"，
  // 而那恰好否掉 A7.18 的验收判据（两侧报告能并排）。详见 MiniGradeMeta 的注释。
  writeFileSync(
    join(outDir, "run-meta.json"),
    JSON.stringify(buildMiniGradeMeta(meta, gatewayHost), null, 2) + "\n",
  );

  const missingTraj = trajs.filter((t) => t === null).length;
  console.log(`✅ 已转换 ${ids.length} 条 → ${outDir.replace(process.cwd() + "/", "")}`);
  console.log(
    `   predictions.jsonl / records.jsonl / run-meta.mini.json / run-meta.json（grade.ts 认这个名）`,
  );
  if (!gatewayHost) {
    console.log(
      `   ⚠️ 未传 --gateway-host —— 报告里网关会显示"未记录"。` +
        `路 B 要求两边同网关，建议补上（run-mini.sh 打印过它）`,
    );
  }
  if (missingTraj > 0) {
    console.log(`   ⚠️ ${missingTraj} 条缺 traj.json —— 那几条过程字段不可用（patch 仍有效）`);
  }
  for (const n of meta.comparability_notes) console.log(`   ${n}`);
  if (meta.comparability_notes.length === 0) {
    console.log(
      `   必控变量对账通过：step_limit=${meta.step_limit} / cost_limit=${meta.cost_limit}`,
    );
  }
  // ⚠️ 不在这里报任何"通过率" —— 判分归官方 harness，本脚本一个数都不判。
  console.log(`\n下一步：bun run evals/external-benchmarks/swe-bench/grade.ts --run-id ${runId}`);
}

if (import.meta.main) await main();
