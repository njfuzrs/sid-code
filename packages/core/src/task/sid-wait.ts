/**
 * 内置等待原语 `sid-wait gh-pr <n>`（R7：20261112-收尾阶段重复挂监听）。
 *
 * ## 要解决的事故
 *
 * 在「等 PR 合并 / 等 CI」这个最高频的等待场景上，正确的退出条件是固定的：合并、关闭、
 * 任一检查失败、head 变化后跟随新 head。但它每次都靠模型手写循环，于是每次都漏一条：
 *
 * - ca8d7e5c 的 `case "$s" in MERGED*) exit 0;; CLOSED*) exit 1;; esac` 只认合并和关闭，
 *   macOS 分片已经 FAILURE 还照样每 20 秒查一次，失败信息晚了 20 分钟才以「期限到」送达；
 * - b0aa0f1e 第一版脚本按本地 `git rev-parse HEAD` 查 check-runs，PR head 被
 *   auto-update-branch 换掉后一直查旧 commit（旧 commit 早已全绿），30 分钟后「期限到」。
 *
 * 两处都不是「模型不够聪明」，而是「每次现写都可能漏」。所以不给提示词加叮嘱，
 * 而是把正确等法做成 harness 解释执行的确定性原语：命令是 `sid-wait gh-pr <n>`，
 * 退出条件的正确性由本模块保证。
 *
 * ## 为什么不是外部二进制
 *
 * `sid-wait` 由 bash / monitor 两个入口在 spawn **之前**识别（见 `parseSidWaitCommand`），
 * 命中则走内置任务实现（`spawnBuiltinShellTask` / `spawnBuiltinMonitorTask`），
 * 不启动 shell 进程。真当外部命令跑会 command not found。
 *
 * ## 与等待登记的关系
 *
 * 对象签名由语法直接给出（`gh:pr:<n>`，见 `wait-subjects.ts` 的 `extractSidWaitSubjects`），
 * 不需要从命令里猜——R1 抽 subject、R2 判重复、R6 判替换、P1 判覆盖全都用同一个签名。
 */

import { spawn } from "node:child_process";

/** 默认轮询间隔：PR 的 CI 状态不会秒级变化，30s 兼顾延迟与请求量 */
export const DEFAULT_SID_WAIT_INTERVAL_MS = 30_000;
/** 可配间隔的钳制区间（秒→毫秒前先钳秒数）：太短是空转，太长会错过「检查刚失败」 */
export const MIN_SID_WAIT_INTERVAL_S = 5;
export const MAX_SID_WAIT_INTERVAL_S = 300;
/** 连续 REST 失败的阈值：抖动不该被误报成「CI 失败」，但一直失败必须退出 */
export const SID_WAIT_MAX_CONSECUTIVE_FAILURES = 3;
/**
 * 失败检查逐条输出的上限（monitor 入口每行一条事件）。
 *
 * 为什么必须有上限：一次全仓 CI 崩（几十个 job 同时 failure）会往事件流里投递几十条
 * `CHECK_FAILED`，把模型上下文冲掉；而 summary 本来就只提 3 项。两条通道口径要一致，
 * 都不能「有多少打多少」。
 */
export const SID_WAIT_MAX_EMITTED_FAILED_CHECKS = 10;
/** 退避上限：连续失败时按 2^n 拉长，但不无限拉长（否则退出要等很久） */
export const SID_WAIT_MAX_BACKOFF_MS = 120_000;
/**
 * 未显式声明 `wait_until_seconds` 时的默认期限（秒）。
 *
 * 为什么内置原语自带期限：不带期限的后台命令是「普通后台任务」，静默 60s 就会被判成
 * 「不会回报」而放行收尾——等 PR 恰好就是长时间静默的那一类，退化成普通任务等于
 * 又回到「期限到才知道」。30 分钟覆盖本仓一次完整 CI（含 macOS 队列），超过它
 * 多半该重新判断 PR 状态而不是继续等。
 */
