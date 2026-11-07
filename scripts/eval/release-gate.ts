#!/usr/bin/env bun
/**
 * L2 发版闸编排器（方案 P3 / T20）。入口用 `scripts/eval/release-gate.sh <version>`，
 * 它负责套 `caffeinate -dimsu`；直接跑本文件会因「未经 caffeinate 包住」判 INVALID。
 *
 *   bun run scripts/eval/release-gate.ts <version> [--ruler <traj-bench checkout>]
 *       [--baseline <基线文档>] [--base <发布根 URL>] [--force] [--dry-run]
 *
 * ## 顺序（先 $0 后真钱，§5.4-3）
 *
 * 1. 下载 linux-arm64 tarball，sha256 对 `.sha256` 与 versions.json；G2 判据核产物身份
 * 2. caffeinate 包住了吗 / docker 可用内存 / 预算账本 / 尺子桥 preflight（尺子自己的闸）
 * 3. oracle / nop 预检（$0，不调模型）
 * 4. traj-bench 全量（两档），实付成本记进账本
 * 5. 运行区间内 `pmset -g log` 有没有 Sleep；容器内二进制是不是下载的那份
 * 6. `eval-verdict.py` 出裁决 → `~/.sid-code/eval-gate/<version>.verdict.json`
 *
 * 1–2 任一红 ⇒ **不跑 3、4**（零模型调用），直接把红项作为 `--block` 交判定器，结论 INVALID。
 * 3 红同理不跑 4。**结论只由判定器给**：本文件不自己写 PASS/WARN/REGRESSION。
 * 唯一例外是判定器本身崩溃（退出码 1）—— 那时落一份 INVALID，不能让 promote 读空。
 *
 * 退出码与判定器一致：0 放行（PASS/WARN）/ 2 REGRESSION / 3 INVALID；1 = 用法错误。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sidHomePath } from "../../packages/core/src/config/paths.ts";
import {
  judgeReleaseUpload,
  makeCmdRunner,
  sniffArtifactIdentity,
} from "../lib/artifact-identity.ts";
import { checkBudget, effectiveRunCost, isoWithLocalOffset, recordRun } from "./lib/eval-budget.ts";
import {
  DEFAULT_RELEASE_BASE,
  L2_PLANNED_CAP_USD,
  UNDER_TEST_PLATFORM,
  artifactUrls,
  isValidVersion,
  judgeArtifactSha,
  judgeBinaryIdentities,
  judgeDockerMemory,
  manifestSha,
  parseBridgeOutput,
  parseShaSidecar,
  shouldSkipExisting,
  sleepEventsInWindow,
  type BridgeResult,
  type PmsetEvent,
} from "./lib/release-gate.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const HARBOR_DIR = join(REPO_ROOT, "evals/external-benchmarks/harbor");
const BRIDGE = join(HARBOR_DIR, "l2-ruler.py");
const VERDICT_PY = join(HARBOR_DIR, "eval-verdict.py");
const DEFAULT_BASELINE = join(HARBOR_DIR, "baselines/traj-bench-v0.2.1.json");
/** 尺子桥要 `import harbor`（尺子闸 2），只能用 harbor 自己 uv 环境的 python。 */
const DEFAULT_HARBOR_PY = join(homedir(), ".local/share/uv/tools/harbor/bin/python");

const EXIT_USAGE = 1;
const EXIT_INVALID = 3;

function log(msg: string): void {
  console.error(msg);
}

function sh(
  cmd: string[],
  opts: { env?: Record<string, string | undefined>; inheritStderr?: boolean } = {},
): { code: number; out: string; err: string } {
  try {
    const p = Bun.spawnSync({
      cmd,
      stdout: "pipe",
      stderr: opts.inheritStderr ? "inherit" : "pipe",
      stdin: "ignore",
      env: opts.env ?? process.env,
    });
    return {
      code: p.exitCode ?? 1,
      out: p.stdout?.toString() ?? "",
      err: p.stderr?.toString() ?? "",
    };
  } catch (err) {
    // 命令不存在一律当失败，绝不吞成 0
    return { code: 127, out: "", err: String(err) };
  }
}

