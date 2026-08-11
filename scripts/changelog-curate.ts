/**
 * scripts/changelog-curate.ts — 生成面向**用户**的更新日志文案（dogfood sid-code）
 *
 * 用法：
 *   bun run changelog:curate                   # 为「下一个版本」生成（区间 = 最新 tag..HEAD）
 *   bun run changelog:curate 0.1.601           # 指定版本（补跑 / backfill 单个历史版本）
 *   bun run changelog:curate --backfill-all    # 全量 backfill（19 个历史版本，串行）
 *   bun run changelog:curate --backfill-missing # 只跑还没有 curated 文件的版本（可中断续跑）
 *   bun run changelog:curate --check           # 不调 LLM，只校验已入库的全部 curated 文件
 *   bun run changelog:curate 0.1.582 --stub    # 不调 LLM，写一个人工占位（genesis 特例用）
 *
 * ── 为什么这是**独立命令**而不是 release.sh 的一步 ──
 *   四个理由，缺一个这个设计就不成立：
 *
 *   1. **发布路径必须确定性 + 离线。** generate-changelog.ts 的文件头把「git 是唯一
 *      事实源 / 确定性 / 幂等」写成了契约。把一次 LLM 调用塞进发布链会同时破掉这三条：
 *      同样的输入两次跑出不同文案、网络抖动能卡住发布。
 *   2. **人必须能过目。** LLM 会漏、会夸大、会把内部改动写成用户特性。写成文件 + 入库，
 *      人就有一个自然的 review 点（`git diff`），也能直接改字。
 *   3. **release.sh 有 EXIT 回滚 trap**，它只回滚「运行前本就 clean」的产物。curated 文件
 *      在发布前就已 commit，属于**已入库的输入**而非产物，天然在 trap 的作用域之外。
 *   4. 构建流程不该留下需要反复人工清理的副作用。curate 单独跑一次、产物入库，
 *      之后每次发布都是纯读，`git status` 不会因发布而变脏。
 *
 * ── ⚠ 关键：让 agent 自己落盘，**不解析 stdout** ──
 *   本脚本的职责是：spawn agent → 等它结束 → **读磁盘上的文件并校验**。
 *   三条实测确认的理由（别改成解析 stdout）：
 *
 *   · `--json-schema` **不构成 stdout 契约**：它在 packages/cli/src/app.ts 只做两件事 ——
 *     注册一个 StructuredOutputTool 实例、给系统提示词追加 suffix。**CLI 路径从不回读
 *     捕获结果**（getCapturedOutput 的消费方只有 sub-agent.ts 与 sub-agent-runner.ts，
 *     app.ts 那个局部变量注册完就丢了）。它是「提示词层面的鼓励 + 校验重试」。
 *   · `--output-format json` 的 `content` 是 `ContentBlock[]` 而非字符串，要拿 JSON
 *     得自己从 block 数组里挖，而最后一条 assistant 消息很可能是「我已经写好了文件」
 *     这种散文。
 *   · **stderr 恒有噪音**：app.ts 无条件往 stderr 写一个 60 个短横线边框的「会话摘要」块。
 *
 *   额外好处：agent 中途被 SIGTERM 杀掉时，磁盘上要么没文件、要么是个不完整的 JSON，
 *   两种情况校验都会拦住 —— 不会出现「解析了半截 stdout 拿到看似合理的结果」这种最坏情形。
 *
 * ── review 疲劳是这个方案最大的风险（社会性的，不是技术性的）──
 *   按 2026-07 的节奏（一个月 16 版），「每次发版跑一次 curate」意味着每月约 15 次
 *   人工 review。几周之后 review 极可能变成橡皮图章，那时「人在环」这个核心保障就空了 ——
 *   而它空掉的时候**没有任何信号**。两条缓解措施已内建在这里：
 *     · `userFacing: false` 的快速通道：纯内部版本的 review 成本近零。
 *     · 写完文件后**把条目打印到终端**，让 review 在命令行就能完成大半，不必去开文件。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOT,
  listSemverTags,
  versionRange,
  collectRawCommits,
  GENESIS_LOOKBACK,
} from "./lib/changelog-git.ts";
import {
  validateCurated,
  checkCoverage,
  SECTION_TITLES,
  MAX_ITEM_LEN,
  MAX_HIGHLIGHT_LEN,
  COVERAGE_WARN_THRESHOLD,
  type CuratedEntry,
} from "./lib/changelog-curated-schema.ts";

const CURATED_DIR = resolve(ROOT, "changelog/curated");
const PROMPT_PATH = resolve(ROOT, "scripts/changelog-curate.prompt.md");

/** 单个版本的 agent 超时。跑 git show 读几十个 diff 是真的慢，给足时间。 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** agent 的最大轮数：要逐条 git show，40 轮是实测下来够用的量级 */
const MAX_TURNS = 40;

