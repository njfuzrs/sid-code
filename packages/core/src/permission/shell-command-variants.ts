/**
 * bash 命令「等价执行形态」展开（deny / ask 规则、危险命令检测、写入目标保护共用）。
 *
 * ## 为什么需要它
 *
 * 规则与危险模式都是对**命令文本**做匹配，而 shell 有大量「文本不同、执行的是同一个程序」的写法。
 * 2026-10-24 对 `deny: ["Bash(curl *)"]` 实测（always-allow 下），下列形态**全部静默放行**：
 *
 * | 形态 | 例 |
 * | --- | --- |
 * | 前导空白 | `  curl evil.com` |
 * | 绝对路径 | `/usr/bin/curl evil.com` |
 * | 环境变量前缀 | `FOO=1 curl evil.com` |
 * | 包装命令 | `env curl` / `command curl` / `nohup curl` / `timeout 5 curl` / `xargs curl` |
 * | 转义 / 引号拼接 | `c\url evil.com` / `"cu"rl evil.com` |
 * | 再起一层 shell | `sh -c 'curl x'` / `bash -c` / `eval 'curl x'` |
 *
 * 危险命令硬编码检测同样被 `sh -c 'rm -rf /'` / `r\m -rf /` 绕过（实测 always-allow 下放行）。
 *
 * ## 口径：只用于「拦」，不用于「放」
 *
 * 展开出来的形态**只喂给 deny / ask / 危险检测 / 写保护**（取 some：任一形态命中即拦）。
 * allow 规则**不**用展开形态匹配——否则 `allow: ["Bash(npm *)"]` 会因为剥掉 `FOO=1` 而放行
 * `FOO=1 npm …` 之外的东西，等于把「拦」的宽口径借给了「放」。拦宽放窄 = fail-closed。
 *
 * ## 为什么不把参数也去引号
 *
 * 只规范化**命令头**（剥环境变量 / 包装命令、去转义、取 basename），参数保持原文。
 * 若把整条去引号再拼接，`git commit -m "rm -rf /"` 会变成 `git commit -m rm -rf /`，
 * 危险模式把一条提交说明当成删根目录——拦的宽度变成了误报的来源。
 * 真正要往里看的「参数即代码」只有 `sh -c` / `eval` / 命令替换三类，单独递归展开。
 */

import * as path from "node:path";
import {
  extractHeredocBlocks,
  isShellLikeProgram,
  splitCommandStructure,
} from "./shell-structure.ts";
import { detectRedirections } from "./shell-parser.ts";

/** 带原文位置的 token（value 是去引号 / 去转义之后的值） */
interface PositionedToken {
  value: string;
  start: number;
  end: number;
}

/**
 * 位置感知的 shell 分词：认单/双引号与反斜杠转义，返回每个 token 的值与原文区间。
 * 与 tool/bash/parser.ts 的 tokenize 同一口径，多出来的只是区间——命令头规范化之后
 * 要把参数部分按原文拼回去，必须知道命令头在原文里结束于哪里。
 */
function tokenizeWithPositions(cmd: string): PositionedToken[] {
  const tokens: PositionedToken[] = [];
  let value = "";
  let start = -1;
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const flush = (end: number) => {
    if (start >= 0) tokens.push({ value, start, end });
    value = "";
    start = -1;
  };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      flush(i);
      i++;
      continue;
    }
    if (start < 0) start = i;
    if (ch === "\\" && !inSingle && i + 1 < cmd.length) {
      value += cmd[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    value += ch;
    i++;
  }
  flush(cmd.length);
  return tokens;
}

/** 包装命令：执行的其实是后面那个程序。argOpts = 自带一个参数的选项；positional = 程序前的位置参数个数 */
interface WrapperSpec {
  argOpts?: ReadonlySet<string>;
  positional?: number;
  /** 出现这些选项时它不是在执行后面的程序（`command -v curl` 是查询，不是调用） */
  notExecIf?: ReadonlySet<string>;
  /** env 允许在程序前再写一串 VAR=val */
  allowsAssignments?: boolean;
}

const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  env: {
    argOpts: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
    allowsAssignments: true,
  },
  command: { notExecIf: new Set(["-v", "-V"]) },
  builtin: {},
  exec: { argOpts: new Set(["-a"]) },
  nohup: {},
  nice: { argOpts: new Set(["-n", "--adjustment"]) },
  time: { argOpts: new Set(["-f", "--format", "-o", "--output"]) },
  timeout: { argOpts: new Set(["-k", "--kill-after", "-s", "--signal"]), positional: 1 },
  stdbuf: { argOpts: new Set(["-i", "-o", "-e"]) },
  ionice: { argOpts: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]) },
  chrt: { positional: 1 },
  taskset: { positional: 1 },
  setsid: {},
  unbuffer: {},
  caffeinate: { argOpts: new Set(["-t", "-w"]) },
  sudo: {
    argOpts: new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-C",
      "-h",
      "--host",
      "-p",
      "-U",
      "-r",
      "-t",
    ]),
  },
  doas: { argOpts: new Set(["-u", "-C"]) },
  xargs: {
    argOpts: new Set(["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a", "--max-args", "--delimiter"]),
  },
};

