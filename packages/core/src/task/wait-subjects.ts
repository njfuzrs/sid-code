/**
 * 等待对象的签名（subject）抽取：回答「这次等待盯的是哪个 PR / run / 资源」。
 *
 * ## 为什么需要
 *
 * 等待表的去重键一直是「工具调用 id」（`registerWait` 按 id 覆盖，见 wait-registry.ts），
 * 而模型与用户关心的是「等的是哪个对象」。b0aa0f1e 在 46 秒内用同一个脚本起了 4 个后台等待，
 * 四个 `WaitRegistered` 的 description 逐字相同，没有任何环节发现它们等的是同一个 PR 779。
 * 没有对象签名，「同一个对象只该有一个等待」这条约束就无从下手（20261112 方案 R1/R2）。
 *
 * ## 三个来源，一个口径
 *
 * - **命令行**（bash 的 command / monitor 的 command）：走 `status-query-commands` 的命令表，
 *   与 P1 等待期拦用的是**同一张表**。两边各搞一套命名的话，「回执说它等的是 gh:pr:779」
 *   与「P1 认为模型在查 gh:pr:779」会悄悄失配（S2 撤销同型）。
 * - **脚本正文**（`bash /tmp/wait-pr-779.sh`）：真实轨迹里等待逻辑几乎都写在脚本文件里，
 *   命令行只剩一句 `bash xxx.sh`。不展开脚本就抽不到任何对象——8b8d721f 的形态正是
 *   `bash wait-pr757.sh` 与 `bash wait-pr757-merge.sh` 等同一个 PR，命令行上认不出来。
 * - **自然语言**（schedule_wakeup 的 prompt）：沿用 `extractWaitSubjects` 的三条规则，
 *   它是这套签名最早的来源，唤醒与 monitor 的 S2 撤销已经依赖它。
 *
 * ## 方向：宁可抽不出，不可抽错
 *
 * 抽不出 = 不参与去重 = 行为与改动前完全一致（多起一个进程，就是今天的样子）；
 * 抽错 = 把两个无关的等待判成重复，模型真正想要的第二个等待被拒。所以：
 * - 变量抽不出值时**丢弃**该候选。`gh pr checks "$pr"` 在 `pr` 无赋值时不产
 *   `gh:pr:$pr` 这种伪签名——它跟任何真实 subject 都不相等，留着只会污染回执与审计；
 * - 脚本读不出 / 超过 64 KB / 不是普通文件时，当作没有脚本正文，只用命令行判定。
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { matchStatusQuery, statusQueryCandidates } from "./status-query-commands.ts";
import { extractWaitSubjects } from "./wait-registry.ts";

/**
 * 脚本正文读取上限（64 KB）。
 *
 * 与方案 R1 的口径一致：等待脚本是模型自己写的几十行循环，正常都在 1 KB 内。
 * 上限的唯一作用是别让一次登记去读一个几 MB 的生成文件——那既慢又不是等待脚本。
 */
const MAX_SCRIPT_BYTES = 64 * 1024;

/** 一次等待登记需要的输入（三入口各取其中一部分） */
export interface WaitSubjectInput {
  /** 命令行（bash 的 command / monitor 的 command 脚本） */
  command?: string;
  /** 自然语言（schedule_wakeup 的 prompt） */
  prompt?: string;
  /**
   * 已读到的脚本正文。省略时按 `command` 里的 `bash <path>` / `./<path>` 自行展开。
   * 显式传入是为了让调用方（或测试）能复用自己已经读到的内容，不重复读盘。
   */
  scriptBodies?: string[];
  /** 相对路径的解析基准（默认 process.cwd()） */
  cwd?: string;
}

/** 抽取结果：subjects 之外还要「命令归一化值」与「脚本正文哈希」，它们决定 duplicate / replace */
export interface WaitSubjectExtraction {
  /** 命中的对象签名，如 `gh:pr:779`；抽不出时为空数组 */
  subjects: string[];
  /** 归一化后的命令（`cd /tmp && bash a.sh` → `bash a.sh`）；无 command 时 undefined */
  normalizedCommand?: string;
  /** 脚本正文哈希；本次等待不涉及脚本文件时 undefined */
  scriptHash?: string;
}

