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
  /**
   * patch 里**只有新建文件**、一行既有源码都没改。
   *
   * 观测字段，**不参与任何判定**（判分仍归官方 harness）。存在的理由见
   * `patchOnlyAddsFiles`：这个形态在 `patch_bytes` / `outcome` 上完全看不出来，
   * 而它与「做出了修复」是两件事。
   */
  patch_only_adds_files: boolean;
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
 *
 * ## ⚠️ 但**实际拿到的输入里 NUL 已经没了**（2026-08-25 实测）
 *
 * 提取那一步在 shell 里是 `extract_out="$(docker exec ... )"` ——
 * **bash 命令替换会丢弃 NUL 字节**（POSIX 行为，还会打 warning 但被 2>&1 吞了）。
 * 所以本函数收到的是多条记录**首尾相接、没有分隔符**的一坨：
 *
 *     "5\t0\tsrc/foo.py3\t1\ttests/test_foo.py2\t0\tsrc/bar.py"
 *
 * 按 `\0` 切只得到 **1 条**记录，`path` 是把后面所有记录粘在一起的怪串。
 * 危害不是「少报几个文件名」：`isTestPath` 对那个怪串**匹配不上**，于是
 * **`patch_touches_tests` 恒为 false —— 那道防作弊硬检查被静默架空**
 * （实测：NUL 完好时判 true 的同一份输入，NUL 丢失后判 false）。
 *
 * 修法是**不再依赖 NUL 分隔**，改用「`add TAB del TAB` 前缀」本身做记录边界：
 * 那个前缀的形态（两个数字或 `-`，各跟一个 TAB）足以定位下一条记录的起点。
 * NUL 若还在也照样能切（下面先按 NUL 拆一层）—— 两种输入都对，
 * 因为**不能假设上游哪天不会把 NUL 修回来**。
 *
 * ⛔ 不要「改成不带 `-z`」来绕开：那会把带空格/中文的路径 quote 掉（本函数注释
 * 第一段就是为此存在的），等于用一个新错换掉旧错。
 */
export function parseNumstatZ(out: string): { path: string; binary: boolean }[] {
  const files: { path: string; binary: boolean }[] = [];
  // ① 先按记录分隔符拆：NUL（原生 `-z`）或 RS `\x1e`（提取脚本转译后的，见那边注释）。
  //    NUL 被 shell 吃掉时这一层只会得到一段，交给 ② 兜住。
  for (const chunk of out.split(/[\0\x1e]/)) {
    if (!chunk.trim()) continue;
    files.push(...splitGluedNumstat(chunk));
  }
  return files;
}

/**
 * 把一段（可能是多条粘连的）numstat 切开。
 *
 * 判据是记录头的形态 `<add>TAB<del>TAB`，其中 add/del 是数字或 `-`（二进制）。
 * 路径里可以有空格、TAB、中文，但**不会**出现这个形态的字段头 ——
 * 所以拿它当边界是可靠的。只有一条记录时这就退化成一次匹配。
 */
function splitGluedNumstat(chunk: string): { path: string; binary: boolean }[] {
  const heads = [...chunk.matchAll(/(\d+|-)\t(?:\d+|-)\t/g)];
  const out: { path: string; binary: boolean }[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const from = h.index + h[0].length;
    // 路径一直延伸到下一条记录头的起点（最后一条到末尾）
    const to = i + 1 < heads.length ? heads[i + 1].index : chunk.length;
    const path = chunk.slice(from, to).replace(/\n+$/, "");
    if (path) out.push({ path, binary: h[1] === "-" });
  }
  return out;
}

/**
 * 从 diff 文本里取出**新建**文件的路径（`new file mode` 那种）。
 *
 * numstat 分不出「新建」与「改了已有文件」—— 两者都是 add/del 计数。
 * 而这个区分是下面 `patchOnlyAddsFiles` 的判据基础，所以只能从 diff 正文取。
 */
export function newFilePaths(diff: string): string[] {
  const paths: string[] = [];
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[i]);
    if (!m) continue;
    // `new file mode` 紧跟在 `diff --git` 之后（可能隔着 old/new mode 行），
    // 但一定在下一个 `diff --git` 之前。
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("diff --git "); j++) {
      if (lines[j].startsWith("new file mode ")) {
        paths.push(m[2]);
        break;
      }
    }
  }
  return paths;
}

/**
 * 「这份 patch **只新建了文件**，一行既有源码都没改」。
 *
 * ## 为什么需要这个信号（实测，2026-08-25 smoke-2）
 *
 * `django-15128` 与 `matplotlib-20488` 两条的 patch 里**只有 agent 自己建的
 * 复现脚本**（`repro/*.py`、`repro_test.py`），一行源码都没动 ——
 * agent 卡在「复现问题」这一步，没走到修复。
 *
 * 但这件事**在现有字段里完全看不出来**：`patch_bytes=3412` 看着很像正经修复，
 * `outcome=patch_produced` 也是正常值。要发现它只能人去读 diff。
 *
 * ## 它**不改变**任何判定，只是把事实标出来
 *
 * ⛔ 刻意**不**在提取时把这些文件滤掉（ZZZ.5 第 3 条已裁决否决「提取时排除」）：
 * 滤掉之后那两条会变成干净的 `no_patch`，而 `no_patch` 读起来像
 * 「没想出办法」—— 和「想了、试了、**卡在复现阶段**」是两件不同的事。
 * 提取时替 agent 打扫会掩盖它的行为特征，那是在伪造一个更好看的过程。
 *
 * ⛔ 也**不**据此判失败：新建文件里可能就有正经修复
 * （比如题目要求新增一个模块）。所以判据是「只新建、且新建的全部不是源码修改」，
 * 结论只进 `unaccounted` 供人复核。
 *
 * ⚠️ 同样**不改 prompt-v1**：`prompt-v1` 是入库写死不再改的契约（D17 第 3 条），
 * 改它意味着起 `prompt-v2` 并**重跑一轮基线**（之前所有分数不可比）。
 * 先用这个字段量出「这个形态到底多常见」，再决定值不值得付那个代价。
 */
