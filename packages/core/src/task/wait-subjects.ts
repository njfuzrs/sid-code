/**
 * 等待对象签名（subject）的统一抽取入口（R1：20261112-收尾阶段重复挂监听）。
 *
 * ## 要解决的事故
 *
 * b0aa0f1e / 8b8d721f 的后台等待是 `bash /tmp/wait-pr-779.sh`，ca8d7e5c 是内联
 * `for i in $(seq 1 90); do s=$(gh pr view 780 …); done`。两者都正确登记进了等待表
 * （`kind: "shell"` + deadline 承诺），但登记项里**没有 subjects** —— harness 回答不了
 * 「这个等待在等哪个 PR」，R2 的去重、R6 的替换、P1 的覆盖判定全部缺这个前提。
 *
 * ## 三个入口此前各管一半（口径不一致的根源）
 *
 * - `wait-registry.extractWaitSubjects`：只认 `PR #N` / `pull/N` / `run N` 三种**自然语言**。
 * - `tool/monitor.extractMonitorSubjects`：在它基础上加
 *   `gh pr (checks|view|status) N` / `gh run (view|watch) N` 两条**私有正则**。
 * - bash 的 `registerWaitUntil`：什么都没调。
 *
 * 这个模块把三处收成一个：
 *
 * 1. 命令类规则**直接复用** `status-query-commands` 的命令表，于是「P1 拦得住的查询」与
 *    「等待表认得的对象」是同一把尺子，不会出现 P1 认 `gh:pr:780` 而等待表认不出的两套标准。
 * 2. 自然语言规则保留原三条（唤醒的 prompt 只有人话，没有命令）。
 * 3. 补一层**脚本文件展开**：对象写在 `/tmp/wait-pr-779.sh` 里时，命令行上一个字都没有
 *    （见 `extractScriptPaths` 与 bash 侧的 `readWaitScriptBodies`）。
 *
 * ## 方向：抽不到就为空，绝不猜
 *
 * 空 subjects 的后果是「回到改造前」（不去重、不替换、P1 退回探测窗口），而不是误判。
 * 所以判不准一律不认；宁可漏一个反复挂的等待，也不要让两个不相干的对象互相去重。
 */

import { createHash } from "node:crypto";
import { splitShellSubcommands, splitShellWords } from "../tool/bash/parser.ts";
import {
  type StatusQueryFamily,
  extractStatusQueryFamilies,
  matchStatusQuery,
  statusQueryCandidates,
} from "./status-query-commands.ts";

/**
 * 脚本文件正文的读取上限（64 KB）。
 *
 * 为什么要有上限：`bash /tmp/x.sh` 的路径来自命令原文，指向什么由模型决定。
 * 把一个几百 MB 的日志当脚本读进来只为抽一个 PR 号，代价与收益完全不成比例；
 * 而真实等待脚本都在几十行以内（取证的四份是 20–40 行）。
 */
export const MAX_SCRIPT_BODY_BYTES = 64 * 1024;

/**
 * 三类来源。
 *
 * - `command`：bash 命令原文（前台 / 后台都算；monitor 的脚本正文也走这里）
 * - `prompt`：唤醒的自然语言描述
 * - `scriptBodies`：命令调用到的脚本文件**正文**（由调用方读取后传入）。
 *   本模块刻意不碰 I/O：读文件牵扯 cwd、权限、大小上限，全在 bash 工具那一侧才拿得准，
 *   而纯函数才好测。
 */
export interface WaitSubjectSources {
  command?: string;
  prompt?: string;
  scriptBodies?: readonly string[];
}

/**
 * 自然语言规则：原 `wait-registry.extractWaitSubjects` 的三条，**逐字保留**。
 *
 * 它是唤醒（`schedule_wakeup`）的唯一来源，也被脚本正文的注释用到：
 * b0aa0f1e 的脚本头部写着 `# 等待 PR #779 的 CI + auto-merge 结果`，而正文里的查询是
 * `gh api "repos/$REPO/pulls/$PR"`（变量形态，命令表认不出）——抽到 `gh:pr:779` 靠的就是这里。
 *
 * 注意第三条要求 `run` 后面直接是 `/` 或空白再跟 6 位以上数字（run id 的形态）；
 * `gh run view 43203650726` 这种由命令表负责，不在这里。
 */