export const DEFAULT_SID_WAIT_DEADLINE_S = 1800;

/**
 * 退出码。**3/4/5 刻意跳过 2**：2 在 shell 约定里是「用法错误」，而本原语的用法错误
 * 在解析阶段就被拒了（`parseSidWaitCommand` 返回 null，命令根本不会走到这里）。
 */
export const SID_WAIT_EXIT = {
  /** 已合并 */
  MERGED: 0,
  /** 任一检查 failure / cancelled / timed_out / action_required */
  CHECK_FAILED: 1,
  /** 已关闭但未合并 */
  CLOSED: 3,
  /** mergeable_state == dirty（有冲突） */
  CONFLICT: 4,
  /** REST 连续失败超过阈值，或被 GitHub 以 4xx 确定性拒绝（PR 不存在 / 无权限） */
  REST_FAILED: 5,
  /**
   * 等待被取消（kill / 期限到）。
   *
   * **bash / monitor 两个入口不会产出这个码**：kill 路径在入口里先置 `killed` 短路，
   * `run()` 的返回值被丢弃。它只对「直接调用 `runSidWaitGhPr`」的消费方有意义——
   * 那里必须能把「我主动停的」与「查询连续失败」（REST_FAILED）区分开，
   * 否则脚本 `if [ $? -eq 5 ]` 会把主动停止误读成网络故障。
   */
  ABORTED: 6,
} as const;

export type SidWaitExitCode = (typeof SID_WAIT_EXIT)[keyof typeof SID_WAIT_EXIT];

/** 检查失败的结论集合：GitHub check run 的 conclusion 里，这四种代表「这条检查不行了」 */
const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

/** `sid-wait gh-pr <n> [--interval <seconds>]`，整条命令必须是这一个原语 */
const SID_WAIT_GH_PR_PATTERN = /^sid-wait\s+gh-pr\s+(\d{1,9})(?:\s+--interval(?:=|\s+)(\d{1,5}))?$/;

/**
 * 前置 `cd <dir> &&`：模型常把等待写成 `cd /repo && sid-wait gh-pr 779`。
 * 与 `normalizeWaitCommand` 的归一化同口径（它为了判 duplicate/replace 也剥这一段）。
 */
const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*/;

/** 解析结果 */
export interface SidWaitGhPrSpec {
  kind: "gh-pr";
  pr: number;
  /** 轮询间隔（毫秒）；`--interval` 的秒数已钳制到 [MIN, MAX] */
  intervalMs: number;
  /** 调用方是否显式给了 `--interval`（回执据此决定要不要提「默认 30s」） */
  intervalConfigured: boolean;
}

/**
 * 识别内置等待原语。不是 `sid-wait` 形态一律返回 null（**包括**把 sid-wait 拼进
 * 管道 / 重定向 / 命令列表的写法）——那些写法语义不明确，交给 shell 正常执行，
 * 报 command not found 比悄悄只执行其中一段更不容易误导。
 */
export function parseSidWaitCommand(command: string): SidWaitGhPrSpec | null {
  if (typeof command !== "string" || command.length === 0) return null;
  const normalized = command.replace(/\s+/g, " ").trim().replace(CD_PREFIX, "");
  const match = SID_WAIT_GH_PR_PATTERN.exec(normalized);
  if (!match) return null;
  const pr = Number(match[1]);
  if (!Number.isInteger(pr) || pr <= 0) return null;
  const seconds = match[2] === undefined ? undefined : Number(match[2]);
  const clampedSeconds =
    seconds === undefined
      ? undefined
      : Math.min(MAX_SID_WAIT_INTERVAL_S, Math.max(MIN_SID_WAIT_INTERVAL_S, seconds));
  return {
    kind: "gh-pr",
    pr,
    intervalMs: clampedSeconds === undefined ? DEFAULT_SID_WAIT_INTERVAL_MS : clampedSeconds * 1000,
    intervalConfigured: seconds !== undefined,
  };
}

