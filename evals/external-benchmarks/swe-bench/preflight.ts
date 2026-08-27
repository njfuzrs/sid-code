#!/usr/bin/env bun
/**
 * SWE-bench Verified 阶段 A —— preflight 五项断言（失败即停）
 *
 * 事实源：`evals/external-benchmarks/swe-bench/接入计划.md` §4.1
 * 决策留痕：`.agents/notes/proposed/testing/2026-08-24-swe-bench-阶段a-二值smoke方案.md`
 *
 * ## 为什么它排在最先，且要能独立跑
 *
 * 业界 harness（DeepSeek-Reasonix）的 `preflight()` 在 `loadSwebenchSubset()` **之前**
 * 且失败即 `os.Exit(2)`。排在后面意味着前面几步的产出可能全部作废 —— 尤其第 ④ 项
 * 「arm64 镜像能不能构建出来」是整个阶段 A 唯一的未知风险（官方无任何耗时基准），
 * 在写完 runner 才发现构建不出来，前面全白做。
 *
 * ## ⚠️ 这个脚本最重要的设计约束：不可执行 ≠ 通过
 *
 * 断言 ①②③④ 需要 docker daemon / 已装 `swebench` / 已从 dataset 取到 `base_commit`。
 * 这些前置**不到位时一律报 `skip`，且总判定退化为 `INCOMPLETE`（退出码 3）**，
 * 绝不因为「没能力检查」就返回 0。
 *
 * 这条不是洁癖，是本仓反复踩过的同一个陷阱换位置：路径 A 的 scorer 硬编码
 * `return Score(value=0)`，得到的是一个「假 0%」——看起来是结论，其实是仪器没接上。
 * 「preflight 全绿因为四项都没真跑」和它是同一个东西。所以：
 *
 *   PASS       = 五项全 pass                      → 0
 *   FAIL       = 任一项 fail                      → 2（同 Reasonix）
 *   INCOMPLETE = 无 fail 但有 skip                → 3（**不许当通过**）
 *
 * ## 用法
 *
 *   # 只跑能跑的（本机 macOS arm64、docker 未起时会是 INCOMPLETE）
 *   bun run evals/external-benchmarks/swe-bench/preflight.ts \
 *     --run-network sid-swebench-run --build-network sid-swebench-build \
 *     --proxy http://127.0.0.1:8080
 *
 *   # 带上第 2 步产出的 base_commit，把 ③ 也激活
 *   ... --instance-id sympy__sympy-13647 --base-commit <sha> --image <local image key>
 *
 *   # 激活 ④（真构建 1 个实例镜像并计时，可能是小时量级）
 *   ... --build-instance sympy__sympy-13647
 *
 *   --json     机器可读输出（给 runner / 报告消费）
 *   --bin PATH sid-code 二进制路径（默认仓库根的开发版产物）
 */

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
// ⑥ 的判定复用 scripts/lib 里那份唯一实现 —— G1（bash）与本文件（TS）
// 必须给出相同结论，各写一份的形态是「两处各自漂移、且漂移不报错」。
import {
  assessArtifact,
  artifactMtimeSec,
  makeGitProbe,
  sniffArtifactIdentity,
  verifySidecar,
} from "../../../scripts/lib/artifact-identity.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 单项断言的判定。`skip` 是一等公民 —— 见文件头「不可执行 ≠ 通过」。 */
export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  /**
   * ①–⑥，与 接入计划.md §4.1 的编号一一对应，改编号要同步改文档。
   * ⑥（产物身份）是后加的，它不在原 §4.1 里 —— 由构建溯源方案引入。
   */
  id: "1" | "2" | "3" | "4" | "5" | "6";
  name: string;
  status: CheckStatus;
  /** fail/skip 时必须说清「什么没到位」；pass 时可留空 */
  reason?: string;
  /** 附加事实（实测到的数字、命令输出摘要）。计时结果落在这里 */
  detail?: Record<string, unknown>;
}

export type Verdict = "PASS" | "FAIL" | "INCOMPLETE";

export interface PreflightArgs {
  /** agent 运行期用的隔离 docker network 名 */
  runNetwork?: string;
  /** 镜像构建期用的 network 名（必须与 runNetwork 不同，见 §4.1 ②） */
  buildNetwork?: string;
  /** allowlist 代理 URL（只放 model API） */
  proxy?: string;
  /** ③ 需要：instance_id 与它的 base_commit（第 2 步从 dataset 现取） */
  instanceId?: string;
  baseCommit?: string;
  /** ③ 需要：本地镜像 key。⚠️ 设了 namespace 后 harness 会把 `__` 写成 `_1776_` */
  image?: string;
  /** ④ 需要：要真构建计时的 instance_id */
  buildInstance?: string;
  /**
   * ④ 可选：逐实例 Dockerfile 的 task repo（本地目录或 owner/repo）。
   *
   * 5.0.2 用它替代了已删除的 `--namespace ''`。不传 = 默认拉 registry 镜像，
   * 而官方镜像名硬编码 `x86_64`，在 arm64 上会 404（实测）。
   */
  taskRepo?: string;
  /** ⑤ 用：sid-code 二进制路径 */
  bin: string;
  json: boolean;
}

