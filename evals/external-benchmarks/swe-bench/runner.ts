#!/usr/bin/env bun
/**
 * SWE-bench Verified 阶段 A —— runner（§6.3 第 2、5、6 步）
 *
 * 事实源：`evals/external-benchmarks/swe-bench/接入计划.md` §4.2 / §4.3 / §4.5
 * 决策留痕：`.agents/notes/implemented/testing/2026-08-24-swe-bench-阶段a-runner与二值判分.md`
 *
 * ## 职责边界（这三条决定了本文件里没有什么）
 *
 * 1. **不判分**。判分一律交官方 `swebench eval`（§4.6「不自己判」）。
 *    本文件的产出是 predictions jsonl，判分由 `grade.ts` 调官方 harness 完成。
 * 2. **不解析 agent 的自然语言输出**。patch 只来自工作树 diff（§4.5）——
 *    模型说「我改好了」不算证据，`git diff` 才算。
 * 3. **不碰 `evals/_scores/`、不写 case yaml 的 baseline_scores**（§3 数据隔离）。
 *
 * ## 用法
 *
 *   # 跑全部 10 条（读 verified-subset.yaml 的 instances）
 *   bun run evals/external-benchmarks/swe-bench/runner.ts --run-id smoke-1
 *
 *   # 只跑一条（阶段 A 受阻时的回滚形态：缩到 1 条把链路走通，§7）
 *   ... --run-id smoke-1 --instance pytest-dev__pytest-7982
 *
 *   --max-turns N   agent 步数封顶（默认 40）
 *   --arch amd64|arm64  镜像架构；决定 docker cp 哪个产物（默认按 daemon 实测）
 *   --bin PATH      linux 产物 tar.gz（默认从 dist/release 按 arch 选）
 *   --timeout SEC   单实例容器级超时（默认 1800）
 *   --dry-run       只打印将要执行的动作，不起容器
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SWE_DIR = import.meta.dir;
const SUBSET_PATH = join(SWE_DIR, "verified-subset.yaml");
const PROMPT_PATH = join(SWE_DIR, "prompt-v1.txt");

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §4.6 的六类结果（抄 Reasonix §5.1 第 5 点的分类）。
 *
 * ⚠️ `ungraded` **必须单独成类**，不能折叠进 `no_patch` 或算 0 ——
 * 那正是被否决的路径 A「scorer 恒返 0」的同型陷阱换了个位置：
 * 「harness 没读回 report.json，却把结果当 0 处理」得到的是一样的假 0%。
 * 本文件只产出 `solved` 之外的**过程类**（no_patch / agent_error / eval_timeout）；
 * `solved` / `wrong_patch` / `ungraded` 由 `grade.ts` 读官方 report 后判定。
 */
export type Outcome =
  | "solved"
  | "no_patch"
  | "agent_error"
  | "eval_timeout"
  | "wrong_patch"
  | "ungraded"
  | "grader_error";

export interface SubsetInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  version: string;
  difficulty: string;
}