/** bash 回执/前台提示用：这条命令是不是内置原语 */
export function isSidWaitCommand(command: string): boolean {
  return parseSidWaitCommand(command) !== null;
}

/** gh REST 的单 PR 快照（只取本原语用得到的字段） */
export interface GhPullSnapshot {
  state: "open" | "closed";
  merged: boolean;
  /** 最新 head commit sha。**每次轮询都重新取**——这就是 auto-update-branch 的回归点 */
  headSha: string;
  /** `dirty` 表示与 base 有冲突；`unknown` 是 GitHub 还在算，不能当冲突 */
  mergeableState: string | null;
}

/** 一条 check run（只取判失败与报名字需要的字段） */
export interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  /** GitHub 的 job id；失败回执里带上它，模型能直接 `gh run view --job <id>` */
  id?: number;
}

export interface GhCheckRunsSnapshot {
  checkRuns: GhCheckRun[];
}

/**
 * gh REST 客户端。**注入**而不是直接调 `gh`，是为了让单测与回放不联网：
 * 假客户端按轮次吐出真实的 pulls / check-runs 响应序列。
 */
export interface GhRestClient {
  /** GET repos/{owner}/{repo}/pulls/<n> */
  getPull(pr: number): Promise<GhPullSnapshot>;
  /** GET repos/{owner}/{repo}/commits/<sha>/check-runs?per_page=100 */
  getCheckRuns(pr: number, sha: string): Promise<GhCheckRunsSnapshot>;
}

/** 一次轮询的终态判定结果 */
export interface SidWaitGhPrResult {
  exitCode: SidWaitExitCode;
  /** 机器可读的原因，同时用于终态通知的 summary */
  reason:
    | "merged"
    | "closed"
    | "check-failed"
    | "conflict"
    | "rest-failed"
    | "rest-fatal"
    | "aborted";
  /** 失败退出时命中的检查（供回执点名） */
  failedChecks: GhCheckRun[];
  /** 观察到的最后一个 head（终态通知里带，便于核对是不是在旧 commit 上盖的结论） */
  headSha: string | null;
  /** `rest-fatal` 时 GitHub 返回的 HTTP 状态码（404 / 403 等），summary 据此说清原因 */
  httpStatus?: number;
  /** `rest-failed` 时实际累计到的连续失败次数（调用方可传非默认阈值） */
  attempts?: number;
}

export interface SidWaitGhPrOptions {
  pr: number;
  client: GhRestClient;
  /** 每行输出（不含换行）。bash 入口写 `.output`，monitor 入口每行投递一条事件 */
  emit: (line: string) => void;
  intervalMs?: number;
  maxConsecutiveFailures?: number;
  /** 取消信号：被 kill 时立即停止轮询，不再打 REST */
  signal?: AbortSignal;
  /** 测试注入：单次 sleep。返回 false 表示被取消 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

/** 可取消的 sleep：返回 false 表示 signal 先到 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * 从 `gh api` 的错误信息里取 HTTP 状态码。
 *
 * `gh api` 失败时 stderr 形如 `gh: Not Found (HTTP 404)`，状态码是唯一能区分
 * 「确定性拒绝」与「暂时故障」的信号：4xx 重试没有意义（PR 号打错、token 对该仓库
 * 无读权限、仓库不存在），而 5xx / 超时 / DNS 抖动才值得退避。
 *
 * 注意用**原始消息**提取而不是 `describeError` 截断后的 200 字符——状态码在行尾，
 * 长 stderr 会被截掉。
 */
export function extractHttpStatus(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const match = /\(HTTP (\d{3})\)/.exec(message);
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 400 && status <= 599 ? status : undefined;
}

/** 短 sha：通知正文里够核对是哪个 commit，又不占篇幅 */
function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "未知 commit";
}