export function curatedPath(version: string): string {
  return resolve(CURATED_DIR, `v${version}.json`);
}

/**
 * 提示词里插的那份完整示例。
 *
 * ⚠ 内容刻意**不取自本仓库的真实历史**，用的是一个虚构的 `/foo` 命令与虚构配置项。
 * 实测踩过：第一版示例的 highlight 写的是 v0.1.600 真实发生过的那件事
 * （首字节超时与心跳解耦），结果 agent 为 v0.1.600 生成的 highlight 与示例**逐字相同** ——
 * 无从判断它是真的读懂了 diff，还是直接抄了示例。示例只该示范**形状**，
 * 一旦它的内容与真实历史重叠，就同时成了一个答案泄漏。
 */
const SCHEMA_EXAMPLE = JSON.stringify(
  {
    version: "9.9.9",
    highlight: "新增 /foo 命令，一句话说清本版最值得说的事",
    userFacing: true,
    sections: [
      {
        title: "破坏性变更",
        items: ["fooMode 默认改为关闭，需要的话在 settings.json 里显式打开"],
      },
      {
        title: "新功能",
        items: ["/foo 支持 -p 持久化，设置下次启动仍然生效"],
      },
      {
        title: "修复",
        items: ["修复 bar 在网络较慢时被误判为失败、进而反复重试的问题"],
      },
    ],
    commits: ["1111aaa", "2222bbb"],
    discarded: ["3333ccc"],
    generatedBy: "sid-code",
    reviewedBy: "pending",
  },
  null,
  2,
);

/**
 * 读提示词模板，并**剥掉开头那段 HTML 注释**。
 *
 * 那段注释是写给维护者的（占位符清单、为什么独立成文件），不是写给 agent 的。
 * 不剥的后果实测确认过：注释里的 `{{VERSION}}` `{{COMMIT_LIST}}` 等占位符**同样会被
 * 替换**，于是整份提交清单、schema 示例在提示词里出现了两遍 —— 一遍在注释里当"占位符
 * 说明"，一遍在正文里。既浪费 token，又给 agent 一份自相矛盾的上下文
 * （注释里那份看起来像是在说"这些是占位符名字"，实际已被替换成真实数据）。
 */
function loadPromptTemplate(): string {
  const raw = readFileSync(PROMPT_PATH, "utf-8");
  const end = raw.indexOf("-->");
  if (raw.trimStart().startsWith("<!--") && end >= 0) {
    return raw.slice(end + 3).trimStart();
  }
  return raw;
}