export function extractNaturalLanguageSubjects(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bPR\s*#?\s*(\d+)/gi)) out.add(`gh:pr:${m[1]}`);
  for (const m of text.matchAll(/\bpull\/(\d+)/gi)) out.add(`gh:pr:${m[1]}`);
  for (const m of text.matchAll(/\bruns?[/\s]\s*(\d{6,})/gi)) out.add(`gh:run:${m[1]}`);
  return [...out];
}

/**
 * 内置等待原语（`sid-wait gh-pr <n>`）的对象签名（R7）。
 *
 * 与自然语言规则的区别：这里的 `<n>` **不是猜出来的**，是原语语法的一部分——模型写
 * `sid-wait gh-pr 779` 就是在说「等 PR 779」。所以它比 `PR #N` 那三条正则更可靠，
 * 也不需要脚本展开（原语没有脚本体）。
 *
 * 仍然只在「命令类文本」上跑（脚本正文也算命令类）：唤醒的 prompt 里写
 * 「以后用 sid-wait gh-pr 779」是叙述，不是正在等。
 */
export function extractSidWaitSubjects(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bsid-wait\s+gh-pr\s+(\d+)\b/g)) out.add(`gh:pr:${m[1]}`);
  return [...out];
}

/**
 * 命令类规则：逐候选片段跑 P1 命令表，命中就取它的 `subject`。
 *
 * 为什么不整条命令跑一次 `matchStatusQuery`：真实写法是
 * `cd X && for i in $(seq 1 90); do s=$(gh pr view 780 --json …); case … esac; sleep 20; done` ——
 * 整条里带 `case` / `esac` / `exit`（命令表一个都不认），`matchStatusQuery` 直接 null；
 * 而 `$(gh pr view 780 …)` 抽出来是一段干净的查询。
 *
 * 切法复用 `statusQueryCandidates`（整行 → 命令替换内部 → 反引号 → 分隔符切开），
 * 与 `extractStatusQueryFamilies` 同一把尺子，不另起一套。
 */
function commandSubjectsOf(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    for (const candidate of statusQueryCandidates(line)) {
      const hit = matchStatusQuery(candidate);
      if (hit) out.add(hit.subject);
    }
  }
  return [...out];
}

/** shell 解释器名（路径形态取 basename 再比：`/bin/bash` 也算） */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** 带值选项：紧跟在它后面的 token 是值，不是文件路径 */
const OPTIONS_WITH_VALUE = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/**
 * 从一个子命令段里认出「要执行的脚本文件路径」。
 *
 * 只认两种形态：解释器 + 路径（`bash x.sh` / `sh -u x.sh`）、路径直接执行（`./x.sh` / `/abs/x.sh`）。
 * **不跟随 `source` / `.`**：它们经常被用来加载环境或 wrapper，跟进去抽到的是别人的对象。
 */
function scriptPathOf(segment: string): string | null {
  const argv = splitShellWords(segment);
  const first = argv[0];
  if (!first) return null;
  if (first === "source" || first === ".") return null;

  const base = first.slice(first.lastIndexOf("/") + 1);
  if (SHELL_INTERPRETERS.has(base)) {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      // `bash -c '<命令串>'`：后面接的是命令不是文件，展开会把整串当路径去 stat
      if (a === "-c" || a === "--command") return null;
      if (OPTIONS_WITH_VALUE.has(a)) {
        i++;
        continue;
      }
      if (a.startsWith("-") || a.startsWith("+")) continue;
      return a;
    }
    return null;
  }

  // 直接执行形态：必须带路径分隔符，否则 `foo` 是 PATH 里的命令而不是文件
  if (first.startsWith("/") || first.startsWith("./") || first.startsWith("../")) return first;
  return null;
}

/**
 * 命令里**字面出现**的脚本文件路径（纯识别，不读文件）。
 *
 * 读文件由调用方做（bash 工具的 `readWaitScriptBodies`）：只有那一侧才知道解析后的 cwd，
 * 也只有那一侧该承担「读不到就跳过」的决定。
 *
 * 不递归：脚本 A 里再调 `bash B` 不会展开到 B。真实等待脚本都是一层，
 * 递归展开要处理自引用与深度上限，换来的收益在取证会话里一次都没出现。
 */