/**
 * 轮询主循环。
 *
 * 三条不变量（每一条都对应一次真实事故）：
 *
 * 1. **每一轮都重新取 pull 再取 `head.sha`**，用它去查 check-runs。b0aa0f1e 第一版脚本
 *    按本地 `git rev-parse HEAD` 查，PR head 被 auto-update-branch 换掉后一直查旧 commit，
 *    30 分钟等到期限——这是本原语存在的主要理由，写成回归用例（head 在第 2 次查询时变化）。
 * 2. **出现终态立刻返回，不等「全部检查跑完」**。等的是「有没有坏消息」：一条 failure
 *    就够让 PR 合不进去，等其余 pending 只会把失败信息推迟成「期限到」。
 * 3. **沉默不等于成功**：首轮打一行 `WATCHING`（让通知正文里有现场），之后只在状态
 *    变化时输出。每轮都打一行会把 `.output` 变成噪声，而 monitor 入口每行都是一条事件。
 *
 * 失败重试与退避：REST 失败按 2^n 拉长间隔，连续 `maxConsecutiveFailures` 次才退出
 * （exit 5）。网络抖动不该被误报成「CI 失败」，但一直失败必须退出——否则等待会一直
 * 挂着，又一次退化成「期限到才知道」。
 */
export async function runSidWaitGhPr(opts: SidWaitGhPrOptions): Promise<SidWaitGhPrResult> {
  const intervalMs = opts.intervalMs ?? DEFAULT_SID_WAIT_INTERVAL_MS;
  const maxFailures = opts.maxConsecutiveFailures ?? SID_WAIT_MAX_CONSECUTIVE_FAILURES;
  const sleep = opts.sleep ?? defaultSleep;
  const { signal } = opts;
  const emit = (line: string): void => opts.emit(line);

  let lastHead: string | null = null;
  let announced = false;
  let failures = 0;

  const aborted = (): SidWaitGhPrResult => ({
    exitCode: SID_WAIT_EXIT.ABORTED,
    reason: "aborted",
    failedChecks: [],
    headSha: lastHead,
  });

  /** 记一次 REST 失败；返回 null 表示已退避、应继续轮询，否则返回终态 */
  const onRestFailure = async (
    endpoint: string,
    err: unknown,
  ): Promise<SidWaitGhPrResult | null> => {
    // 4xx 是确定性拒绝：PR 号打错、token 对该仓库无读权限、仓库不存在。
    // 重试改变不了结果，只会让「PR 不存在」这件事拖到 3 次退避之后（默认 60s+120s）
    // 才报出来——那正是本原语要消灭的「等很久才知道」。立即终态。
    // 5xx / 超时 / DNS 抖动仍然退避重试。
    const httpStatus = extractHttpStatus(err);
    if (httpStatus !== undefined && httpStatus < 500) {
      emit(`REST_FATAL ${endpoint} HTTP ${httpStatus} ${describeError(err)}`);
      return {
        exitCode: SID_WAIT_EXIT.REST_FAILED,
        reason: "rest-fatal",
        failedChecks: [],
        headSha: lastHead,
        httpStatus,
      };
    }
    failures += 1;
    emit(`REST_ERROR ${endpoint} ${describeError(err)}（连续 ${failures}/${maxFailures}）`);
    if (failures >= maxFailures) {
      return {
        exitCode: SID_WAIT_EXIT.REST_FAILED,
        reason: "rest-failed",
        failedChecks: [],
        headSha: lastHead,
        attempts: failures,
      };
    }
    const backoffMs = Math.min(intervalMs * 2 ** failures, SID_WAIT_MAX_BACKOFF_MS);
    if (!(await sleep(backoffMs, signal))) return aborted();
    return null;
  };

  for (;;) {
    if (signal?.aborted) return aborted();

    // ── pulls/<n>：终态判定 + 最新 head ──
    // 注意这里**不**清零 failures：清零只发生在整轮（pull + check-runs）都成功之后。
    // 曾经在 getPull 成功后就清零，于是 check-runs 端点持续失败（token 缺 Checks 读权限、
    // GHE 未启用 checks API）时，计数每轮被打回 0，`failures >= maxFailures` 永远不成立，
    // 等待只能跑满 30 分钟期限——正好退化成本原语要消灭的「期限到才知道」。
    let pull: GhPullSnapshot;
    try {
      pull = await opts.client.getPull(opts.pr);
    } catch (err) {
      const terminal = await onRestFailure(`pulls/${opts.pr}`, err);
      if (terminal) return terminal;
      continue;
    }

    if (pull.merged) {
      emit(`MERGED ${pull.headSha}`);
      return {
        exitCode: SID_WAIT_EXIT.MERGED,
        reason: "merged",
        failedChecks: [],
        headSha: pull.headSha,
      };
    }
    if (pull.state === "closed") {
      emit(`CLOSED ${pull.headSha}`);
      return {
        exitCode: SID_WAIT_EXIT.CLOSED,
        reason: "closed",
        failedChecks: [],
        headSha: pull.headSha,
      };
    }
    if (pull.mergeableState === "dirty") {
      emit(`CONFLICT ${pull.headSha} mergeable_state=dirty`);
      return {
        exitCode: SID_WAIT_EXIT.CONFLICT,
        reason: "conflict",
        failedChecks: [],
        headSha: pull.headSha,
      };
    }

    // 第 1 条不变量：head 变了就丢掉旧结论，按新 head 重新看
    if (lastHead !== null && pull.headSha !== lastHead) {
      emit(`HEAD_CHANGED ${lastHead}→${pull.headSha}`);
      announced = false;
    }
    lastHead = pull.headSha;

    // ── commits/<head>/check-runs：只看这个 head 的检查 ──
    let checks: GhCheckRunsSnapshot;
    try {
      checks = await opts.client.getCheckRuns(opts.pr, pull.headSha);
      // 整轮都成功了才清零：这就是「连续失败」的唯一定义点（见上面 pulls 分支的注释）
      failures = 0;
    } catch (err) {
      const terminal = await onRestFailure(`commits/${pull.headSha}/check-runs`, err);
      if (terminal) return terminal;
      continue;
    }

    const failed = checks.checkRuns.filter(
      (run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion),
    );
    if (failed.length > 0) {
      // 每条失败一行：monitor 入口每行一条事件，模型能逐条看到是哪个分片坏了。
      // 但必须有上限——全仓 CI 崩时几十个 job 同时 failure，逐条投递会把上下文冲掉；
      // summary 本来就只提 3 项，这里收敛到同一量级，超出的部分用一行说明。
      for (const run of failed.slice(0, SID_WAIT_MAX_EMITTED_FAILED_CHECKS)) {
        emit(`CHECK_FAILED ${run.name} (${run.conclusion}) job=${run.id ?? "?"}`);
      }
      const omitted = failed.length - SID_WAIT_MAX_EMITTED_FAILED_CHECKS;
      if (omitted > 0) {
        emit(`CHECK_FAILED_MORE 另有 ${omitted} 项失败未列出（共 ${failed.length} 项）`);
      }
      return {
        exitCode: SID_WAIT_EXIT.CHECK_FAILED,
        reason: "check-failed",
        failedChecks: failed,
        headSha: pull.headSha,
      };
    }

    if (!announced) {
      const pending = checks.checkRuns.filter((run) => run.conclusion === null).length;
      emit(
        `WATCHING gh:pr:${opts.pr} head=${pull.headSha} checks=${checks.checkRuns.length}` +
          (pending > 0 ? ` pending=${pending}` : ""),
      );
      announced = true;
    }

    if (!(await sleep(intervalMs, signal))) return aborted();
  }
}