/** 注入的命令执行器，便于单测不依赖 docker / 真二进制。 */
export interface Runner {
  /** 返回退出码与合并后的输出。命令不存在时应返回非 0 而不是抛。 */
  run(cmd: string[], opts?: { timeoutMs?: number }): { code: number; out: string };
  /** 单调时钟毫秒（注入以便测试可控；生产传 performance.now） */
  now(): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 参数解析
// ─────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): PreflightArgs {
  const args: PreflightArgs = {
    bin: join(REPO_ROOT, "sid-code"),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-network") args.runNetwork = argv[++i];
    else if (a === "--build-network") args.buildNetwork = argv[++i];
    else if (a === "--proxy") args.proxy = argv[++i];
    else if (a === "--instance-id") args.instanceId = argv[++i];
    else if (a === "--base-commit") args.baseCommit = argv[++i];
    else if (a === "--image") args.image = argv[++i];
    else if (a === "--build-instance") args.buildInstance = argv[++i];
    else if (a === "--task-repo") args.taskRepo = argv[++i];
    else if (a === "--bin") args.bin = argv[++i];
    else if (a === "--json") args.json = true;
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// 总判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 五项结果 → 总判定。
 *
 * ⚠️ 三档不是两档：`INCOMPLETE` 存在的唯一理由是**不让「没检查」冒充「检查通过」**。
 * 谁把它折叠回 PASS，就重新造出了那个「假 0%」。
 */
export function classifyVerdict(results: CheckResult[]): { verdict: Verdict; exitCode: number } {
  if (results.some((r) => r.status === "fail")) return { verdict: "FAIL", exitCode: 2 };
  if (results.some((r) => r.status === "skip")) return { verdict: "INCOMPLETE", exitCode: 3 };
  return { verdict: "PASS", exitCode: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// ① agent 运行期网络隔离
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判定 docker network 是否真的隔离。
 *
 * 判据是 `docker network inspect -f '{{.Internal}}'` 返回 `true` —— **不是**「网络存在」。
 * 一个存在但非 internal 的 network 照样能出网，用「存在」当判据等于没查。
 */
export function judgeNetworkInternal(inspect: { code: number; out: string }): {
  ok: boolean;
  reason?: string;
} {
  if (inspect.code !== 0) {
    return {
      ok: false,
      reason: `docker network inspect 失败: ${inspect.out.trim().slice(0, 200)}`,
    };
  }
  const v = inspect.out.trim().toLowerCase();
  if (v === "true") return { ok: true };
  return {
    ok: false,
    reason: `network 存在但 Internal=${v || "(空)"} —— 非 internal 的 network 照样能出网，等于没隔离`,
  };
}

function check1RunNetwork(args: PreflightArgs, runner: Runner, dockerUp: boolean): CheckResult {
  const base = { id: "1", name: "agent 运行期网络隔离（隔离 network + allowlist 代理）" } as const;

  // 缺参数是**配置错误**，不是环境限制 —— 抄 Reasonix：两者缺一即拒绝，
  // 「with off-box egress the agent reads the upstream fix and every solve is unearned」。
  if (!args.runNetwork || !args.proxy) {
    return {
      ...base,
      status: "fail",
      reason:
        "--run-network 与 --proxy 都是必填：agent 能自由出网时，它会去读上游修复，" +
        "每一次「解出」都不是自己挣的（实测有 25% rollout 试图 git log 找答案）",
    };
  }
  if (!dockerUp) {
    return {
      ...base,
      status: "skip",
      reason: "docker daemon 不可达，无法核验 network 真的是 internal（配置已给，但没验成不算验）",
      detail: { run_network: args.runNetwork, proxy: args.proxy },
    };
  }

  const inspect = runner.run([
    "docker",
    "network",
    "inspect",
    "-f",
    "{{.Internal}}",
    args.runNetwork,
  ]);
  const j = judgeNetworkInternal(inspect);
  return {
    ...base,
    status: j.ok ? "pass" : "fail",
    reason: j.reason,
    detail: { run_network: args.runNetwork, proxy: args.proxy },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 构建期 / 运行期出网策略确实分离
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 名称层判据（不需要 docker）：两个 network 名必须不同。
 *
 * 这条是 D3（`--namespace ''` 本地重建镜像）带出来的：本地构建**必须**能访问
 * PyPI / conda / GitHub，而防作弊要求运行期「只放 model API」。同一个 network
 * 不可能同时满足两者 —— 名字相同就说明根本没分离，此时无论 docker 怎么答都是 fail。
 */
export function judgeNetworkSeparation(
  runNetwork: string | undefined,
  buildNetwork: string | undefined,
): { ok: boolean; reason?: string } {
  if (!runNetwork || !buildNetwork) {
    return {
      ok: false,
      reason: "--run-network 与 --build-network 都必须显式给出（缺一说明只有一套策略）",
    };
  }
  if (runNetwork === buildNetwork) {
    return {
      ok: false,
      reason:
        `构建期与运行期用了同一个 network "${runNetwork}" —— ` +
        "本地重建镜像必须能访问 PyPI/conda/GitHub，而运行期必须只放 model API，" +
        "一套 network 承担不了这两个相反的要求",
    };
  }
  return { ok: true };
}

function check2EgressSeparation(
  args: PreflightArgs,
  runner: Runner,
  dockerUp: boolean,
): CheckResult {
  const base = { id: "2", name: "构建期/运行期出网策略是分离的两套" } as const;

  const sep = judgeNetworkSeparation(args.runNetwork, args.buildNetwork);
  if (!sep.ok) return { ...base, status: "fail", reason: sep.reason };

  if (!dockerUp) {
    return {
      ...base,
      status: "skip",
      reason: "名字层已确认是两个不同 network，但两者的 Internal 取值需 docker 才能核验",
      detail: { run_network: args.runNetwork, build_network: args.buildNetwork },
    };
  }

  // 分离的实质判据：运行期 internal=true，构建期 internal=false。
  // 若构建期也是 internal，本地重建装不上依赖；若运行期不是 internal，防作弊失效。
  const runI = runner.run([
    "docker",
    "network",
    "inspect",
    "-f",
    "{{.Internal}}",
    args.runNetwork!,
  ]);
  const buildI = runner.run([
    "docker",
    "network",
    "inspect",
    "-f",
    "{{.Internal}}",
    args.buildNetwork!,
  ]);
  const detail = {
    run_network: args.runNetwork,
    build_network: args.buildNetwork,
    run_internal: runI.out.trim(),
    build_internal: buildI.out.trim(),
  };

  const j = judgeEgressSeparation(runI, buildI);
  return { ...base, status: j.ok ? "pass" : "fail", reason: j.reason, detail };
}

/** 运行期必须 internal、构建期必须非 internal —— 两个方向都要查，只查一头等于半个断言。 */
export function judgeEgressSeparation(
  runInspect: { code: number; out: string },
  buildInspect: { code: number; out: string },
): { ok: boolean; reason?: string } {
  const runJ = judgeNetworkInternal(runInspect);
  if (!runJ.ok) return { ok: false, reason: `运行期 network 不合格: ${runJ.reason}` };
  if (buildInspect.code !== 0) {
    return {
      ok: false,
      reason: `构建期 network inspect 失败: ${buildInspect.out.trim().slice(0, 200)}`,
    };
  }
  if (buildInspect.out.trim().toLowerCase() === "true") {
    return {
      ok: false,
      reason: "构建期 network 是 internal=true —— 本地重建镜像装不上 PyPI/conda 依赖，会构建失败",
    };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 镜像内没有上游 fix commit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 镜像内 `/testbed` 的 git 状态 → 是否「答案已经在镜像里」。
 *
 * 两part 都要查，缺一个就有漏网形态：
 *  - `HEAD == base_commit`：防 checkout 到了修复之后的提交；
 *  - 工作树干净：HEAD 对但补丁已经 apply 在工作树里时，HEAD 照样等于 base_commit。
 *
 * 本地重建镜像（`--namespace ''`）时构建期是放开出网的，拉到的东西会固化进镜像层 ——
 * 这就是这条断言存在的原因，官方镜像可信不代表你自己构建的可信。
 */
export function judgeNoFixCommit(input: {
  headSha: string;
  baseCommit: string;
  treeDirty: boolean;
}): { ok: boolean; reason?: string } {
  const head = input.headSha.trim();
  const base = input.baseCommit.trim();
  if (!head) return { ok: false, reason: "取不到 /testbed 的 HEAD（镜像里没有 git 仓库？）" };
  // 允许短 sha 与全长 sha 互比：只要一方是另一方的前缀即算同一提交
  const same =
    head === base ||
    (head.length !== base.length &&
      (head.startsWith(base) || base.startsWith(head)) &&
      Math.min(head.length, base.length) >= 7);
  if (!same) {
    return {
      ok: false,
      reason: `镜像内 HEAD=${head} ≠ base_commit=${base} —— 答案可能已经在镜像里`,
    };
  }
  if (input.treeDirty) {
    return {
      ok: false,
      reason:
        "HEAD 对得上但 /testbed 工作树不干净 —— 补丁可能已 apply 在工作树里（HEAD 查不出这种）",
    };
  }
  return { ok: true };
}

function check3NoFixCommit(args: PreflightArgs, runner: Runner, dockerUp: boolean): CheckResult {
  const base = {
    id: "3",
    name: "镜像内没有上游 fix commit（HEAD==base_commit 且工作树干净）",
  } as const;

  if (!args.baseCommit || !args.image) {
    return {
      ...base,
      status: "skip",
      reason:
        "缺 --base-commit / --image。base_commit 由第 2 步「从 dataset 现取」产出，" +
        "本 PR 只落 preflight，不含取数",
    };
  }
  if (!dockerUp) {
    return { ...base, status: "skip", reason: "docker daemon 不可达，进不了镜像查 git 状态" };
  }

  const inImage = (gitArgs: string[]) =>
    runner.run([
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      args.image!,
      "git",
      "-C",
      "/testbed",
      ...gitArgs,
    ]);

  const head = inImage(["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    return {
      ...base,
      status: "fail",
      reason: `镜像内 git rev-parse HEAD 失败: ${head.out.trim().slice(0, 200)}`,
    };
  }
  const status = inImage(["status", "--porcelain"]);
  const j = judgeNoFixCommit({
    headSha: head.out,
    baseCommit: args.baseCommit,
    treeDirty: status.out.trim().length > 0,
  });
  return {
    ...base,
    status: j.ok ? "pass" : "fail",
    reason: j.reason,
    detail: { image: args.image, head: head.out.trim(), base_commit: args.baseCommit },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 镜像可构建性 + 计时
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这一项的产出**主要是那个数字**，不是布尔值。
 *
 * D3 的已知风险原文：arm64 构建耗时官方无任何基准，从源码构建 conda testbed 镜像
 * 可能是小时量级；老版本包可能缺 arm64 wheel → 回落源码编译 → 更慢或失败。
 * 兜底是借一台 x86_64 linux 机器本地跑（**不上云**，守住数据主权）。
 * 所以耗时必须落进 detail.elapsed_ms，让「要不要走兜底」有数可依。
 */
/**
 * daemon 侧的 CPU / 内存容量。
 *
 * ⚠️ **必须问 daemon，不能问宿主机** —— 这是本次实测纠正的一处前提错误。
 * 方案里「磁盘够：实测 602GB 可用 vs 官方要求 120GB」量的是 **macOS 宿主盘**，
 * 而镜像全部落在 docker VM（colima）里：实测 VM 只有 97.9G 总量 / 83.1G 可用、
 * 8GB 内存 / 4 核，而官方 README 的 WARNING 要求 **≥120GB 磁盘 / 16GB RAM / 8 核**。
 * 宿主盘再大也不会自动变成 VM 的磁盘。所以这里报的是 daemon 自己的数，
 * 让「够不够」这个判断不再建立在量错了的卷上。
 *
 * 刻意**只报不判**（不做成第六项断言）：五项断言是 §4.1 定死的口径，
 * 而且 Linux 上 daemon 直接用宿主盘、容量本来就够，硬拦会在那类机器上误报。
 */
export function probeDaemonCapacity(runner: Runner): Record<string, unknown> {
  const info = runner.run(["docker", "info", "--format", "{{.NCPU}}|{{.MemTotal}}"]);
  if (info.code !== 0) return { capacity: "取不到（docker info 失败）" };
  const [ncpu, memBytes] = info.out.trim().split("|");
  const memGiB = Number(memBytes) / 1024 ** 3;
  return {
    daemon_cpus: ncpu,
    daemon_mem_gib: Number.isFinite(memGiB) ? memGiB.toFixed(1) : "?",
    // 官方 README WARNING 的口径，写在这里免得看数的人还要去翻文档
    official_min: "磁盘 ≥120GB / RAM 16GB / 8 核（且是 daemon 侧，不是宿主机）",
  };
}

function check4ImageBuildable(args: PreflightArgs, runner: Runner, dockerUp: boolean): CheckResult {
  const base = { id: "4", name: "镜像可构建性 + 计时（先只构建 1 个实例）" } as const;

  if (!args.buildInstance) {
    return {
      ...base,
      status: "skip",
      reason: "未给 --build-instance。这一项会真构建镜像（arm64 上可能是小时量级），故须显式开启",
      detail: dockerUp ? probeDaemonCapacity(runner) : undefined,
    };
  }
  if (!dockerUp) {
    return { ...base, status: "skip", reason: "docker daemon 不可达，构建无从发起" };
  }
  const capacity = probeDaemonCapacity(runner);
  const hasSwebench = runner.run(["swebench", "--help"]).code === 0;
  if (!hasSwebench) {
    return {
      ...base,
      status: "skip",
      reason: "未装 `swebench`（pip install -e . 后才有该命令）",
      detail: capacity,
    };
  }

  const t0 = runner.now();
  // ⚠️⚠️ 这里原先传的是 `--namespace ''`（方案文档 §5 与官方 README 都这么写），
  // **实测在 swebench 5.0.2 上该选项已不存在**：
  //
  //     Error: No such option: --namespace (Possible options: --instance)
  //
  // 5.0.2 的替代品是 `--task-repo`（"Build images from this task repo instead of
  // trusting the registry"），语义还更强 —— 它显式说明了不传的后果：
  // "Without it images are pulled, so a stale published image can mask a broken build."
  //
  // 但 `--task-repo` 需要一个**逐实例 Dockerfile 的外部仓库**，官方没给默认值，
  // 本仓也还没有那份 task repo。所以这里的做法是：
  //   - 不传任何构建相关选项（默认行为 = pull registry 镜像）；
  //   - 由调用方通过 --task-repo 传入（下方 taskRepo 参数），传了就带上。
  // 这样 preflight 测的是**当前实际可跑的那条路**，而不是一个已被删掉的选项。
  const cmd = [
    "swebench",
    "eval",
    "verified",
    "--gold",
    "-i",
    args.buildInstance,
    "--run-id",
    `preflight-build-${args.buildInstance}`,
    "-j",
    "1",
  ];
  if (args.taskRepo) cmd.push("--task-repo", args.taskRepo);
  const built = runner.run(cmd, { timeoutMs: 6 * 60 * 60 * 1000 });
  const elapsedMs = Math.round(runner.now() - t0);

  // ⚠️⚠️ **退出码不能当判据。** 实测 `swebench eval` 在整个实例报错时依然 **exit 0**，
  // 而摘要里写的是 `Instances resolved: 0` + `Instances with errors: 1`：
  //
  //     Error in evaluation for pytest-dev__pytest-7982: 404 ... no matching manifest
  //       for linux/arm64/v8 ...
  //     Instances resolved: 0
  //     Instances with errors: 1
  //
  // 只看退出码 → 判 pass；只看 resolved → 判「没解出」。两者都错：真相是
  // **镜像根本没跑起来**。这正是 §4.1 那条「`0 failed` 与 `errors: 1` 可同时成立」
  // 的坑，也是路径 A 那个 `Score(value=0)` 的同型 —— 仪器没接上，却给了个数字。
  const verdict = judgeBuildOutcome(built);
  return {
    ...base,
    status: verdict.ok ? "pass" : "fail",
    reason: verdict.ok
      ? undefined
      : `${verdict.reason}${
          verdict.reason?.includes("manifest")
            ? "。⚠️ 5.0.2 已删 --namespace，没有「本地重建」这条退路了；" +
              "要么给 --task-repo（逐实例 Dockerfile 仓库），要么按 D3 兜底" +
              "借一台 x86_64 linux 机器本地跑（**不上云**）"
            : ""
        }`,
    detail: {
      instance_id: args.buildInstance,
      elapsed_ms: elapsedMs,
      exit_code: built.code,
      ...capacity,
    },
  };
}

/**
 * 判定一次 `swebench eval` 到底成没成。
 *
 * 判据是**报告里的计数**，不是退出码（见调用处注释：报错时 exit 仍是 0）。
 * 三个信号都要看：
 *   - `Instances with errors: N>0` → 实例根本没跑起来（镜像/环境问题），fail
 *   - `Instances completed: 0`     → 一个都没完成，fail
 *   - 都不满足才算真跑通
 */
export function judgeBuildOutcome(built: { code: number; out: string }): {
  ok: boolean;
  reason?: string;
} {
  const out = built.out;
  const num = (label: string): number | undefined => {
    const m = out.match(new RegExp(`${label}:\\s*(\\d+)`));
    return m ? Number(m[1]) : undefined;
  };
  const errors = num("Instances with errors");
  const completed = num("Instances completed");

  // 连摘要都没打出来 → 命令层面就失败了（选项不存在、命令找不到等）
  if (errors === undefined && completed === undefined) {
    return {
      ok: false,
      reason: `swebench eval 没产出摘要（exit ${built.code}）：${out.trim().slice(-400)}`,
    };
  }
  if (errors !== undefined && errors > 0) {
    const detail = out.match(/Error in evaluation for [^\n]+/)?.[0] ?? "";
    return {
      ok: false,
      reason: `harness 报 ${errors} 个实例出错（注意此时进程 exit=${built.code}，退出码不可信）：${detail.slice(0, 300)}`,
    };
  }
  if (completed !== undefined && completed === 0) {
    return { ok: false, reason: `没有任何实例完成（completed=0，exit=${built.code}）` };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ sid-code 能起 + 要用的 flag 真的被接受
// ─────────────────────────────────────────────────────────────────────────────

/**
 * runner（§4.5）真正会用到的 flag。改 runner 命令行时**必须同步改这里**，
 * 否则 preflight 就在验一组过时的 flag。
 */
export const REQUIRED_FLAGS: string[][] = [
  ["-p"],
  ["--max-turns", "1"],
  ["--settings", "/tmp/sid-preflight-probe.json"],
  ["--permission-mode", "acceptEdits"],
];

/**
 * 已实测**不可用**的 flag，登记在此仅作提示，不参与判定。
 *
 * 前 4 个是路径 A 脚手架里凭空写的（`cli.ts` 里从来没有）；`--no-session-persistence`
 * 更阴：源码里声明了、`--help` 里列着、node 跑 parseArgs 也通过，
 * 只有跑编译产物才报「未知选项」（bun 的 parseArgs 在 allowNegative:true 下拒绝 `no-` 开头的声明名）。
 *
 * ⚠️ 刻意**不**断言它们「必须被拒绝」：哪天 `--no-session-persistence` 修好了，
 * 那种断言会变成红灯逼人改测试 —— 那就是本仓说的 false gate。
 */
export const KNOWN_UNUSABLE_FLAGS = [
  "--no-session-persistence",
  "--user-query",
  "--workdir",
  "--headless",
  "--trace-out",
];

/** 探针自证用的合成 flag：它必须被拒绝，否则探针本身是空转的。 */
export const PROBE_CANARY_FLAG = "--sid-preflight-canary-nonexistent";

export interface FlagProbeInput {
  /** `--version` 的结果 */
  version: { code: number; out: string };
  /** 每个必需 flag 组的探测结果 */
  required: Array<{ flag: string; code: number; out: string }>;
  /** 合成 flag 的探测结果（必须非 0） */
  canary: { code: number; out: string };
}

/**
 * ⑤ 的纯判定。
 *
 * canary 是这一项的**变异自证**：如果二进制对未知 flag 也返回 0（比如某次重构把
 * 未知选项改成静默忽略），那么「required 全 pass」就毫无信息量。此时必须 fail
 * 并说明是探针失效，而不是报一个漂亮的绿灯。
 */
export function assessFlagProbe(input: FlagProbeInput): { ok: boolean; reason?: string } {
  if (input.version.code !== 0) {
    return {
      ok: false,
      reason: `二进制起不来：--version exit ${input.version.code} / ${input.version.out.trim().slice(0, 200)}`,
    };
  }
  if (input.canary.code === 0) {
    return {
      ok: false,
      reason:
        `探针失效：合成 flag ${PROBE_CANARY_FLAG} 也被接受（exit 0），` +
        "说明这个二进制不拒绝未知选项 —— 此时「必需 flag 全通过」不含任何信息",
    };
  }
  const rejected = input.required.filter((r) => r.code !== 0);
  if (rejected.length > 0) {
    return {
      ok: false,
      reason:
        `runner 要用的 flag 被拒绝: ${rejected.map((r) => r.flag).join(", ")}。` +
        "注意判据是「真的被接受」而不是「源码里有 / --help 里列着」—— " +
        `${KNOWN_UNUSABLE_FLAGS[0]} 那三种常规核验全部误判它可用`,
    };
  }
  return { ok: true };
}

function check5FlagsAccepted(args: PreflightArgs, runner: Runner): CheckResult {
  const base = { id: "5", name: "sid-code 能起 + 要用的 flag 真的被接受" } as const;

  if (!existsSync(args.bin)) {
    return {
      ...base,
      status: "skip",
      reason: `找不到二进制 ${args.bin}（先跑 make build，或用 --bin 指定）`,
    };
  }

  // 探测手法：`--help <flag>` —— 走完整 parseArgs 后在 values.help 处退出。
  // 不进主循环、不落盘（实测 SID_CONFIG_DIR 下 0 个文件），所以可以安全地在
  // preflight 里对每个 flag 各跑一次。
  //
  // ⚠️ 注意 `--help` 单独一个参数时会命中 bootstrap 的零导入快速路径（不解析 flag），
  // 所以必须**带上被测 flag 一起传**，否则探的是快速路径而不是 parseArgs。
  const probe = (extra: string[]) => runner.run([args.bin, "--help", ...extra]);

  const result = assessFlagProbe({
    version: runner.run([args.bin, "--version"]),
    required: REQUIRED_FLAGS.map((f) => ({ flag: f.join(" "), ...probe(f) })),
    canary: probe([PROBE_CANARY_FLAG]),
  });

  const unusable = KNOWN_UNUSABLE_FLAGS.map((f) => ({ flag: f, code: probe([f]).code }));
  return {
    ...base,
    status: result.ok ? "pass" : "fail",
    reason: result.reason,
    detail: {
      bin: args.bin,
      required_flags: REQUIRED_FLAGS.map((f) => f.join(" ")),
      known_unusable: unusable.map(
        (u) => `${u.flag}${u.code === 0 ? " (⚠️ 竟被接受)" : " (已拒绝)"}`,
      ),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 产物身份：这个二进制是哪个 commit 编的
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⑥ 的纯判定。
 *
 * ## 它与 ⑤ 的分工（两条都要，不重复）
 *
 * ⑤ 问「这个二进制能起来吗、要用的 flag 真的被接受吗」——**能力**。
 * ⑥ 问「这个二进制是**哪份代码**编的」——**身份**。
 * 一个 8月21 编的产物在 ⑤ 上是满分（起得来、flag 全收），
 * 而它一行本轮修复都不含 —— 那正是本方案起因的那个事故。
 *
 * ## 为什么 fail 而不是 warn
 *
 * `stale` 意味着**跑的不是你以为的代码**，而分数会看起来完全正常。
 * 这与 preflight 里其它 fail 项同级：「带着它往下走，拿到的分数不可信」。
 *
 * ## 为什么 `no-identity` 是 skip 而不是 pass
 *
 * 读不到身份 = **没量到**，不是"量到了且没问题"。preflight 已经有 `skip`
 * → `INCOMPLETE` 这条现成的三档语义，正是为了不让「没检查」冒充「检查通过」。
 * 把它记成 pass 会造出一个绿灯，而绿灯背后是一次没做的检查。
 */
export function assessArtifactIdentityCheck(a: {
  verdict: string;
  identitySource: string;
  artifactCommit: string;
  hostHeadCommit: string | null;
  changedInputCommits: number;
}): { status: CheckStatus; reason?: string } {
  if (a.identitySource === "mtime-fallback") {
    return {
      status: "skip",
      reason:
        "产物不含构建身份（老产物，或构建时漏带 --define process.env.SID_CODE_BUILD_INFO）—— " +
        "「跑的是不是当前代码」这件事**没量到**。编一个带身份的包：bash scripts/build-branch-artifact.sh",
    };
  }
  switch (a.verdict) {
    case "ok":
      return { status: "pass" };
    case "stale":
      return {
        status: "fail",
        reason:
          `产物编自 ${a.artifactCommit.slice(0, 12)}，之后编译输入又改了 ` +
          `${a.changedInputCommits} 次 —— **跑它就是在跑改动之前的代码，而分数会看起来完全正常**`,
      };
    case "foreign":
      return {
        status: "fail",
        reason:
          `产物编自 ${a.artifactCommit.slice(0, 12)}，它不是当前 HEAD ` +
          `(${(a.hostHeadCommit ?? "?").slice(0, 12)}) 的祖先 —— 这是另一条线上的包`,
      };
    case "unknown-commit":
      return {
        status: "fail",
        reason: `产物自报 commit ${a.artifactCommit.slice(0, 12)} 不在本地对象库 —— 先 git fetch --all`,
      };
    case "sidecar-mismatch":
      return {
        status: "fail",
        reason:
          "旁路 build-info.json 与产物字节里的 commit 不一致 —— 字节才是事实源，那份 json 在骗人",
      };
    default:
      // 未知 verdict **不能当 pass**。判定表将来加了新档而这里忘了同步时，
      // 落到 pass 就是静默放行；落到 skip 至少会让总判定变成 INCOMPLETE。
      return { status: "skip", reason: `未知的门禁判定 ${a.verdict} —— 这一项没能判成` };
  }
}

function check6ArtifactIdentity(args: PreflightArgs, runner: Runner): CheckResult {
  const base = { id: "6", name: "产物身份：这个二进制是哪个 commit 编的" } as const;

  if (!existsSync(args.bin)) {
    return {
      ...base,
      status: "skip",
      reason: `找不到二进制 ${args.bin}（先 bash scripts/build-branch-artifact.sh，或用 --bin 指定）`,
    };
  }

  const { info } = sniffArtifactIdentity(args.bin, runner);
  const assessment = assessArtifact({
    artifactPath: args.bin,
    info,
    probe: makeGitProbe(REPO_ROOT, runner),
    artifactMtimeSec: artifactMtimeSec(args.bin),
    sidecar: verifySidecar(args.bin, info),
  });
  const judged = assessArtifactIdentityCheck({
    verdict: assessment.verdict,
    identitySource: assessment.identitySource,
    artifactCommit: assessment.info.commit,
    hostHeadCommit: assessment.hostHeadCommit,
    changedInputCommits: assessment.changedInputCommits.length,
  });

  return {
    ...base,
    status: judged.status,
    reason: judged.reason,
    detail: {
      artifact: args.bin,
      artifact_commit: assessment.info.commit,
      artifact_branch: assessment.info.branch,
      artifact_origin: assessment.info.origin,
      artifact_dirty: String(assessment.info.dirty),
      built_at: assessment.info.built_at,
      host_head: assessment.hostHeadCommit ?? "unknown",
      verdict: assessment.verdict,
      // 产物脏是 warning 不是 fail，但**必须出现在报告里** ——
      // 只在类型注释里写不够，读报告的人看不到注释。
      ...(assessment.warnings.length ? { warnings: assessment.warnings } : {}),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 编排
// ─────────────────────────────────────────────────────────────────────────────

/** docker daemon 是否可达。`docker` 存在但 daemon 没起是本机最常见的形态。 */
export function probeDockerUp(runner: Runner): boolean {
  return runner.run(["docker", "info", "--format", "{{.ServerVersion}}"]).code === 0;
}

export function runPreflight(args: PreflightArgs, runner: Runner): CheckResult[] {
  const dockerUp = probeDockerUp(runner);
  return [
    check1RunNetwork(args, runner, dockerUp),
    check2EgressSeparation(args, runner, dockerUp),
    check3NoFixCommit(args, runner, dockerUp),
    check4ImageBuildable(args, runner, dockerUp),
    check5FlagsAccepted(args, runner),
    check6ArtifactIdentity(args, runner),
  ];
}

const ICON: Record<CheckStatus, string> = { pass: "✅", fail: "❌", skip: "⏭️ " };

export function renderReport(results: CheckResult[]): string {
  const { verdict } = classifyVerdict(results);
  const lines: string[] = ["SWE-bench 阶段 A preflight（失败即停）", ""];
  for (const r of results) {
    lines.push(`  ${ICON[r.status]} ${r.id}. ${r.name}`);
    if (r.reason) lines.push(`       └─ ${r.reason}`);
    if (r.detail) {
      for (const [k, v] of Object.entries(r.detail)) {
        lines.push(`          ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
      }
    }
  }
  lines.push("");
  lines.push(`判定: ${verdict}`);
  if (verdict === "INCOMPLETE") {
    lines.push(
      "⚠️ INCOMPLETE 不是通过：有断言因前置缺失没跑成。带着它往下走，" +
        "拿到的分数不可信（「没检查」冒充「检查通过」= 假 0% 的同型）。",
    );
  }
  if (verdict === "FAIL") {
    lines.push("⛔ 失败即停：先修上面标 ❌ 的项，不要继续第 2 步。");
  }
  return lines.join("\n");
}

/** 生产用的 Runner：Bun.spawnSync + performance.now。 */
export function makeRunner(): Runner {
  return {
    run(cmd, opts) {
      try {
        const p = Bun.spawnSync({
          cmd,
          stdout: "pipe",
          stderr: "pipe",
          timeout: opts?.timeoutMs,
        });
        const out = `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`;
        return { code: p.exitCode ?? 1, out };
      } catch (err) {
        // 命令不存在等情形一律当非 0，绝不吞成 0 —— 吞了就是把「没跑」变成「通过」
        return { code: 127, out: String(err) };
      }
    },
    now: () => performance.now(),
  };
}

export function main(argv: string[], runner: Runner = makeRunner()): number {
  const args = parseArgs(argv.slice(2));
  const results = runPreflight(args, runner);
  const { verdict, exitCode } = classifyVerdict(results);
  if (args.json) {
    console.log(JSON.stringify({ verdict, exit_code: exitCode, checks: results }, null, 2));
  } else {
    console.log(renderReport(results));
  }
  return exitCode;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}