/** 单实例的运行结果。**刻意没有百分比字段**（§6：没有那个字段就没人能画曲线）。 */
export interface RunRecord {
  instance_id: string;
  /** 非空 patch 才算 link_ok 的分子 */
  patch_bytes: number;
  /** §4.5 那道硬检查：diff 是否触及测试文件 */
  patch_touches_tests: boolean;
  /** 触及的测试文件路径（便于人工复核，不参与判分） */
  test_files_touched: string[];
  /** harness 自己的时钟，不是 agent 自报（§6.3 诚实字段） */
  wall_ms: number;
  /** agent 退出码；非 0 → agent_error */
  agent_exit: number;
  /** 过程类结论。solved / wrong_patch / ungraded 不在这里判 —— 那是官方 harness 的事 */
  outcome: Extract<Outcome, "no_patch" | "agent_error" | "eval_timeout"> | "patch_produced";
  /** D4：无中立计价源，固定 null */
  meter: null;
  meter_note: string;
  prompt_version: string;
  /** 未归因的部分（§6.3 诚实字段）。有值就说明这条的账没算平 */
  unaccounted?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────────────────────────────────────

export interface RunnerArgs {
  runId: string;
  instances: string[];
  maxTurns: number;
  arch?: "amd64" | "arm64";
  bin?: string;
  timeoutSec: number;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    runId: "",
    instances: [],
    maxTurns: 40,
    timeoutSec: 1800,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-id") args.runId = argv[++i] ?? "";
    else if (a === "--instance") args.instances.push(argv[++i] ?? "");
    else if (a === "--max-turns") args.maxTurns = Number(argv[++i]);
    else if (a === "--arch") args.arch = argv[++i] as "amd64" | "arm64";
    else if (a === "--bin") args.bin = argv[++i];
    else if (a === "--timeout") args.timeoutSec = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// subset 读取
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 极简 YAML 读取：只认 `verified-subset.yaml` 这一种形状（`instances:` 下的对象列表）。
 *
 * ⚠️ 刻意不引 YAML 库：本仓 `yaml-loader` 是给 case yaml 用的、带 bucket 语义，
 * 而这里要的是「读 5 个标量字段」。更重要的是——**这个文件是脚本生成的**，
 * 形状由 `select-subset.py` 的 `render_yaml` 定死，不会出现任意 YAML 结构。
 * 引一个通用解析器反而会让「形状变了但还能解析出半个结果」成为可能。
 *
 * 只读 `instances:` 段，**不读 `candidate_pool:`** —— 候选池是替补，
 * 要用必须显式 `--instance`，不能被默认全量跑捎带进去（那会让 n 从 10 变 15）。
 */
export function parseSubset(yaml: string): SubsetInstance[] {
  const out: SubsetInstance[] = [];
  let inInstances = false;
  let cur: Partial<SubsetInstance> | null = null;
  const flush = () => {
    if (cur?.instance_id && cur.base_commit) out.push(cur as SubsetInstance);
    cur = null;
  };
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^instances:\s*$/.test(line)) {
      inInstances = true;
      continue;
    }
    // 任何新的顶格 key（如 candidate_pool:）都终止 instances 段
    if (inInstances && /^[a-zA-Z_]+:/.test(line)) {
      flush();
      inInstances = false;
      continue;
    }
    if (!inInstances) continue;
    const item = line.match(/^\s*-\s+instance_id:\s*"?([^"\n]+?)"?\s*$/);
    if (item) {
      flush();
      cur = { instance_id: item[1] };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s+([a-z_]+):\s*"?([^"\n]*?)"?\s*$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === "repo") cur.repo = v;
    else if (k === "base_commit") cur.base_commit = v;
    else if (k === "version") cur.version = v;
    else if (k === "difficulty") cur.difficulty = v;
  }
  flush();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// prompt 契约（§4.3）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按 §4.3 三条组装题面。
 *
 * 1. 只给 `problem_statement` 原文 —— 不加「这是 SWE-bench 题」之类元信息，
 *    不给 FAIL_TO_PASS / PASS_TO_PASS / patch；
 * 2. 禁改测试文件的约束**加在题面之后**（D17），且对照实验两侧逐字相同；
 * 3. 文本入库带版本号（`prompt-v1.txt`），报告里引用版本号。
 *
 * ⚠️ **模板必须从文件读，不能在这里拼字符串**。写死在代码里的话，
 * 改 prompt 就成了改代码的副作用，而「prompt 变了分数就不可比」这条约束
 * 依赖的正是那个可 diff、可引用版本号的文件。
 */
export function buildPrompt(template: string, problemStatement: string): string {
  if (!template.includes("{problem_statement}")) {
    throw new Error("prompt-v1.txt 缺少 {problem_statement} 占位符 —— 题面无从注入");
  }
  return template.replace("{problem_statement}", problemStatement);
}

// ─────────────────────────────────────────────────────────────────────────────
// patch 提取 + 硬检查（§4.5 第 6 步）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判定一个路径是不是测试文件。
 *
 * §4.3 第 2 条是**软约束**（prompt 里的禁令），agent 物理上仍能改测试文件，
 * 所以必须有这道机械检查。判据故意放宽（宁可多报）：
 * 少报一次 = 一个改了测试的 patch 被静默计入「解出」，那分数就不可信了。
 *
 * ⚠️ 命中不等于作废该条，而是 `patch_touches_tests` 标记 + **单独列出**（§4.5）。
 * 静默计入解出与静默判失败都是错的 —— 前者虚高，后者会把无辜的改动扣掉。
 */
export function isTestPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const base = p.split("/").pop() ?? "";
  return (
    /(^|\/)(tests?|testing)(\/|$)/.test(p) ||
    /^test_/.test(base) ||
    /_test\.[a-z]+$/.test(base) ||
    /^conftest\.py$/.test(base)
  );
}

/**
 * 从 `git diff --cached --numstat -z` 的输出里取出被改文件与是否二进制。
 *
 * `-z` 的记录格式：`add TAB del TAB path NUL`，二进制文件的 add/del 是 `-`。
 * ⚠️ 用 `-z` 是必须的：路径含空格/中文时非 `-z` 输出会被 quote 成 `"a\tb"`，
 * 按 TAB 切会切错。renames 用 `--no-renames` 关掉（否则一条记录里有两个路径）。
 */