function sha256File(path: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

function fetchTo(url: string, dest: string): string | null {
  const r = sh(["curl", "-fsSL", "--retry", "2", "-o", dest, url]);
  return r.code === 0
    ? null
    : `下载失败 ${url}（curl 退出 ${r.code}：${r.err.trim().slice(0, 200)}）`;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 单实例锁：L2 同一时刻只能跑一份（两份并发会互相抢 docker 内存，还会重复花钱）。 */
function acquireLock(path: string): string | null {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return null;
  } catch {
    const pid = Number(readFileSync(path, "utf8").trim());
    let alive = false;
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) return `另一份 L2 正在跑（pid ${pid}，锁 ${path}）`;
    // 持锁进程已经不在了（崩溃 / 被杀）：接管
    writeFileSync(path, String(process.pid));
    return null;
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function bridge(py: string, sub: string, args: string[], label: string): BridgeResult {
  const r = sh([py, BRIDGE, sub, ...args], { inheritStderr: true });
  return parseBridgeOutput(r.out, r.code, label);
}

function usage(): never {
  log(
    "用法: release-gate.sh <version> [--ruler <traj-bench checkout>] [--baseline <file>] " +
      "[--base <发布根 URL>] [--force] [--dry-run]",
  );
  process.exit(EXIT_USAGE);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ruler: { type: "string" },
      baseline: { type: "string" },
      base: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) usage();
  const version = positionals[0]!;
  if (!isValidVersion(version)) {
    log(`版本号 ${JSON.stringify(version)} 不合法（它会被拼进 URL 与路径）`);
    return EXIT_USAGE;
  }
  const dryRun = values["dry-run"] === true;
  const base = values.base ?? process.env.SID_L2_RELEASE_BASE ?? DEFAULT_RELEASE_BASE;
  const rulerArg = values.ruler ?? process.env.SID_L2_RULER ?? "";
  const harborPy = process.env.SID_L2_HARBOR_PYTHON ?? DEFAULT_HARBOR_PY;
  const baselinePath = resolve(values.baseline ?? DEFAULT_BASELINE);

  const gateHome = sidHomePath("eval-gate");
  const verdictPath = join(gateHome, `${version}.verdict.json`);
  if (
    !values.force &&
    !dryRun &&
    existsSync(verdictPath) &&
    shouldSkipExisting(readJsonFile(verdictPath))
  ) {
    log(`v${version} 已有终局裁决（${verdictPath}），不重跑；要重跑加 --force`);
    return 0;
  }

  const lockPath = join(gateHome, "release-gate.lock");
  const lockErr = acquireLock(lockPath);
  if (lockErr) {
    // 不写裁决：那份正在跑的会写。这里写一份 INVALID 会把它的结论盖掉。
    log(`⛔ ${lockErr}`);
    return EXIT_INVALID;
  }

  const startedAt = new Date();
  const stamp = isoWithLocalOffset(startedAt).replace(/[:.]/g, "-");
  const outDir = join(gateHome, "runs", version, stamp);
  mkdirSync(outDir, { recursive: true });
  const blocks: string[] = [];
  const notes: string[] = [];
  const gate: Record<string, unknown> = {
    version,
    platform: UNDER_TEST_PLATFORM,
    only_platform_note: `裁决只覆盖 ${UNDER_TEST_PLATFORM}，其余平台未经 L2`,
    out_dir: outDir,
    started_at: isoWithLocalOffset(startedAt),
  };

  try {
    // ── 0. 基线与尺子 commit ──
    const baseline = readJsonFile(baselinePath) as {
      fingerprints?: { declared?: Record<string, string> }[];
    } | null;
    const expectCommit = baseline?.fingerprints?.[0]?.declared?.traj_bench_commit ?? "";
    gate.baseline = baselinePath;
    gate.baseline_sha256 = existsSync(baselinePath) ? sha256File(baselinePath) : null;
    if (!baseline) blocks.push(`读不了基线文档 ${baselinePath}`);
    else if (!/^[0-9a-f]{40}$/.test(expectCommit))
      blocks.push("基线文档没有声明 traj_bench_commit —— 不知道该用哪份尺子");
    const ruler = rulerArg ? resolve(rulerArg.replace(/^~(?=\/)/, homedir())) : "";
    gate.ruler = ruler || null;
    if (!ruler)
      blocks.push("没给尺子 checkout（--ruler 或 SID_L2_RULER，需钉在基线的 traj_bench_commit）");

    // ── 1. 产物：下载 + sha256 + G2 身份 ──
    const urls = artifactUrls(base, version);
    gate.tarball_url = urls.tarball;
    const dl = join(outDir, "artifact");
    mkdirSync(dl, { recursive: true });
    const tarball = join(dl, urls.tarballName);
    let binary: string | null = null;
    let binarySha: string | null = null;
    const dlErr = fetchTo(urls.tarball, tarball);
    if (dlErr) {
      blocks.push(dlErr);
    } else {
      const actual = sha256File(tarball);
      gate.tarball_sha256 = actual;
      const sideFile = `${tarball}.sha256`;
      const sidecar = fetchTo(urls.sha256, sideFile)
        ? null
        : parseShaSidecar(readFileSync(sideFile, "utf8"), urls.tarballName);
      const manFile = join(dl, "versions.json");
      const manifest = fetchTo(urls.manifest, manFile)
        ? null
        : manifestSha(readJsonFile(manFile), version);
      const s = judgeArtifactSha({ actual, sidecar, manifest });
      blocks.push(...s.red);
      notes.push(...s.notes);

      const { info } = sniffArtifactIdentity(tarball, makeCmdRunner());
      const tag = sh(["git", "-C", REPO_ROOT, "rev-parse", "--verify", "--quiet", `v${version}^`]);
      const expected =
        tag.code === 0 && /^[0-9a-f]{40}$/.test(tag.out.trim()) ? tag.out.trim() : null;
      const g2 = judgeReleaseUpload({
        info,
        expectedCommit: expected,
        artifactName: urls.tarballName,
      });
      gate.artifact_identity = {
        commit: info.commit,
        origin: info.origin,
        dirty: info.dirty,
        dirty_files: info.dirty_files ?? null,
      };
      if (!g2.ok) blocks.push(...g2.reasons.map((r) => `G2：${r}`));
      else notes.push(...g2.reasons);

      const x = join(dl, "x");
      mkdirSync(x, { recursive: true });
      // 包内布局 sid-code/sid-code（release.sh 打包时的 staging）
      const tx = sh(["tar", "-xzf", tarball, "-C", x]);
      const cand = join(x, "sid-code", "sid-code");
      if (tx.code !== 0 || !existsSync(cand)) {
        blocks.push(`解不出 sid-code/sid-code（tar 退出 ${tx.code}）`);
      } else {
        binary = cand;
        binarySha = sha256File(cand);
        gate.binary_sha256 = binarySha;
      }
    }

    // ── 2. 环境闸 ──
    gate.caffeinated = process.env.SID_L2_CAFFEINATED === "1";
    if (!gate.caffeinated)
      blocks.push("未经 caffeinate 包住（请用 scripts/eval/release-gate.sh 入口）");

    const mem = judgeDockerMemory({
      memTotalText: sh(["docker", "info", "--format", "{{.MemTotal}}"]).out,
      statsText: sh(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}"]).out,
    });
    gate.docker_available_bytes = mem.availableBytes;
    blocks.push(...mem.red);

    const budget = checkBudget({ layer: "L2", plannedCapUsd: L2_PLANNED_CAP_USD });
    gate.budget = {
      allowed: budget.allowed,
      code: budget.code,
      reason: budget.reason,
      spent_usd: budget.spent_usd,
    };
    if (!budget.allowed) blocks.push(`预算账本：${budget.reason}`);

    const rulerArgs = ["--ruler", ruler, "--expect-commit", expectCommit, "--out", outDir];
    let declared: Record<string, string> = {};
    if (ruler && expectCommit && binary) {
      const pf = bridge(
        harborPy,
        "preflight",
        [...rulerArgs, "--binary", binary],
        "尺子 preflight",
      );
      blocks.push(...pf.red);
      declared = (pf.declared as Record<string, string>) ?? {};
    } else if (ruler && expectCommit) {
      notes.push("没有可用二进制，跳过尺子 preflight");
    }

    if (dryRun) {
      gate.dry_run = true;
      log(
        blocks.length
          ? `\n⛔ dry-run：${blocks.length} 条红项`
          : "\n✅ dry-run：跑前闸全绿（未跑预检与全量）",
      );
      for (const b of blocks) log(`  - ${b}`);
      for (const n of notes) log(`  · ${n}`);
      writeAtomic(
        join(outDir, "dry-run.json"),
        JSON.stringify({ ...gate, blocks, notes }, null, 2) + "\n",
      );
      return blocks.length ? EXIT_INVALID : 0;
    }

    // ── 3. oracle / nop 预检（$0）──
    if (blocks.length === 0) {
      for (const agent of ["oracle", "nop"]) {
        const pc = bridge(harborPy, "precheck", [...rulerArgs, "--agent", agent], `${agent} 预检`);
        blocks.push(...pc.red);
        if (!pc.ok) break;
      }
    } else {
      notes.push("跑前闸已红：没有跑 oracle/nop 预检与全量（零模型调用）");
    }

    // ── 4. 全量 ──
    let runDirs: string[] = [];
    if (blocks.length === 0 && binary && binarySha) {
      const runStart = Date.now();
      const rr = bridge(harborPy, "run", [...rulerArgs, "--binary", binary], "全量");
      const runEnd = Date.now();
      blocks.push(...rr.red);
      runDirs = Array.isArray(rr.run_dirs) ? rr.run_dirs.map(String) : [];
      if (rr.declared && typeof rr.declared === "object")
        declared = rr.declared as Record<string, string>;

      // 记账：只要全量开跑过就记，哪怕中途红了（花出去的钱已经花了）
      const costs = Array.isArray(rr.costs) ? (rr.costs as (number | null)[]) : [];
      const cost = effectiveRunCost(costs);
      gate.run_cost = cost;
      recordRun({
        layer: "L2",
        plannedCapUsd: L2_PLANNED_CAP_USD,
        actualUsd: cost.totalUsd,
        version,
        nullCostTasks: cost.nullCostTasks,
        note: `release-gate ${outDir}`,
      });

      if (Array.isArray(rr.binary_identities)) {
        blocks.push(...judgeBinaryIdentities(rr.binary_identities as unknown[][], binarySha));
      }

      // ── 5. 睡眠 ──
      const pm = sh(["pmset", "-g", "log"]);
      let sleeps: PmsetEvent[] = [];
      if (pm.code !== 0) {
        blocks.push(`读不了 pmset -g log（退出 ${pm.code}）—— 无法证明运行期间没睡`);
      } else {
        sleeps = sleepEventsInWindow(pm.out, runStart - 1000, runEnd + 1000);
        if (sleeps.length) {
          blocks.push(
            `运行区间内宿主睡眠 ${sleeps.length} 次（首次 ${sleeps[0]!.at} ${sleeps[0]!.event}）—— 耗时与超时判定被污染`,
          );
        }
      }
      gate.sleep_events = sleeps;
    }

    // ── 6. 裁决 ──
    const rawVerdict = join(outDir, "eval-verdict.json");
    const vArgs = ["python3", VERDICT_PY, "--baseline", baselinePath, "--out", rawVerdict];
    for (const d of runDirs.length ? runDirs : [outDir]) vArgs.push("--current", d);
    for (const [k, v] of Object.entries(declared)) if (v) vArgs.push("--declare", `${k}=${v}`);
    for (const b of blocks) vArgs.push("--block", b);
    const vr = sh(vArgs, { inheritStderr: true });
    log(vr.out);
    let doc = readJsonFile(rawVerdict) as Record<string, unknown> | null;
    if (vr.code === 1 || !doc || typeof doc.verdict !== "string") {
      doc = {
        verdict: "INVALID",
        invalid_reasons: [
          ...blocks,
          `判定器异常（退出 ${vr.code}）：${vr.err.trim().slice(0, 300)}`,
        ],
      };
    }
    gate.finished_at = isoWithLocalOffset(new Date());
    gate.blocks = blocks;
    gate.notes = notes;
    const envelope = { ...doc, release_gate: gate };
    writeAtomic(verdictPath, JSON.stringify(envelope, null, 2) + "\n");
    log(`\n裁决 ${String(doc.verdict)} → ${verdictPath}`);
    return { PASS: 0, WARN: 0, REGRESSION: 2 }[String(doc.verdict)] ?? EXIT_INVALID;
  } finally {
    rmSync(lockPath, { force: true });
    // 解包的二进制与 tarball 体积大（~100MB），裁决里已记 sha，删掉
    if (!process.env.SID_L2_KEEP_ARTIFACT)
      rmSync(join(outDir, "artifact"), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
