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
  /**
   * agent.log 里出现 `达到最大轮次限制` —— 即**轮次预算用尽**，不是想不出来。
   * 观测字段，不参与判定（同 `patch_only_adds_files`）。详见 `extractAgentLogSignals`。
   */
  hit_max_turns: boolean;
  /**
   * LLM 致命错误打断（`fatal_error` + 限流/5xx 指纹）—— 这条题**连跑完的机会都没拿到**。
   * 观测字段，不参与判定。
   */
  llm_fatal: boolean;
  /**
   * headless 下被权限层拒绝的工具调用次数。
   *
   * 每一次都等于**烧掉一轮而什么也没做成**，且在 outcome / wall_ms / patch_bytes 上
   * 完全看不出来。实测 smoke-8（`--permission-mode acceptEdits`）共 113 次，
   * 三条实例过半轮次是这么没的，却被记成"40 轮预算用尽"。
   * > 这个字段的用处是**验证权限配置是否把 agent 打残** ——
   * > 正常配置下它该接近 0，显著大于 0 就说明这一轮的分数掺了非能力因素。
   */
  permission_denials: number;
  /**
   * 编辑落点分解：改的是**被测源码**（`/testbed` 下）还是**自己的复现脚本**（`/tmp` 等）。
   *
   * 实测踩到（2026-08-26 smoke-10，A7.11.4）：`django-13964` 有 2 次 edit、
   * `files_edited_count=1`，看起来像"终于开始改代码了"，
   * 实际**两次都打在 `/tmp/repro/test_bug.py`**，一次没碰 `django/`。
   *
   * ## 为什么必须单独记：这个形态在所有既有字段上都是隐身的
   *
   *   `patch_bytes=0`         与「完全没动手」一模一样
   *   `patch_only_adds_files` false（它连新建文件都没进 patch）
   *   numstat/diff 不一致那条 不触发（`/tmp` 不在 `git add -A` 范围里）
   *
   * 而 `unaccounted` 只会说「轮次预算用尽」，把人引向「抬 max_turns」；
   * 真实根因是**它把预算花在验证上、没留下动手的轮次**。两者处置完全不同。
   *
   * ⚠️ **判据教训（A7.11.8 P1 的落点）**：「edit 调用数 > 0」是个**不够的判据**，
   * 它把「改复现脚本」与「改被测源码」算成一件事。要看的是
   * `patch_bytes > 0`（结果）或 `edits_inside_repo > 0`（过程）。
   *
   * ⚠️ 观测字段，**不参与判定**（同 `patch_only_adds_files` / `hit_max_turns`）。
   */
  edits_inside_repo: number;
  edits_outside_repo: number;
  /** 仓库外被编辑的路径（去重排序）—— 有值时说明 agent 在改自己的脚本 */
  edit_paths_outside_repo: string[];
  /**
   * harness 自己的时钟，不是 agent 自报（§6.3 诚实字段）。
   * 口径 = `docker run` 前 → 收尾 `docker rm` 后，即 setup + agent + extract 之和。
   */
  wall_ms: number;
  /**
   * 三段耗时分解 —— **`wall_ms` 一个数回答不了「慢在哪」**。
   *
   * smoke-8 报了 94.2 分钟，而其中多少是搬运、多少是模型在想，
   * 在 `wall_ms` 上一个字看不出来（它把起容器 + cp 40MB 产物 + 取回轨迹
   * 全算进了"这道题花的时间"）。
   *
   *   setup_ms    docker run + tar 解压 + cp 产物/题面（基础设施，与模型无关）
   *   agent_ms    docker exec 跑 sid-code（真正的能力 + 延迟账）
   *   extract_ms  git add/diff 提取 patch + 取回轨迹与遥测（收尾搬运）
   *
   * ⚠️ 旧 run 没有这三个字段，读到 0 表示**没量**，不是"零耗时"。
   * grade.ts 据此跳过分解，**不做假汇总** —— 用 `wall_ms` 顶替 `agent_ms`
   * 会凭空造出一份"全是 agent 时间"的分解，比没有分解更坏。
   *
   * 不变量：`setup_ms + agent_ms + extract_ms === wall_ms`（有单测守着）。
   * 它防的是"挪动某个 now_ms 调用点，于是某一段耗时掉在所有字段之外"——
   * 这个坑本来就踩过一次（record.ts 落盘原先在取回轨迹**之前**）。
   */
  setup_ms?: number;
  agent_ms?: number;
  extract_ms?: number;
  /**
   * `agent_ms` 区间内宿主休眠了多少毫秒（macOS/Linux 都测）。
   *
   * 实测踩到（2026-08-26 smoke-10）：`django-13964` 的 `agent_ms=2009007`（33.5min）
   * **超过 SWE_TIMEOUT=1800 而 timed_out=false**，看起来像超时闸门坏了；
   * 真凶是宿主中途睡了 717 秒。`alarm()` 按可运行时间计而 `now_ms()` 取墙钟，
   * 于是同一段休眠**同时污染 agent_ms 并静默给超时闸门续命**
   * （一题可以跑到墙钟 2× 上限还不被杀，而 timed_out=false 把人引向"agent 慢"）。
   *
   * ⚠️ **`null` 与 `0` 语义不同，读的时候别合并**：
   *   null = 没量到（旧 run，或宿主取不到时钟）→ 该 run 耗时可信度未知
   *   0    = 量到了、确实没睡 → 耗时干净可外比
   * 这与上面三段那条「0 表示没量」**正好相反** —— 因为 0 在这里是有效值。
   *
   * 不进 `setup+agent+extract===wall` 那条不变量：它是 `agent_ms` 的**成分说明**，
   * 不是第四段。从 `agent_ms` 里减掉它会破掉那条不变量，且"墙钟耗时"本身也是要看的数。
   */
  host_slept_ms?: number | null;
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
// agent.log 机械信号（ZZZZ.11 P2：把 no_patch 桶里的非能力原因标出来）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 agent.log 里提取「这条实例为什么没跑完」的机械信号。
 *
 * ## 为什么需要它
 *
 * `deriveOutcome` 只看 `agentExit` / `patchBytes` / `timedOut`，于是 `no_patch`
 * 这一个桶同时装着三种完全不同的东西：
 *
 * | 真实原因 | 现在归到 | 是不是能力问题 |
 * | --- | --- | --- |
 * | 想不出来 | `no_patch` | ✅ 是 |
 * | 轮次预算用尽 | `no_patch` | ❌ 不是（我们的配置没定） |
 * | LLM 致命错误（限流/5xx 打断） | `agent_error` | ❌ 不是（网关或我们的 bug） |
 *
 * smoke-8 实测：4 条零 patch **一条都不是能力不足**（2 条 429 未重试即终止、
 * 2 条 40 轮撞顶），而报告里读起来像"5/10 的能力"。§6.3 阶段 A 的收口判据
 * 「零 patch 的实例里没有基础设施/harness 侧原因」要能被**机械验证**而不是
 * 每次人去 grep 四份 agent.log，就必须把这两个信号落进 RunRecord。
 *
 * ## ⚠️ 只标注，不参与任何判定
 *
 * 与 `patch_only_adds_files` 同款做法（见那里的两条否决理由）。
 * `deriveOutcome` 一行不改 —— 一旦让它读这些信号，`outcome` 就从
 * 「机械可复算的四态」变成「依赖日志文案的启发式」，而日志文案会变。
 *
 * ## ⚠️ 判据是中文日志文案，这是刻意的取舍
 *
 * 用 `达到最大轮次限制` 而不是解析结构化字段，因为 agent.log 就是终端输出，
 * 没有结构化通道。**代价是文案一改这个字段就静默失效** —— 所以
 * `tests/eval/swe-bench-runner.test.ts` 里钉了真实日志片段做样本，
 * 且报告侧在「零 patch 但两个信号都 false」时会显式说"原因未归因"，
 * 而不是默认它就是能力问题。轨迹取回（本次一并接上）是这层的长期替代：
 * 轨迹里有结构化的 `exit_status` / `RetryTelemetry`，不必猜文案。
 */