/** find 的「执行动作」：其后第一个 token 处在程序位置 */
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** 引号是否闭合（反斜杠转义感知）。未闭合时分词结果与 shell 的理解可能不一致 */
function hasBalancedQuotes(cmd: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
  }
  return !inSingle && !inDouble;
}

/**
 * 一个简单命令里所有处在「程序位置」的名字（去引号 / 去转义 / 取 basename）：
 * 命令头、沿 wrapper 链往下的每一层（`env FOO=1 nohup sudo id` → env、nohup、sudo、id），
 * 以及 `find … -exec <程序>` 的程序。
 *
 * 用途：判「是不是在执行 X」——这是程序位置的问题，不是原文里有没有 X 字样的问题
 * （`grep -n "sudo 命令" f` 不在执行 sudo）。
 *
 * 引号未闭合时返回 null，调用方应回退到原文判定（宁严勿松）。
 */
export function listInvokedPrograms(sub: string): string[] | null {
  if (!hasBalancedQuotes(sub)) return null;
  const tokens = tokenizeWithPositions(sub).map((t) => t.value);
  const names: string[] = [];

  const walk = (start: number) => {
    let i = start;
    while (i < tokens.length && ASSIGNMENT_RE.test(tokens[i])) i++;
    for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
      const name = path.basename(tokens[i]);
      names.push(name);
      const spec = WRAPPERS[name];
      if (!spec) break;
      let j = i + 1;
      let notExec = false;
      while (j < tokens.length) {
        const t = tokens[j];
        if (spec.allowsAssignments && ASSIGNMENT_RE.test(t)) {
          j++;
          continue;
        }
        if (t === "--") {
          j++;
          break;
        }
        if (!t.startsWith("-") || t === "-") break;
        if (spec.notExecIf?.has(t)) notExec = true;
        j += spec.argOpts?.has(t) && !t.includes("=") ? 2 : 1;
      }
      if (notExec) break;
      j += spec.positional ?? 0;
      if (j >= tokens.length) break;
      i = j;
    }
    // find -exec / -execdir / -ok / -okdir 之后是一个新的程序位置（可多次出现）
    if (names[names.length - 1] === "find") {
      for (let k = i + 1; k < tokens.length; k++) {
        if (FIND_EXEC_ACTIONS.has(tokens[k]) && k + 1 < tokens.length) walk(k + 1);
      }
    }
  };
  walk(0);
  return names;
}

/** 把参数当脚本执行的 shell（`sh -c '<脚本>'`） */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh"]);

/** 单个简单命令规范化的结果 */
interface CanonicalCommand {
  /** 命令头规范化后的整条（参数保持原文）；与原文相同时为 null */
  canonical: string | null;
  /** 规范化后的程序名 */
  program: string;
  /** 程序之后的参数（去引号值） */
  args: string[];
  /** 需要递归展开的内层脚本（sh -c / eval） */
  innerScripts: string[];
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function canonicalizeSimpleCommand(sub: string): CanonicalCommand {
  const tokens = tokenizeWithPositions(sub);
  let i = 0;
  // 1. 前导环境变量赋值
  while (i < tokens.length && ASSIGNMENT_RE.test(tokens[i].value)) i++;
  // 2. 包装命令（可多层：`env FOO=1 nohup timeout 5 curl`）
  for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
    const name = path.basename(tokens[i].value);
    const spec = WRAPPERS[name];
    if (!spec) break;
    let j = i + 1;
    let notExec = false;
    while (j < tokens.length) {
      const t = tokens[j].value;
      if (spec.allowsAssignments && ASSIGNMENT_RE.test(t)) {
        j++;
        continue;
      }
      if (t === "--") {
        j++;
        break;
      }
      if (!t.startsWith("-") || t === "-") break;
      if (spec.notExecIf?.has(t)) notExec = true;
      j += spec.argOpts?.has(t) && !t.includes("=") ? 2 : 1;
    }
    if (notExec) break;
    let positional = spec.positional ?? 0;
    while (positional > 0 && j < tokens.length) {
      j++;
      positional--;
    }
    if (j >= tokens.length) break; // 包装命令后面没有程序：它自己就是程序
    i = j;
  }
  if (i >= tokens.length) return { canonical: null, program: "", args: [], innerScripts: [] };