/** 终态通知/回执里的一句话摘要（退出码之外还要说清「为什么结束」） */
export function formatSidWaitResultSummary(result: SidWaitGhPrResult, pr: number): string {
  switch (result.reason) {
    case "merged":
      return `等待结束：PR #${pr} 已合并（${shortSha(result.headSha)}）`;
    case "closed":
      return `等待结束：PR #${pr} 已关闭但未合并（${shortSha(result.headSha)}）`;
    case "conflict":
      return `等待结束：PR #${pr} 与 base 有冲突（mergeable_state=dirty，${shortSha(result.headSha)}）`;
    case "check-failed": {
      const names = result.failedChecks.map((c) => `${c.name}(${c.conclusion})`);
      const shown = names.slice(0, 3).join("、");
      const more = names.length > 3 ? ` 等 ${names.length} 项` : "";
      return `等待结束：PR #${pr} 有检查失败——${shown}${more}（${shortSha(result.headSha)}）`;
    }
    case "rest-failed":
      return `等待结束：查询 PR #${pr} 的 gh REST 连续失败 ${
        result.attempts ?? SID_WAIT_MAX_CONSECUTIVE_FAILURES
      } 次，无法判断状态`;
    case "rest-fatal":
      return `等待结束：查询 PR #${pr} 被 GitHub 拒绝（HTTP ${
        result.httpStatus ?? "4xx"
      }）——这不是暂时的网络问题，先确认 PR 号存在、当前 token 对该仓库有读权限`;
    case "aborted":
      return `等待结束：PR #${pr} 的等待已被停止`;
  }
}