function buildPrompt(version: string, range: string, commits: Array<{ hash: string; subject: string }>): string {
  const tpl = loadPromptTemplate();
  const commitList = commits.map((c) => `${c.hash}  ${c.subject}`).join("\n");
  return tpl
    .replace(/\{\{VERSION\}\}/g, version)
    .replace(/\{\{RANGE\}\}/g, range)
    .replace(/\{\{COMMIT_LIST\}\}/g, commitList)
    .replace(/\{\{OUTPUT_PATH\}\}/g, curatedPath(version))
    .replace(/\{\{SECTION_TITLES\}\}/g, SECTION_TITLES.join(" / "))
    .replace(/\{\{MAX_ITEM_LEN\}\}/g, String(MAX_ITEM_LEN))
    .replace(/\{\{MAX_HIGHLIGHT_LEN\}\}/g, String(MAX_HIGHLIGHT_LEN))
    .replace(/\{\{SCHEMA_EXAMPLE\}\}/g, SCHEMA_EXAMPLE);
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * spawn sid-code 无头模式。形态照抄 scripts/eval/run-eval-baseline.ts
 * （仓库里唯一一处 dogfood sid-code 的先例）。四个已验证的约束：
 *
 * 1. **走 `bun run packages/cli/src/entrypoints/bootstrap.ts`，不用 `./sid-code` 二进制。**
 *    二进制可能是旧的（有人忘了 `make build`），那样跑的是上一次编译时的源码。
 *    同样的理由写在 scripts/docs-gen-reference.ts 的注释里。
 * 2. **提示词只能走 argv 位置参数。** packages/cli/src/cli.ts 把 positionals join 成 prompt；
 *    无头模式下 prompt 为空会硬退出 1。print 模式**没有** stdin 兜底
 *    （只有 --input-format stream-json 才从 stdin 读 NDJSON）。
 * 3. **--permission-mode 用 acceptEdits。** curate 要写文件。⚠ 不用 always-allow /
 *    dontAsk —— 这是个会执行 git show 的 agent，放开全部权限没有必要。
 * 4. **工具名是小写**（已用 --dump-tools 核对）：写成 `Write`/`Read` 会静默匹配不上。
 */
function runAgent(prompt: string, timeoutMs: number): Promise<SpawnResult> {
  const env = {
    ...process.env,
    // 不把 curate 跑成一条真实用户轨迹污染度量
    SID_CODE_NO_TELEMETRY: "1",
    SID_CODE_EVAL_MODE: "1",
  };

  const args = [
    "run",
    "packages/cli/src/entrypoints/bootstrap.ts",
    "--print",
    "--max-turns",
    String(MAX_TURNS),
    "--permission-mode",
    "acceptEdits",
    "--allowed-tools",
    "read,glob,grep,bash,write",
    prompt,
  ];

  return new Promise<SpawnResult>((res) => {
    const proc = spawn("bun", args, { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      // code === null 即被 SIGTERM 杀掉 = 超时
      res({ code, stdout, stderr });
    });
  });
}

interface VerifyResult {
  ok: boolean;
  entry: CuratedEntry | null;
  errors: string[];
  warnings: string[];
}

/**
 * 校验磁盘上的 curated 文件。三级把关（顺序即失败的严重程度）：
 *   ① 文件存在？   不存在 → agent 根本没写（或写到了别处）
 *   ② JSON 能解析？不能 → 被 SIGTERM 截断，或 agent 写坏了
 *   ③ schema 合规？不合规 → 列出具体哪条不合规，好一轮改完
 * 另加一道 warn：commits 覆盖率（漏掉一整块功能是本方案最可能的失败模式，且完全静默）。
 */
export function verifyCuratedFile(version: string, realHashes?: string[]): VerifyResult {
  const p = curatedPath(version);
  if (!existsSync(p)) {
    return { ok: false, entry: null, errors: [`文件不存在：${p}`], warnings: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (err: any) {
    return { ok: false, entry: null, errors: [`读取失败：${err?.message ?? err}`], warnings: [] };
  }
  // 裸 NUL 字节：agent 落盘偶发产出，且它会让 grep 静默漏报整个文件
  // （packages/cli/src/app.ts 曾因此让全仓搜索查不到内容）。这里当场拦住，不让它进仓库。
  if (raw.includes("\0")) {
    return { ok: false, entry: null, errors: ["文件含裸 NUL 字节（0x00）"], warnings: [] };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err: any) {
    return {
      ok: false,
      entry: null,
      errors: [`JSON 解析失败（agent 可能被超时中断）：${err?.message ?? err}`],
      warnings: [],
    };
  }

  const errors = validateCurated(obj, version);
  const warnings: string[] = [];
  if (errors.length === 0 && realHashes && realHashes.length > 0) {
    const cov = checkCoverage(obj as CuratedEntry, realHashes);
    if (cov.warn) {
      warnings.push(
        `commits 覆盖率偏低：${cov.unaccounted.length}/${cov.total} 条提交既不在 commits ` +
          `也不在 discarded 里（${(cov.ratio * 100).toFixed(0)}% > 阈值 ` +
          `${(COVERAGE_WARN_THRESHOLD * 100).toFixed(0)}%）。漏掉一整块功能是完全静默的，` +
          `请核对：${cov.unaccounted.slice(0, 8).join(" ")}${cov.unaccounted.length > 8 ? " …" : ""}`,
      );
    }
  }
  return {
    ok: errors.length === 0,
    entry: errors.length === 0 ? (obj as CuratedEntry) : null,
    errors,
    warnings,
  };
}

/**
 * 把条目打印到终端 —— 这是 review 疲劳的第 2 条缓解措施（见文件头）。
 * 让「读一遍文案」在命令行就能完成，不必去开文件。
 */
function printEntry(entry: CuratedEntry): void {
  console.log("");
  console.log(`  ┌─ v${entry.version}${entry.userFacing ? "" : "（无用户可见变更）"}`);
  if (entry.highlight) console.log(`  │  ★ ${entry.highlight}`);
  for (const sec of entry.sections) {
    console.log(`  │  【${sec.title}】`);
    for (const item of sec.items) console.log(`  │    · ${item}`);
  }
  console.log(
    `  └─ 采用 ${entry.commits?.length ?? 0} 条 / 丢弃 ${entry.discarded?.length ?? 0} 条`,
  );
  console.log("");
}

/** genesis 版本的人工占位（--stub）。见下方 curateOne 里为什么不让 agent 硬 curate 它。 */
function writeGenesisStub(version: string, hashes: string[]): void {
  const entry: CuratedEntry = {
    version,
    highlight: "早期版本汇总",
    userFacing: false,
    sections: [],
    commits: [],
    // 全部记为「看过但不写」：这样覆盖率检查不会对这个版本报 warn，
    // 而 discarded 非空又如实表达了「这些提交是被有意跳过的，不是漏掉的」。
    discarded: hashes,
    generatedBy: "manual",
    reviewedBy: "human",
  };
  mkdirSync(CURATED_DIR, { recursive: true });
  writeFileSync(curatedPath(version), JSON.stringify(entry, null, 2) + "\n");
}

interface CurateOptions {
  force: boolean;
  stub: boolean;
  timeoutMs: number;
  /** 校验失败后把错误回喂给 agent 重试的次数 */
  retries: number;
}

/**
 * 校验失败时的重试提示词：把**具体错误**回喂给 agent。
 *
 * 为什么需要这个而不是只靠提示词把规则写清楚：实测 v0.1.595 那次，agent 在文案里写了
 * 半角双引号（`行为更符合"只读"预期`），整个 JSON 解析失败、这一版的工作全部作废。
 * 提示词已加了「不要用半角双引号」这条规则，但**提示词不是保障** ——
 * backfill 要连跑 19 个版本，一次形态错误就得人工回来重跑一个，而重跑的信息
 * （错在哪）本来就在手上，没有理由不直接给它。
 *
 * 重试**只回喂错误，不重述任务**：任务上下文（提交清单、规则）在上一轮已经给过，
 * 重复一遍只会稀释「这次要修的是什么」。
 */
function buildRetryPrompt(version: string, errors: string[]): string {
  return [
    `你刚才写的 ${curatedPath(version)} 没有通过校验。请修好它。`,
    "",
    "具体错误：",
    ...errors.map((e) => `- ${e}`),
    "",
    "用 read 工具读回那个文件，改掉上面这些问题，再用 write 工具写回同一个路径。",
    "不要改动任何其它文件，也不要重新做一遍分析 —— 只修上面列出的问题。",
    "",
    "提醒：文案里不要用半角双引号（要引用就用「」），JSON 必须是合法的。",
  ].join("\n");
}

/**
 * 文件根本不存在时的重试提示词 —— 与 buildRetryPrompt **必须分开**。
 *
 * 实测踩到（v0.1.599，900s 超时被 SIGTERM）：文件不存在时若沿用「读回那个文件、
 * 只修列出的问题」那套话术，就是让 agent 去 read 一个不存在的路径、并且明确禁止它
 * 「重新做一遍分析」—— 而此时它**什么都还没做**，任务上下文（提交清单、规则）
 * 也随上一个进程一起消失了。那次它侥幸恢复了，但这条指令与现实矛盾，不能留。
 *
 * 所以「文件不存在」走的是**重发原任务**，而不是修补。
 */
function isMissingFileError(errors: string[]): boolean {
  return errors.some((e) => e.startsWith("文件不存在："));
}

async function curateOne(version: string, opts: CurateOptions): Promise<boolean> {
  const tags = listSemverTags();
  const vr = versionRange(version, tags);
  const rangeLabel = vr.range ?? "（全部历史）";

  const commits = collectRawCommits(
    vr.range,
    // genesis 的 `tag~N` 可能超出根提交范围，退化为「从根到 tag」
    vr.isGenesis && vr.tag ? vr.tag : undefined,
  );
  const hashes = commits.map((c) => c.hash);

  const p = curatedPath(version);
  if (existsSync(p) && !opts.force) {
    console.log(`  ⏭  v${version} 已有 curated 文件，跳过（要重跑加 --force 或先删掉它）`);
    return true;
  }

  /**
   * genesis 版本（最老的 tag）是特例：它的区间是「早期历史的截断汇总」
   * （只回溯 GENESIS_LOOKBACK 条且跨越了项目早期的大量重写），**不是一个真实版本的
   * 变更集**。让 agent 硬去 curate 这些提交，产出的文案对今天的用户没有参考价值。
   * 所以默认给它一个人工占位，除非显式 --force 要求真跑。
   */
  if (vr.isGenesis && !opts.force) {
    console.log(
      `  ℹ️  v${version} 是 genesis 块（区间被截断到 ${GENESIS_LOOKBACK} 条，跨越早期重写），` +
        `写人工占位而不调 LLM`,
    );
    writeGenesisStub(version, hashes);
    const vres = verifyCuratedFile(version);
    if (!vres.ok) {
      console.error(`  ❌ genesis 占位自身校验失败：\n${vres.errors.map((e) => "     " + e).join("\n")}`);
      return false;
    }
    printEntry(vres.entry!);
    return true;
  }

  if (opts.stub) {
    writeGenesisStub(version, hashes);
    console.log(`  ✅ v${version} 已写人工占位（--stub，未调 LLM）`);
    return true;
  }

  if (commits.length === 0) {
    console.log(`  ⚠️  v${version}（${rangeLabel}）区间无可归类提交，写「无用户可见变更」`);
    const entry: CuratedEntry = {
      version,
      highlight: null,
      userFacing: false,
      sections: [],
      commits: [],
      discarded: [],
      generatedBy: "manual",
      reviewedBy: "human",
    };
    mkdirSync(CURATED_DIR, { recursive: true });
    writeFileSync(p, JSON.stringify(entry, null, 2) + "\n");
    return true;
  }

  console.log(`>>> curate v${version}（${rangeLabel}，${commits.length} 条提交）...`);
  mkdirSync(CURATED_DIR, { recursive: true });

  const prompt = buildPrompt(version, rangeLabel, commits);
  const t0 = Date.now();
  const res = await runAgent(prompt, opts.timeoutMs);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  if (res.code === null) {
    console.error(`  ❌ v${version} agent 超时被杀（${secs}s）`);
  } else if (res.code !== 0) {
    console.error(`  ⚠️  v${version} agent 退出码 ${res.code}（${secs}s）—— 仍尝试校验落盘文件`);
  } else {
    console.log(`  agent 结束（${secs}s，退出码 0）`);
  }

  let vres = verifyCuratedFile(version, hashes);
  let lastStdout = res.stdout;

  // 校验失败 → 重试。两种失败要用不同的提示词（见 isMissingFileError 的注释）：
  //   · 文件不存在（超时被杀）→ **重发原任务**，因为它什么都还没做
  //   · 文件存在但不合规     → 只回喂错误，让它修那几处
  for (let attempt = 1; attempt <= opts.retries && !vres.ok; attempt++) {
    const missing = isMissingFileError(vres.errors);
    console.warn(
      `  ⚠️  v${version} 校验失败，${missing ? "重发原任务" : "回喂错误"}重试` +
        `（第 ${attempt}/${opts.retries} 次）：`,
    );
    for (const e of vres.errors) console.warn(`     · ${e}`);
    const retryRes = await runAgent(
      missing ? prompt : buildRetryPrompt(version, vres.errors),
      opts.timeoutMs,
    );
    lastStdout = retryRes.stdout;
    vres = verifyCuratedFile(version, hashes);
  }

  if (!vres.ok) {
    console.error(`  ❌ v${version} 校验失败（已重试 ${opts.retries} 次）：`);
    for (const e of vres.errors) console.error(`     · ${e}`);
    // 校验失败时才打印 stdout 尾部辅助排查 —— 平时不打印，因为它是散文噪音
    const tail = lastStdout.trim().slice(-800);
    if (tail) console.error(`  ── agent stdout 尾部 ──\n${tail}`);
    return false;
  }
  for (const w of vres.warnings) console.warn(`  ⚠️  ${w}`);
  printEntry(vres.entry!);
  console.log(`  ✅ ${curatedPath(version)}`);
  return true;
}

/** --check：不调 LLM，只校验已入库的全部 curated 文件（CI / 手改完自查用） */
function checkAll(): number {
  if (!existsSync(CURATED_DIR)) {
    console.error(`  ❌ 目录不存在：${CURATED_DIR}`);
    return 1;
  }
  const files = readdirSync(CURATED_DIR)
    .filter((f) => /^v\d+\.\d+\.\d+\.json$/.test(f))
    .sort();
  if (files.length === 0) {
    console.error(`  ❌ ${CURATED_DIR} 下没有任何 curated 文件`);
    return 1;
  }
  const tags = listSemverTags();
  let bad = 0;
  let warned = 0;
  for (const f of files) {
    const version = f.replace(/^v/, "").replace(/\.json$/, "");
    const vr = versionRange(version, tags);
    const hashes = collectRawCommits(
      vr.range,
      vr.isGenesis && vr.tag ? vr.tag : undefined,
    ).map((c) => c.hash);
    const vres = verifyCuratedFile(version, hashes);
    if (!vres.ok) {
      bad++;
      console.error(`  ❌ ${f}`);
      for (const e of vres.errors) console.error(`     · ${e}`);
    } else if (vres.warnings.length > 0) {
      warned++;
      console.warn(`  ⚠️  ${f}`);
      for (const w of vres.warnings) console.warn(`     · ${w}`);
    }
  }
  if (bad === 0) {
    console.log(`  ✅ ${files.length} 个 curated 文件全部通过校验（${warned} 个有 warn）`);
  } else {
    console.error(`  ${bad}/${files.length} 个文件校验失败`);
  }
  return bad === 0 ? 0 : 1;
}

function nextVersion(): string {
  // 与 release.sh 一致：当前 package.json 的版本号 +1 patch。
  // 刻意不自己写文件，只算出号来；bump 是 release.sh 的职责。
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
  const [maj, min, pat] = String(pkg.version).split(".").map(Number);
  return `${maj}.${min}.${pat + 1}`;
}

function usage(): void {
  console.log(`用法:
  bun run changelog:curate [<version>]        为指定版本（默认：下一个版本）生成文案
  bun run changelog:curate --backfill-all     全量 backfill 所有历史 tag（串行）
  bun run changelog:curate --backfill-missing 只跑缺 curated 文件的版本（可中断续跑）
  bun run changelog:curate --check            不调 LLM，只校验已入库的全部文件
  bun run changelog:curate <version> --stub   写人工占位（不调 LLM）

选项:
  --force            已有 curated 文件时也重跑（genesis 版本也会真调 LLM）
  --timeout <秒>     单个版本的 agent 超时（默认 ${DEFAULT_TIMEOUT_MS / 1000}s）
  --limit <n>        backfill 时只跑前 n 个（分批 review 用，见方案 §5.4）
  --retries <n>      校验失败后回喂错误重试的次数（默认 1）`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return;
  }
  if (argv.includes("--check")) {
    process.exit(checkAll());
  }

  const force = argv.includes("--force");
  const stub = argv.includes("--stub");
  const tIdx = argv.indexOf("--timeout");
  const timeoutMs = tIdx >= 0 && argv[tIdx + 1] ? Number(argv[tIdx + 1]) * 1000 : DEFAULT_TIMEOUT_MS;
  const lIdx = argv.indexOf("--limit");
  const limit = lIdx >= 0 && argv[lIdx + 1] ? Number(argv[lIdx + 1]) : Infinity;
  const rIdx = argv.indexOf("--retries");
  const retries = rIdx >= 0 && argv[rIdx + 1] ? Number(argv[rIdx + 1]) : 1;
  const opts: CurateOptions = { force, stub, timeoutMs, retries };

  const backfillAll = argv.includes("--backfill-all");
  const backfillMissing = argv.includes("--backfill-missing");

  if (backfillAll || backfillMissing) {
    // 逐版本**串行**执行。不要并发：并发会同时开 19 个 agent 各自跑 git show，
    // 既抢 CPU 又让失败难以定位。
    const tags = listSemverTags();
    let versions = tags.map((t) => t.replace(/^v/, ""));
    if (backfillMissing) {
      versions = versions.filter((v) => !existsSync(curatedPath(v)));
    }
    versions = versions.slice(0, limit === Infinity ? undefined : limit);
    if (versions.length === 0) {
      console.log("  ✅ 没有需要 backfill 的版本");
      return;
    }
    console.log(`>>> backfill ${versions.length} 个版本（串行）：${versions.join(" ")}`);
    const failed: string[] = [];
    for (const v of versions) {
      // backfill-missing 的语义就是「跳过已有的」，所以这里不传 force
      const ok = await curateOne(v, opts);
      if (!ok) failed.push(v);
    }
    console.log("");
    if (failed.length > 0) {
      console.error(`  ❌ ${failed.length} 个版本失败：${failed.join(" ")}`);
      console.error(`     单独重跑：bun run changelog:curate <version> --force`);
      process.exit(1);
    }
    console.log(`  ✅ ${versions.length} 个版本全部完成，请 git diff 逐条过目后提交`);
    return;
  }

  const positional = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));
  const version = positional ?? nextVersion();
  const ok = await curateOne(version, opts);
  if (!ok) process.exit(1);
  console.log(`  下一步：读一遍上面的条目，需要改就直接编辑 JSON，然后 git add + commit`);
}

// 只在被直接执行时跑；被 import 时（单测 import verifyCuratedFile）不能有副作用
if (import.meta.main) {
  main().catch((err) => {
    console.error(`  ❌ ${err?.message ?? err}`);
    process.exit(1);
  });
}