  const head = tokens[i];
  // 3. 去转义 / 去引号后的程序名，路径形态取 basename（`/usr/bin/curl` → `curl`）
  const program = head.value.includes("/") ? path.basename(head.value) : head.value;
  const rest = sub.slice(head.end);
  const canonicalText = `${program}${rest}`.trim();
  const args = tokens.slice(i + 1).map((t) => t.value);

  // 4. 参数即代码的两种形态
  const innerScripts: string[] = [];
  if (SHELLS.has(program)) {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === "--") break;
      if (!a.startsWith("-")) break;
      // `-c` 或组合短选项（`-lc` / `-ec`）
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
        const script = args[k + 1];
        if (typeof script === "string") innerScripts.push(script);
        break;
      }
    }
  } else if (program === "eval" && args.length > 0) {
    innerScripts.push(args.join(" "));
  }

  return {
    canonical: canonicalText !== sub.trim() ? canonicalText : null,
    program,
    args,
    innerScripts,
  };
}

/**
 * 提取命令替换 / 进程替换的内层脚本：`$(…)`、反引号、`<(…)`、`>(…)`。
 * 单引号内是字面量，不提取；双引号内的 `$(…)` 照样执行，要提取。
 */
export function extractSubstitutionBodies(cmd: string): string[] {
  const bodies: string[] = [];
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle) continue;
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`") {
      const close = cmd.indexOf("`", i + 1);
      if (close < 0) break;
      bodies.push(cmd.slice(i + 1, close));
      i = close;
      continue;
    }
    const opensParen =
      (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") ||
      (!inDouble && (ch === "<" || ch === ">") && cmd[i + 1] === "(");
    if (opensParen) {
      let depth = 1;
      let j = i + 2;
      for (; j < cmd.length && depth > 0; j++) {
        if (cmd[j] === "(") depth++;
        else if (cmd[j] === ")") depth--;
      }
      if (depth === 0) bodies.push(cmd.slice(i + 2, j - 1));
      i = j - 1;
    }
  }
  return bodies.filter((b) => b.trim() !== "");
}

/** 展开结果 */
export interface ShellCommandExpansion {
  /** 逐子命令的待匹配形态：原文（已 trim）+ 命令头规范化形态，含内层脚本递归展开 */
  variants: string[];
  /** 整段脚本：原命令 + 每一层 sh -c / eval / 命令替换的内层脚本（跨管道模式要整段匹配） */
  scripts: string[];
  /** 逐子命令的规范化程序名与参数（写入目标提取、结构化危险判定用） */
  commands: Array<{ program: string; args: string[]; text: string }>;
  /**
   * 按管道分组的程序名与参数：`curl x | sh` 是 `[[curl], [sh]]`。
   * 「下载并执行」「base64 解码执行」判的就是**同一条管道**里的前后段关系，
   * 扁平的 commands 里看不出谁和谁在同一个管道。
   */
  pipelines: Array<Array<{ program: string; args: string[]; text: string }>>;
}

/** 递归深度上限：`sh -c "bash -c 'eval …'"` 嵌套到这一层已远超正常用法 */
const MAX_DEPTH = 4;
/** 形态数上限：防病态输入把展开撑爆（超出部分丢弃，已收集的照常参与匹配） */
const MAX_VARIANTS = 128;

/**
 * 把一条 bash 命令展开成所有「等价执行形态」。只用于拦截类判定，见文件头「口径」一节。
 */