export function extractAgentLogSignals(agentLog: string): {
  hitMaxTurns: boolean;
  llmFatal: boolean;
  permissionDenials: number;
  editsInsideRepo: number;
  editsOutsideRepo: number;
  editPathsOutsideRepo: string[];
} {
  // 轮次撞顶：queryLoop 在放弃前会打这一行（`达到最大轮次限制: 40`）。
  const hitMaxTurns = agentLog.includes("达到最大轮次限制");

  // LLM 致命错误：`fatal_error` 是 queryLoop 的封装标记，单独出现还不够 ——
  // 它也可能是别的成因，所以要求同时出现"限流/服务端错误"的指纹。
  //
  // ⛔ 不要用 `/429|502|503|504/` 直接扫全文：实测会把 request-id 与
  // token 计数里的数字全扫进来（smoke-8 里 10 条实例 grep 到的 "429" 大多是
  // `cacheCreationInputTokens: 12429` 这类巧合）。必须锚定在错误行的形态上。
  const hasFatal = agentLog.includes("fatal_error");
  const hasUpstreamError =
    /(?:AUDIT:API|LLM:[A-Z]+)[^\n]*\b(?:429|500|502|503|504|529)\b/.test(agentLog) ||
    /rate_limit|rate limit|overloaded|Bad Gateway|上游负载|限流/.test(agentLog);
  const llmFatal = hasFatal && hasUpstreamError;

  // 权限拒绝次数：headless 下每一次都等于**烧掉一轮**而 agent 什么也没做成。
  // 实测 smoke-8 共 113 次，三条实例过半轮次是这么没的 —— 而这在
  // `outcome` / `wall_ms` / `patch_bytes` 上一个字都看不出来。
  const permissionDenials = (agentLog.match(/权限拒绝/g) ?? []).length;

  // ## 编辑落点：区分「改被测源码」与「改自己的复现脚本」
  //
  // 实测踩到（2026-08-26 smoke-10，A7.11.4）：`django-13964` 编辑了 2 次
  // （`files_edited_count=1`），看起来像"它终于开始改代码了"，
  // 查 `messages.json` 的入参才发现**两次都打在 `/tmp/repro/test_bug.py`**，
  // 一次没碰 `django/` 下的源码。
  //
  // 这个形态在所有既有字段上都看不出来：
  //   `patch_bytes=0`            —— 与"完全没动手"一模一样
  //   `patch_only_adds_files`    —— false（它连新建文件都没进 patch）
  //   numstat/diff 不一致那条    —— 也不触发（`/tmp` 不在 `git add -A` 范围里）
  // 而 unaccounted 只会说"轮次预算用尽"，把人引向"抬 max_turns"，
  // 实际根因是**它把预算花在验证上、没留下动手的轮次**。两者处置完全不同。
  //
  // ## 判据定死：`/testbed` 前缀（官方镜像的仓库路径）
  //
  // 取 `▶ edit {"file_path":"..."}` 这个**结构化入参**而不是 `[PERMISSION] edit(...)`
  // 那行：入参是 JSON、路径完整；PERMISSION 行是给人看的、会截断。
  // 实测 10/10 题：唯一「有编辑但全在仓库外」的正是 `django-13964`，
  // 也正是唯一 `patch_bytes=0` 的那条 —— 人工查轨迹的结论被机械复现。
  //
  // ⚠️ **同样只标注、不参与判定**（与 `hitMaxTurns` / `patchOnlyAddsFiles` 同款）。
  // `deriveOutcome` 一行不改：一旦让它读这个，`outcome` 就从机械四态变成
  // 依赖日志文案的启发式，而文案会变。
  //
  // ⚠️ 判据依赖 `/testbed` 这个硬编码前缀。换镜像布局（SWE-bench Pro 等）要重新核，
  // 否则会**全部落在"仓库外"**而报告显示每题都在改复现脚本 —— 一个安静的假信号。
  // 门禁在 tests/eval/swe-bench-runner.test.ts（钉了真实日志片段）。
  const editPaths = [
    ...agentLog.matchAll(/▶ (?:edit|write|notebook_edit) \{"file_path":"([^"]+)"/g),
  ].map((m) => m[1]!);
  const editsInsideRepo = editPaths.filter((p) => p.startsWith("/testbed")).length;
  const outsidePaths = editPaths.filter((p) => !p.startsWith("/testbed"));

  return {
    hitMaxTurns,
    llmFatal,
    permissionDenials,
    editsInsideRepo,
    editsOutsideRepo: outsidePaths.length,
    // 去重排序：同一个复现脚本被改 5 次，读报告的人要看的是"哪个文件"，不是 5 个重复项
    editPathsOutsideRepo: [...new Set(outsidePaths)].sort(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 容器内脚本 —— **不在本文件**，见 exec-swebench.sh 的 build_agent_script
// ─────────────────────────────────────────────────────────────────────────────
//
// ## 这里曾有一份 `containerScript()`，2026-08-25 删掉了
//
// 它**零引用、零测试**（全仓 grep 只有它自己的定义），是 shell 那份的平行实现，
// 而两份已经漂移到了危险的程度：它硬编码 `--permission-mode acceptEdits`
// （实测会让 agent 在 headless 下被拒 113 次工具调用）、写的还是
// `"name":"m"` 那版无效模型名（网关会拿默认模型顶上 → **跑的是哪个模型不可知**，
// 这个坑 exec-swebench.sh 的注释里已记录并修过）。
//
// 留着它的危害不是"多了几行死代码"，是**下一个人可能改对了它而没改 shell**，
// 或者读它当成事实来源。删掉比同步更安全 —— 唯一的容器脚本就在 shell 里，
// 且那里的注释才是被真实执行、真实踩过坑的那份。
//
// 它 docblock 里那四条实测约束（conda testbed / settings.json 门禁 /
// 不带 --no-session-persistence / HOME 必须可写）**没有丢**，
// 都在 `exec-swebench.sh` 的 `build_agent_script` 与文件头注释里。

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