/**
 * 抽取一次等待的对象签名。
 *
 * 三条来源串联而不是互相替代：`bash /tmp/a.sh # 等 PR 779` 里命令行与脚本正文都可能出对象，
 * 只取一边会漏掉另一边。结果去重后返回。
 */
export function extractWaitSubjectsFor(input: WaitSubjectInput): WaitSubjectExtraction {
  const command = input.command ?? "";
  const scriptBodies =
    input.scriptBodies ??
    (command ? collectWaitScriptBodies(command, input.cwd ?? process.cwd()) : []);

  const subjects = new Set<string>();
  // 变量先按**全部文本**收集：赋值通常写在脚本里，而被引用的查询在命令行或另一个文件里
  const vars = collectShellVars([command, ...scriptBodies].join("\n"));
  for (const chunk of [command, ...scriptBodies]) {
    if (!chunk) continue;
    collectSubjectsFromText(expandVars(chunk, vars), subjects);
  }
  if (input.prompt) {
    for (const s of extractWaitSubjects(input.prompt)) subjects.add(s);
  }

  // 「命令」这一维对唤醒来说是 prompt：它没有 shell 命令行，prompt 就是它全部的意图描述。
  // 不拿 prompt 参与归一化的话，同对象同 prompt 的第二个唤醒判不出 duplicate
  // （判据 1 因为 incoming 为空直接跳过），只能落到「新期限更长 → replace」，
  // 于是「同一件事重复排」永远不会被拦。
  const comparable = input.command ?? input.prompt;

  return {
    subjects: [...subjects],
    normalizedCommand: comparable ? normalizeWaitCommand(comparable) : undefined,
    scriptHash: hashScriptBodies(scriptBodies),
  };
}

/**
 * 从命令行里展开被执行的脚本文件正文（`bash <path>` / `sh` / `zsh` / `source` / `./<path>`）。
 *
 * 只做**一层**展开（脚本里再 `source` 别的文件不追）：等待脚本是模型自己写的，
 * 追多层会把「读几个无关文件」的成本带进每一次后台启动，而收益只存在于自造的多层结构里。
 * 读不到的路径静默跳过——那是命令本身的问题，不该让登记失败。
 */