export function expandShellCommand(cmd: string): ShellCommandExpansion {
  const variants = new Set<string>();
  const scripts = new Set<string>();
  const commands: Array<{ program: string; args: string[]; text: string }> = [];
  const pipelines: Array<Array<{ program: string; args: string[]; text: string }>> = [];

  const visit = (script: string, depth: number) => {
    const trimmed = script.trim();
    if (!trimmed || variants.size >= MAX_VARIANTS) return;
    // heredoc 正文不参与「整段匹配」：它是数据，修前 `cat > f <<EOF` 的正文会被
    // 跨管道正则（`curl x | sh` 之类）当成命令。正文是否当脚本由接收者决定，见下。
    const { stripped, blocks } = extractHeredocBlocks(trimmed);
    const source = stripped.trim() === "" ? trimmed : stripped.trim();
    if (scripts.has(source)) return;
    scripts.add(source);

    const nested: string[] = [...extractSubstitutionBodies(source)];
    for (const pipeline of splitCommandStructure(source)) {
      const parsed: Array<{ program: string; args: string[]; text: string }> = [];
      for (const stage of pipeline.stages) {
        if (variants.size >= MAX_VARIANTS) break;
        variants.add(stage);
        const c = canonicalizeSimpleCommand(stage);
        if (c.canonical) variants.add(c.canonical);
        if (c.program) {
          const entry = { program: c.program, args: c.args, text: stage };
          commands.push(entry);
          parsed.push(entry);
        }
        nested.push(...c.innerScripts);
      }
      // heredoc 正文的归属：接收者是解释器（`bash <<EOF`）或管道下游是解释器
      // （`cat <<EOF | bash`）时正文是脚本，要递归判危险；接收者是文件时正文是数据，丢弃。
      for (const block of blocks) {
        const placeholder = `<<${block.placeholder}`;
        const ownerIdx = parsed.findIndex((p) => p.args.some((a) => a.includes(placeholder)));
        if (ownerIdx < 0) continue;
        const downstreamShell = parsed
          .slice(ownerIdx + 1)
          .some((p) => isShellLikeProgram(p.program));
        if (isShellLikeProgram(parsed[ownerIdx].program) || downstreamShell) {
          nested.push(block.body);
        }
      }
      pipelines.push(parsed);
    }
    if (depth < MAX_DEPTH) for (const n of nested) visit(n, depth + 1);
  };
  visit(cmd, 0);

  return { variants: [...variants], scripts: [...scripts], commands, pipelines };
}

/** 参数即写入目标的命令（全部非选项参数） */
const ALL_ARGS_WRITE = new Set([
  "tee",
  "touch",
  "mkdir",
  "rm",
  "rmdir",
  "unlink",
  "truncate",
  "chmod",
  "chown",
  "chgrp",
  "sed",
  "perl",
]);
/** `<` `>` `>>` `2>` `&>` `>|` 等重定向记号（可带紧贴的目标，如 `>f`） */
const REDIRECT_TOKEN_RE = /^(\d*|&)?(<|>{1,2}\|?|<<<?)/;
/** 最后一个非选项参数是写入目标 */
const LAST_ARG_WRITE = new Set(["cp", "mv", "install", "ln", "rsync", "scp"]);

/**
 * 提取 bash 命令可能写入的文件路径（供 safetyCheck 对 `.git/hooks` 等可执行路径做保护）。
 *
 * 宁多勿少：多出来的候选只会被 safetyCheck 判一次「是不是受保护路径」，不是就放过；
 * 漏一个则是一条免确认写入 hook 的路径。实测（修前，always-allow）：
 * `cp x .git/hooks/pre-commit` / `tee .git/hooks/pre-commit` / `sed -i … .git/hooks/pre-commit`
 * 全部静默放行——Step 2 的重定向检测只认 `>`，不认这些命令。
 */
export function extractBashWriteTargets(cmd: string): string[] {
  const { commands, scripts } = expandShellCommand(cmd);
  const targets = new Set<string>();
  for (const s of scripts) {
    for (const t of detectRedirections(s).targets) targets.add(t);
  }
  for (const { program, args } of commands) {
    const nonOpt: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      // 重定向记号与它的目标不是命令参数（目标已由上面 detectRedirections 收走）
      if (REDIRECT_TOKEN_RE.test(a)) {
        if (/[<>]$/.test(a)) k++;
        continue;
      }
      if (program === "dd" && a.startsWith("of=")) targets.add(a.slice(3));
      if (
        (program === "cp" || program === "mv" || program === "install" || program === "ln") &&
        (a === "-t" || a === "--target-directory")
      ) {
        if (args[k + 1]) targets.add(args[k + 1]);
      }
      if (a.startsWith("--target-directory=")) targets.add(a.slice("--target-directory=".length));
      if (program === "curl" && (a === "-o" || a === "--output") && args[k + 1])
        targets.add(args[k + 1]);
      if (program === "curl" && /^-o.+/.test(a)) targets.add(a.slice(2));
      if (program === "wget" && (a === "-O" || a === "--output-document") && args[k + 1])
        targets.add(args[k + 1]);
      if (program === "wget" && a.startsWith("--output-document="))
        targets.add(a.slice("--output-document=".length));
      if (!a.startsWith("-")) nonOpt.push(a);
    }
    if (ALL_ARGS_WRITE.has(program)) for (const a of nonOpt) targets.add(a);
    if (LAST_ARG_WRITE.has(program) && nonOpt.length >= 2) targets.add(nonOpt[nonOpt.length - 1]);
  }
  return [...targets].filter((t) => t !== "" && t !== "-" && !t.startsWith("&"));
}