// ── gh CLI 实现（生产用）──

export interface GhCliRestClientOptions {
  /** gh 可执行文件；默认 `gh`（测试可指向假的） */
  ghBin?: string;
  /** `gh api` 的工作目录：决定 `{owner}/{repo}` 占位符解析到哪个仓库 */
  cwd?: string;
  /** 单次 gh 调用超时；默认 20s。gh 挂住时轮询不能跟着挂 */
  timeoutMs?: number;
}

/** 从 GitHub 响应里宽容地取字段：字段缺失/类型不对按「这次查询无效」抛错，计入 REST 失败 */
function toPullSnapshot(raw: unknown, pr: number): GhPullSnapshot {
  const obj = raw as Record<string, unknown> | null;
  const head = obj?.head as Record<string, unknown> | undefined;
  const headSha = typeof head?.sha === "string" ? head.sha : "";
  if (!obj || !headSha) {
    throw new Error(`pulls/${pr} 响应缺少 head.sha`);
  }
  return {
    state: obj.state === "closed" ? "closed" : "open",
    merged: obj.merged === true,
    headSha,
    mergeableState: typeof obj.mergeable_state === "string" ? obj.mergeable_state : null,
  };
}

function toCheckRunsSnapshot(raw: unknown): GhCheckRunsSnapshot {
  const obj = raw as Record<string, unknown> | null;
  const list = Array.isArray(obj?.check_runs) ? (obj.check_runs as unknown[]) : [];
  return {
    checkRuns: list.map((item) => {
      const run = item as Record<string, unknown>;
      return {
        name: typeof run.name === "string" && run.name ? run.name : "(未命名检查)",
        status: typeof run.status === "string" ? run.status : "",
        conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
        id: typeof run.id === "number" ? run.id : undefined,
      };
    }),
  };
}

/**
 * 生产实现：`gh api` 打 REST。
 *
 * 用 `{owner}/{repo}` 占位符而不是自己解析 remote：gh 会按 cwd 的仓库自动填，
 * fork / worktree / 多 remote 的语义与模型手敲 `gh` 完全一致，不必在这里重造一套。
 * `filter=latest` 让同一 commit 上重跑的检查只返回最新一次，避免旧 run 的 failure 冒充当前状态。
 */