export function collectWaitScriptBodies(command: string, cwd: string): string[] {
  const base = leadingCdCwd(command, cwd);
  const bodies: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const path = raw.replace(/^["']|["']$/g, "");
    if (!path || path.startsWith("-")) return;
    const body = readScriptBody(path, base);
    if (body === null) return;
    // 同一文件被引用两次（`bash a.sh; bash a.sh`）只算一次
    const key = `${path}\u0000${body.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    bodies.push(body);
  };

  // `bash [-eux] <path>` / `source <path>` / `sh <path>` / `. <path>`
  for (const m of command.matchAll(
    /(?:^|[\s;&|()])(?:bash|sh|zsh|source|\.)\s+(?:-[A-Za-z]+\s+)*([^\s;&|()<>"']+)/g,
  )) {
    push(m[1] ?? "");
  }
  // `./run.sh`（可执行脚本直接调用，b0aa0f1e 的等待脚本都是这种形态的变体）
  for (const m of command.matchAll(/(?:^|[\s;&|()])(\.{1,2}\/[^\s;&|()<>"']+)/g)) {
    push(m[1] ?? "");
  }
  return bodies;
}

/**
 * 命令归一化：判「两次等待是不是同一件事」的字面口径。
 *
 * 三条规则都来自真实轨迹里的等价写法：
 * - 去掉 `cd <dir> &&` 前缀——同一个脚本换工作目录调用还是同一个等待；
 * - `chmod +x X && bash X` 视为 `bash X`（ca8d7e5c 的写法，先赋权再跑）；
 * - 合并空白。
 *
 * 刻意**不**做的：不改写参数顺序、不展开变量。归一化只削掉「模型换个说法但语义没变」的
 * 噪声，判不出来时走 replace（启动新的），不会误判成重复。
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
 * 只比路径的话，第一份会被判成后三份的重复，方向反了。
 */
export function hashScriptBodies(bodies: string[]): string | undefined {
  if (bodies.length === 0) return undefined;
  const h = createHash("sha256");
  for (const b of [...bodies].sort()) h.update(b).update("\u0000");
  return h.digest("hex").slice(0, 16);
}

// ── 内部 ──

/**
 * 命令里的 `cd <dir> &&` 前缀决定相对脚本路径的基准目录。
 *
 * bash 工具传进来的 cwd 是**执行前**的工作目录，而命令自己可能先 cd 再跑脚本
 * （`cd /tmp && bash wait.sh`）。不跟随这一层就会读错文件——静默抽不到对象，
 * 表现为「去重时灵时不灵」，比报错更难查。
 */
function leadingCdCwd(command: string, cwd: string): string {
  let base = cwd;
  let rest = command.trim();
  for (;;) {
    const m = /^cd\s+([^\s;&|]+)\s*&&\s*/.exec(rest);
    if (!m) break;
    const target = m[1]!.replace(/^["']|["']$/g, "");
    base = isAbsolute(target) ? target : resolve(base, target);
    rest = rest.slice(m[0].length);
  }
  return base;
}

function readScriptBody(path: string, cwd: string): string | null {
  try {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    const st = statSync(abs);
    if (!st.isFile() || st.size === 0 || st.size > MAX_SCRIPT_BYTES) return null;
    return readFileSync(abs, "utf8");
  } catch {
    // 读不到（不存在 / 无权限 / 竞态删除）＝ 没有脚本正文，不是错误
    return null;
  }
}

/**
 * shell 变量赋值（`pr=779` / `pr="779"` / `local pr=779`）。
 *
 * 只取值是字面量的赋值：`pr=$(gh pr list ...)` 这类命令替换求不出来，不收集——
 * 猜一个值出来会造出错误签名，那比抽不出更糟。
 */
function collectShellVars(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/(?:^|[;&\s])([A-Za-z_][A-Za-z0-9_]*)=(["']?)([^"';&\s|()]+)\2/g)) {
    const name = m[1]!;
    const value = m[3]!;
    if (value.includes("$") || value.includes("`")) continue;
    vars.set(name, value);
  }
  return vars;
}

/** 变量替换：先处理整段被引号包住的形态，再处理裸引用。抽不出值时原样保留。 */
function expandVars(text: string, vars: Map<string, string>): string {
  if (vars.size === 0) return text;
  const quoted = text.replace(
    /(["'])\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\1/g,
    (full, _q, name: string) => vars.get(name) ?? full,
  );
  return quoted.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (full, braced: string | undefined, bare: string | undefined) =>
      vars.get(braced ?? bare ?? "") ?? full,
  );
}

/** 文本里每个候选片段都跑一遍命令表；含未展开变量的伪签名直接丢弃 */
function collectSubjectsFromText(text: string, out: Set<string>): void {
  for (const line of text.split("\n")) {
    for (const candidate of statusQueryCandidates(line)) {
      const m = matchStatusQuery(candidate);
      if (!m) continue;
      if (m.subject.includes("$") || m.subject.includes("`")) continue;
      out.add(m.subject);
    }
  }
  // 宽松兜底：命令表要求「整条命令都是只读查询」，而 monitor 的命令常常把查询写在
  // 输出文本里（`echo "gh pr checks 662: pass"; exit 0`，唤醒撤销链的既有用例就是这个形态）。
  // 少了这一层，monitor 的 subjects 会比改动前**变窄**——S2「监控终态后撤销同对象唤醒」
  // 会静默失效，表现为唤醒到点又触发一次（实测该用例因此变红）。
  // 方向：这层只做「宁可多认几个对象」，与命令表的严格口径不冲突。
  for (const m of text.matchAll(/\bgh\s+pr\s+(?:checks|view|status)\s+(\d+)/gi)) {
    out.add(`gh:pr:${m[1]}`);
  }
  for (const m of text.matchAll(/\bgh\s+run\s+(?:view|watch)\s+(\d+)/gi)) {
    out.add(`gh:run:${m[1]}`);
  }
}