export function patchOnlyAddsFiles(diff: string, allPaths: string[]): boolean {
  if (allPaths.length === 0) return false;
  const created = new Set(newFilePaths(diff));
  // 每一个被改的文件都是新建的 → 没有任何既有文件被修改
  return allPaths.every((p) => created.has(p));
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
/**
 * 把提取到的 diff 归一化成**可被 GNU patch 接受**的形态：末尾恰好一个换行。
 *
 * ## 为什么必须有这一步（实测，2026-08-25 的 10 题跑分抓到）
 *
 * 原来 `record.ts` 写的是 `diff.trimEnd()`，把末尾换行一起剥了。
 * 容器里的 **GNU patch 2.7.6** 因此拒收整个补丁：
 *
 *     patch unexpectedly ends in middle of line
 *     patch: **** malformed patch at line 34        (exit=2)
 *
 * 只在末尾补一个 `\n`，同一份 patch 就 `exit=0`。差别是一个字节。
 *
 * ⚠️ **这个 bug 在 macOS 上测不出来**：宿主自带 BSD patch，它容忍缺尾换行
 * （实测两个版本都 exit=0）。判分发生在容器里，所以「本地跑通」在这件事上
 * 没有说服力 —— 这也是为什么单测里要显式断言「末尾必须是 \n」，
 * 而不是靠跑一遍 patch 命令。
 *
 * ⚠️ 危害不止「几条题挂了」：一份**正确的修复**末尾没换行也会被整份拒收，
 * 于是记成 grader_error / wrong_patch —— 又是「工具链故障伪装成能力差」。
 *
 * 空 diff 保持空字符串：给空串补换行会让 `patchBytes` 从 0 变 1，
 * `deriveOutcome` 就会把一个 no_patch 误判成「有 patch」。
 *
 * ## ⛔ 只许动换行，**绝不许动最后一行的内容**（2026-08-25 第二次修，教训在此）
 *
 * 第一版写的是 `diff.trimEnd()` 再补一个 `\n`。它**同时**做了两件事，
 * 而第二件是错的：`trimEnd()` 剥的是「全部尾部空白」，
 * 于是把 diff 末尾那些**内容只有一个空格的行**也一起吃掉了 ——
 * 而在 unified diff 里，`" "` 开头的行是**合法的上下文行**，
 * 一个仅含单空格的行就是「上下文里的空行」。
 *
 * 吃掉它之后 hunk body 比 `@@ -a,b +c,d @@` 声明的行数**少**，patch 自相矛盾：
 *
 *     error: corrupt patch at line 12        (git apply, exit=128)
 *
 * 三格变异自证（同一份 astropy-12907 的 patch，同一个官方镜像容器内）：
 *
 * | 版本 | `git apply` |
 * | --- | --- |
 * | `trimEnd()`（第一版） | exit=128 `corrupt patch at line 12` |
 * | `trimEnd()` + 补 `\n`（第一版的"修复"） | exit=128 `corrupt patch at line 13` ← **没修好** |
 * | 只规范换行、保留末尾上下文行（现在） | **exit=0** `Applied patch ... cleanly` |
 *
 * ⚠️ **为什么第一版看起来是修好了**：官方 harness 的打补丁链路是四级回落
 * （`git apply` → `--3way` → `--reject` → `patch --batch --forward --fuzz=5`）。
 * 前三级全挂之后，最后那级 GNU patch 会**带 fuzz 模糊匹配**把行数不对的 hunk
 * 硬塞进去（日志里是 `Hunk #1 succeeded at 242 with fuzz 2`）。
 * 实测 smoke-2 那 6 条 solved **全部**是这么进去的 —— 它们并不是"恰好没踩到"，
 * 而是**踩到了但被最后一级兜住**。所以「解出来了」推不出「patch 是好的」，
 * 判据必须看日志里 `git apply` 那一级是否 exit=0，不能只看 resolved_ids。
 *
 * ⚠️ 同样别指望 mac 上能测出来：这条与缺尾换行那条一样只在容器里的
 * GNU patch / 严格 `git apply` 下暴露。单测因此断言的是**字节形态不变量**
 * （「除末尾换行外与输入逐字相同」），不是去跑 patch 命令。
 */
export function normalizePatch(diff: string): string {
  // 「没有任何实质内容」必须归零，否则 `patchBytes` 会从 0 变成正数，
  // `deriveOutcome` 把 no_patch 误判成 patch_produced —— 又一次「无结果伪装成有结果」。
  // ⚠️ 判据用 `trim()` 只是**判空**，不参与产出（产出仍逐字保留原内容）：
  // 一份只有空白的 diff 不可能是有效补丁，但一份有效补丁的**末尾**完全可以是空白行。
  if (diff.trim().length === 0) return "";
  // ⛔ 只塌陷末尾的**换行符本身**，不碰任何其他字符 ——
  // 尤其不能用 trimEnd()/正则 `\s*$`：`\s` 含空格与 \t，
  // 会吃掉合法的上下文行（`" "` 开头）与行内缩进。
  return `${diff.replace(/\n+$/, "")}\n`;
}

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