export function createGhCliRestClient(options: GhCliRestClientOptions = {}): GhRestClient {
  const bin = options.ghBin ?? "gh";
  const timeoutMs = options.timeoutMs ?? 20_000;

  const runApi = (endpoint: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(bin, ["api", endpoint], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`gh api ${endpoint} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`无法执行 ${bin}：${err.message}`));
      });
      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const detail = stderr.replace(/\s+/g, " ").trim().slice(0, 200) || "无 stderr";
          reject(new Error(`gh api ${endpoint} 失败（exit ${code}）：${detail}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`gh api ${endpoint} 返回的不是 JSON：${stdout.slice(0, 120)}`));
        }
      });
    });

  return {
    async getPull(pr: number): Promise<GhPullSnapshot> {
      return toPullSnapshot(await runApi(`repos/{owner}/{repo}/pulls/${pr}`), pr);
    },
    async getCheckRuns(_pr: number, sha: string): Promise<GhCheckRunsSnapshot> {
      const ref = encodeURIComponent(sha);
      return toCheckRunsSnapshot(
        await runApi(`repos/{owner}/{repo}/commits/${ref}/check-runs?per_page=100&filter=latest`),
      );
    },
  };
}

/**
 * 测试钩子：入口集成测试不该真的 spawn `gh`（会打网络、依赖登录态与 cwd 的仓库）。
 *
 * 生产路径只有 `createGhCliRestClient` 一个实现；这个覆盖点存在的唯一理由是
 * 「bash / monitor 两个入口确实接管了 sid-wait」这件事必须能被离线断言。
 */
let clientFactoryOverride: ((options: GhCliRestClientOptions) => GhRestClient) | null = null;

export function setSidWaitClientFactoryForTest(
  factory: ((options: GhCliRestClientOptions) => GhRestClient) | null,
): void {
  clientFactoryOverride = factory;
}

/** 入口统一走这里：生产 = gh CLI，测试 = 注入的假客户端 */
export function createSidWaitClient(options: GhCliRestClientOptions = {}): GhRestClient {
  return clientFactoryOverride ? clientFactoryOverride(options) : createGhCliRestClient(options);
}

// ── 手写循环的兜底提示（R7 修法 4）──
/**
 * 已经提示过的对象（`gh:pr:<n>`）。
 *
 * **只在回执里说一次**：每次手写循环都追加一句「可以用 sid-wait」会变成噪声，
 * 而模型看到第一遍就够了。模块级 Set ≈ 进程级 ≈ 会话级——交互式进程通常一个会话，
 * 宁可后续会话不再提示，也不要每轮重复。
 */
const manualLoopHintShown = new Set<string>();

/**
 * 模型自己写了轮询循环（而不是用内置原语）时，在等待回执里补一句内置写法。
 *
 * 只在「确实在等一个 PR」时提示：`subjects` 里没有 `gh:pr:<n>` 的等待（等构建、等日志、
 * 等文件）没有对应的内置原语，提示它们只会误导。
 */
export function formatManualLoopHint(subjects: readonly string[], command: string): string {
  if (isSidWaitCommand(command)) return "";
  const prSubjects = subjects.filter((s) => /^gh:pr:\d+$/.test(s));
  const fresh = prSubjects.filter((s) => !manualLoopHintShown.has(s));
  if (fresh.length === 0) return "";
  for (const s of fresh) manualLoopHintShown.add(s);
  const pr = fresh[0]!.slice("gh:pr:".length);
  return (
    `\n提示：等 PR #${pr} 的合并 / CI 可以直接用内置原语 \`sid-wait gh-pr ${pr}\`` +
    `（bash + run_in_background=true）。退出条件由 harness 保证：合并、检查失败、关闭、` +
    `冲突、CI 重跑换 head 都会立即退出，不必自己写循环。`
  );
}

/** 测试钩子：提示状态是模块级的，用例之间必须能重置 */
export function __resetManualLoopHintForTest(): void {
  manualLoopHintShown.clear();
}