export function extractScriptPaths(command: string): string[] {
  const out = new Set<string>();
  for (const segment of splitShellSubcommands(command)) {
    const path = scriptPathOf(segment);
    if (path) out.add(path);
  }
  return [...out];
}

/** 统一入口：bash / monitor / schedule_wakeup 三处都调它 */
export function collectWaitSubjects(sources: WaitSubjectSources): string[] {
  const out = new Set<string>();
  for (const text of commandLikeTexts(sources)) {
    // 命令类与自然语言都跑：脚本注释里写 `# 等待 PR #779` 是取证会话的常态，
    // 而命令行里的查询（`gh pr view 780`）只有命令表认得。
    for (const s of extractNaturalLanguageSubjects(text)) out.add(s);
    for (const s of commandSubjectsOf(text)) out.add(s);
    // R7：内置原语的语法本身就是签名，不必走命令表猜
    for (const s of extractSidWaitSubjects(text)) out.add(s);
  }
  // 唤醒 prompt 只走自然语言：它是人话，跑命令表会把「描述里举例的命令」当成真在查询
  if (sources.prompt) {
    for (const s of extractNaturalLanguageSubjects(sources.prompt)) out.add(s);
  }
  return [...out];
}

/**
 * 命令族：与 `collectWaitSubjects` 同一批文本、同一把尺子。
 *
 * 它是 P1「等待期拦截」判覆盖的依据（D13：同 subject 不同族覆盖的字段不同），
 * 所以必须和 subject 一起登记，否则会出现「等待表说在等 780，P1 说没人覆盖这条查询」。
 */
export function collectWaitCommandFamilies(sources: WaitSubjectSources): StatusQueryFamily[] {
  const out = new Set<StatusQueryFamily>();
  for (const text of commandLikeTexts(sources)) {
    for (const family of extractStatusQueryFamilies(text)) out.add(family);
  }
  return [...out];
}

/** 需要「按命令扫」的文本：命令本身 + 它调用到的脚本正文 */
function commandLikeTexts(sources: WaitSubjectSources): string[] {
  const out: string[] = [];
  if (sources.command) out.push(sources.command);
  for (const body of sources.scriptBodies ?? []) out.push(body);
  return out;
}

// ── R2：判「两次等待是不是同一件事」的两个口径 ──

/**
 * 命令归一化：判 duplicate / replace 的字面口径。
 *
 * 三条规则都来自真实轨迹里的等价写法：
 * - 去掉 `cd <dir> &&` 前缀——同一个脚本换工作目录调用还是同一个等待；
 * - `chmod +x X && bash X` 视为 `bash X`（ca8d7e5c 的写法，先赋权再跑）；
 * - 合并空白。
 *
 * 刻意**不**做的：不改写参数顺序、不展开变量。归一化只削掉「模型换个说法但语义没变」的
 * 噪声；判不出来时走 replace（启动新的），不会误判成重复。
 */
export function normalizeWaitCommand(command: string): string {
  let s = command.replace(/\s+/g, " ").trim();
  for (;;) {
    const m = /^(?:cd\s+[^\s;&|]+|chmod\s+[^\s;&|]+(?:\s+[^\s;&|]+)?)\s*&&\s*/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

/**
 * 脚本正文的稳定哈希（前 16 位）。
 *
 * 用途只有一个：同样的路径、改了内容的脚本算「命令不同」（R2 的 replace 分支）。
 * b0aa0f1e 10:55:27 改过 `/tmp/wait-pr-779.sh`，10:55:31 起第一份、之后三份内容没变——
 * 只比路径的话，第一份会被判成后三份的重复，方向正好反了。
 */
export function hashScriptBodies(bodies: readonly string[]): string | undefined {
  if (bodies.length === 0) return undefined;
  const h = createHash("sha256");
  for (const b of [...bodies].sort()) h.update(b).update("\u0000");
  return h.digest("hex").slice(0, 16);
}