export function parseNumstatZ(out: string): { path: string; binary: boolean }[] {
  const files: { path: string; binary: boolean }[] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const parts = rec.split("\t");
    if (parts.length < 3) continue;
    const [add, , ...rest] = parts;
    const path = rest.join("\t");
    if (!path) continue;
    files.push({ path, binary: add === "-" });
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// 容器内脚本
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 容器内跑的那段 shell。
 *
 * 四条实测约束（§4.5），每条少一个就起不来或跑歪：
 *
 * 1. **必须激活 conda testbed**（`source /opt/miniconda3/bin/activate && conda activate testbed`）
 *    —— 不激活 import 全挂，agent 会把「环境没激活」当成代码 bug 去修。
 * 2. **必须写 settings.json**（`config.ts:1499` 的门禁：`--print` 下
 *    `!config.model && availableModels.length === 0` 直接抛）。光 cp 二进制起不来。
 * 3. **不带 `--no-session-persistence`** —— 编译产物里报「未知选项」（bun parseArgs
 *    不收 `no-` 前缀声明名）。会话隔离靠 `SID_CONFIG_DIR`。
 * 4. **HOME 必须可写** —— `SID_CONFIG_DIR` 不覆盖 `debug.log`（PR2 已修 logger，
 *    但 `ensure-ripgrep.ts` 在只读 HOME 下会静默降级到系统 rg）。
 *
 * ⚠️ **API key 只走 exec env，绝不进 argv**（§6.2）：进 argv 后
 * `docker inspect` / `ps` 都能读到，容器删了还留在 daemon 的记录里。
 * 这段脚本里出现的是 `$SC_API_KEY` 这个**变量名**，值由 docker exec -e 注入。
 */
export function containerScript(promptPath: string, maxTurns: number): string {
  return [
    "set -e",
    // ① conda testbed —— 不激活 import 全挂
    "source /opt/miniconda3/bin/activate",
    "conda activate testbed",
    "cd /testbed",
    // ② settings.json —— 不写起不来。key 从 env 取，不落在 argv 里
    "export SID_CONFIG_DIR=/tmp/sid-cfg",
    'mkdir -p "$SID_CONFIG_DIR"',
    // 用 python 生成 JSON：shell 里插值 key 会在出错时把它打进日志
    'python -c \'import json,os,sys; json.dump({"availableModels":[{"name":"m","provider":"openai","api_key":os.environ["SC_API_KEY"],"base_url":os.environ["SC_BASE_URL"]}],"model":"m"}, open(os.environ["SID_CONFIG_DIR"]+"/settings.json","w"))\'',
    // ③ 跑 agent。`--` 之后是题面，题面以 `-` 开头也不会被当选项
    `/usr/local/bin/sid-code -p --max-turns ${maxTurns} --permission-mode acceptEdits -- "$(cat ${promptPath})"`,
  ].join("\n");
}

/**
 * 提取 patch 的那段 shell。**与 agent 那段分开跑**，理由是 agent 段可能非 0 退出
 * （超时、崩溃），而那种情况下工作树里可能**已经有部分改动** ——
 * 合成一段的话 `set -e` 会让提取整个跳过，一个本该记为 `patch_produced` 的
 * 结果会被记成 `no_patch`。**「agent 失败」与「没有 patch」是两件事。**
 */
export function extractScript(): string {
  return [
    "cd /testbed",
    // 不提交，只 stage —— 官方判分要的是相对 base_commit 的 diff
    "git add -A >/dev/null 2>&1 || true",
    "echo '===NUMSTAT==='",
    "git --literal-pathspecs diff --cached --no-renames --numstat -z",
    "echo ''",
    "echo '===DIFF==='",
    "git --literal-pathspecs diff --cached --no-renames --binary=false 2>/dev/null || git --literal-pathspecs diff --cached --no-renames",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行器（注入以便单测不依赖 docker）
// ─────────────────────────────────────────────────────────────────────────────

export interface Exec {
  run(
    cmd: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string>; stdin?: string },
  ): {
    code: number;
    out: string;
  };
  now(): number;
}

export function realExec(): Exec {
  return {
    run(cmd, opts) {
      const p = Bun.spawnSync(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: opts?.stdin ? new TextEncoder().encode(opts.stdin) : undefined,
        env: { ...process.env, ...(opts?.env ?? {}) },
        timeout: opts?.timeoutMs,
      });
      return {
        code: p.exitCode ?? -1,
        out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
      };
    },
    now: () => performance.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果组装
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由「agent 退出码 + 提取到的 diff」推出过程类结论。
 *
 * ⚠️ 这里**只**判过程类三种 + `patch_produced`，绝不判 `solved`。
 * 判 solved 需要跑测试，那是官方 harness 的事（§4.6「不自己判」）。
 * 这个边界是硬的：一旦本文件出现「看起来像判分」的分支，
 * 下一个人就会去改它，而不是去改 harness 的调用。
 */
export function deriveOutcome(input: {
  agentExit: number;
  patchBytes: number;
  timedOut: boolean;
}): RunRecord["outcome"] {
  if (input.timedOut && input.patchBytes === 0) return "eval_timeout";
  if (input.patchBytes > 0) return "patch_produced";
  if (input.agentExit !== 0) return "agent_error";
  return "no_patch";
}

/** 从提取脚本的输出里切出 numstat 段与 diff 段。 */
export function splitExtractOutput(out: string): { numstat: string; diff: string } {
  const nIdx = out.indexOf("===NUMSTAT===");
  const dIdx = out.indexOf("===DIFF===");
  if (nIdx < 0 || dIdx < 0 || dIdx < nIdx) return { numstat: "", diff: "" };
  return {
    numstat: out.slice(nIdx + "===NUMSTAT===".length, dIdx),
    diff: out.slice(dIdx + "===DIFF===".length).replace(/^\n/, ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

/** predictions jsonl 的一行 —— 官方 `docs/guides/evaluation.md` 定死的三字段。 */
export interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export const MODEL_NAME = "sid-code";

/**
 * 按 daemon 实际架构选产物。
 *
 * ⚠️ **不能硬编码任何一侧**：D3 的兜底是「借一台 x86_64 linux 机器」，
 * 那条路上镜像是 amd64、要 cp `linux-x64`；本机 arm64 重建镜像则要 `linux-arm64`。
 * 硬编码等于把兜底路径写死成不可用。
 */
export function pickArtifact(arch: "amd64" | "arm64", version: string): string {
  const suffix = arch === "amd64" ? "linux-x64" : "linux-arm64";
  return `dist/release/${version}/sid-code-${version}-${suffix}.tar.gz`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runId) {
    console.error("必须给 --run-id。⚠️ 官方 harness 对同一 run_id 会复用缓存（§4.6），");
    console.error("换了 patch 不换 run_id 会读回上一次的结论 —— 那是个假结果，不是重跑。");
    process.exit(2);
  }

  const subset = parseSubset(readFileSync(SUBSET_PATH, "utf8"));
  const wanted = args.instances.length
    ? subset.filter((s) => args.instances.includes(s.instance_id))
    : subset;
  if (args.instances.length && wanted.length !== args.instances.length) {
    const missing = args.instances.filter((i) => !wanted.some((w) => w.instance_id === i));
    console.error(`❌ 这些 instance_id 不在 subset 的 instances 段里：${missing.join(", ")}`);
    console.error("（候选池里的条目要用时也得先进 instances 段 —— 见 parseSubset 注释）");
    process.exit(2);
  }

  // 现在就读一次 prompt 模板并校验占位符 —— **要在起任何容器之前失败**。
  // 模板坏了却等到第 7 条实例才发现，前 6 条的题面就已经错了（而且不会报错）。
  buildPrompt(readFileSync(PROMPT_PATH, "utf8"), "");

  const outDir = join(SWE_DIR, "runs", args.runId);
  mkdirSync(outDir, { recursive: true });
  const predPath = join(outDir, "predictions.jsonl");
  const recPath = join(outDir, "records.jsonl");
  writeFileSync(predPath, "");
  writeFileSync(recPath, "");

  console.log(`run_id=${args.runId}  实例数=${wanted.length}  max-turns=${args.maxTurns}`);
  console.log(`prompt=${PROMPT_PATH.replace(REPO_ROOT + "/", "")}`);
  console.log(`产物目录=${outDir.replace(REPO_ROOT + "/", "")}`);
  if (args.dryRun) {
    for (const s of wanted) console.log(`  [dry-run] ${s.instance_id}  base=${s.base_commit}`);
    return;
  }
  console.error("⚠️ 真跑需要 exec-swebench.sh（容器编排在 shell 侧，见同目录）。");
  console.error("本 TS 侧当前只负责：subset 解析、prompt 组装、patch 判定与产物落盘。");
  process.exit(3);
}

if (import.meta.main) await main();
