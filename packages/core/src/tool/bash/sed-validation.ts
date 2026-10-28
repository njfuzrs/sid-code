/**
 * sed 写操作检测 + 危险 sed 命令拦截
 *
 * 对标 claude-code sedValidation.ts checkSedConstraints：把 `sed -i` 当**文件写入**做
 * 权限门（非 acceptEdits 一律经路径校验），并对 sed 表达式中的执行/写文件标志
 * （`s///e` 执行 shell、`w file` / `s///w file` 写任意文件）做 denylist 拦截。
 */

import { parseBashCommand, extractSimpleCommands, type BashASTNode } from "./parser.ts";

/**
 * sed 写操作检测结果
 */
export interface SedWriteInfo {
  isSedWrite: boolean;
  targetFile?: string;
  editDescription?: string;
}

/**
 * 检测 sed 写操作并提取编辑信息
 *
 * 匹配模式：
 * - sed -i 's/old/new/g' file.txt
 * - sed -i.bak 's/old/new/' file.txt
 * - sed --in-place 's/old/new/' file.txt
 */
export function detectSedWrite(command: string): SedWriteInfo {
  // 匹配 sed -i 或 sed --in-place
  const sedMatch = command.match(
    /sed\s+(-i\S*|--in-place\S*)\s+(['"]?)s\/(.+?)\/(.+?)\/(g?)\2\s+(\S+)/,
  );

  if (!sedMatch) {
    // 尝试更宽松的匹配（sed -i 后跟任意表达式）
    const looseMatch = command.match(/sed\s+(-i\S*|--in-place\S*)\s+.+?\s+(\S+)\s*$/);
    if (looseMatch) {
      return {
        isSedWrite: true,
        targetFile: looseMatch[2],
        editDescription: "sed 就地编辑",
      };
    }
    return { isSedWrite: false };
  }

  return {
    isSedWrite: true,
    targetFile: sedMatch[6],
    editDescription: `将 "${sedMatch[3]}" 替换为 "${sedMatch[4]}"${sedMatch[5] ? "（全局）" : ""}`,
  };
}

/** 危险 sed 命令检测结果 */
export interface DangerousSedInfo {
  /** 是否命中危险标志 */
  dangerous: boolean;
  /** 命中的原因（用于权限对话框展示） */
  reason?: string;
}

/**
 * 检测 sed 表达式中的危险执行/写文件标志。
 *
 * sed 脚本可通过以下方式突破"只做文本替换"的预期，执行任意 shell 或写任意文件：
 * - `s/pattern/repl/e`：GNU sed 扩展，把替换结果作为 shell 命令执行
 * - `e command` / 裸 `e`：执行外部命令（裸 `e` 执行模式空间本身）
 * - `w filename` / `W filename`：把匹配行写入任意文件
 * - `s/pattern/repl/w filename`：替换后把行写入任意文件
 * - `r filename` / `R filename`：读取任意文件内容插入（信息泄露）
 * - `-f script.sed`：脚本来自文件，内容无法静态检查
 *
 * ## 只扫脚本参数，不扫整条命令（Q2）
 *
 * 修前「先用 AST 确认有 sed，再对**整条命令**跑正则」：`sed -n 1p tests/tool/bash-stability.test.ts`
 * 里的路径 `s.t.a.b.i.l.i.t.y` 能凑出 `s<c>…<c>…<c>e`，被当成 `s///e` 拒掉；
 * `sed -n 1p a; echo; sed -n 2p loop.ts` 也会跨段命中。现在逐个 sed 调用抽出脚本串
 * （`-e` / `--expression` 的值，没有 `-e` 时取第一个非选项参数），正则只作用在脚本上。
 *
 * 独立 `e`/`w`/`r` 命令的锚点同时扩到「地址之后」（`1e`、`$w f`、`/re/r f`）与
 * 「整段脚本就是 `e`」——修前要求前面是引号或分号，这几种形态全部放行（N6）。
 *
 * 解析不了（AST 里有 unknown 节点且原文像 sed）→ 回退到整条命令正则，宁严勿松。
 */
export function detectDangerousSed(command: string): DangerousSedInfo {
  let invocations: string[][];
  try {
    const ast = parseBashCommand(command);
    if (hasUnknownNode(ast) && SED_LITERAL_RE.test(command)) {
      return detectDangerousSedLegacy(command);
    }
    invocations = extractSimpleCommands(ast)
      .filter(({ command: cmd }) => cmd === "sed" || cmd === "gsed")
      .map(({ args }) => args);
  } catch {
    // 解析失败时回退到字面量检测（宁严勿松）
    return SED_LITERAL_RE.test(command) ? detectDangerousSedLegacy(command) : { dangerous: false };
  }

  for (const args of invocations) {
    const { scripts, scriptFromFile } = extractSedScripts(args);
    if (scriptFromFile) {
      return { dangerous: true, reason: "sed 脚本来自文件（-f），无法静态检查" };
    }
    for (const script of scripts) {
      const finding = checkSedScript(script);
      if (finding) return finding;
    }
  }
  return { dangerous: false };
}

const SED_LITERAL_RE = /(^|[\s;&|(])g?sed\s/;

function hasUnknownNode(node: BashASTNode): boolean {
  switch (node.type) {
    case "unknown":
      return true;
    case "pipeline":
    case "sequence":
      return node.commands.some(hasUnknownNode);
    case "redirect":
      return hasUnknownNode(node.target);
    default:
      return false;
  }
}

/** sed 的带值短选项（值可紧贴或在下一个 token）；`-i` 的后缀只能紧贴，单独处理 */
const SED_SHORT_VALUE = new Set(["e", "f", "l"]);
const SED_LONG_VALUE = new Set(["--expression", "--file", "--line-length"]);

/**
 * 从一个 sed 调用的参数里抽出脚本串。
 * `-e` / `--expression` 可出现多次；都没有时第一个非选项参数是脚本，其余是文件。
 */
export function extractSedScripts(args: string[]): { scripts: string[]; scriptFromFile: boolean } {
  const scripts: string[] = [];
  const positional: string[] = [];
  let scriptFromFile = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (!SED_LONG_VALUE.has(name)) continue;
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (name === "--file") scriptFromFile = true;
      else if (name === "--expression" && value !== undefined) scripts.push(value);
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        // -i[SUFFIX]：后缀只能紧贴，剩余字符都是后缀
        if (c === "i") break;
        if (!SED_SHORT_VALUE.has(c)) continue;
        const value = k + 1 < a.length ? a.slice(k + 1) : args[++i];
        if (c === "f") scriptFromFile = true;
        else if (c === "e" && value !== undefined) scripts.push(value);
        break;
      }
      continue;
    }
    positional.push(a);
  }
  if (scripts.length === 0 && positional.length > 0) scripts.push(positional[0]);
  return { scripts, scriptFromFile };
}

/**
 * sed 地址：行号（含 first~step）、`$`、`/re/`（可带 I/M），可选 `,addr2` 或 `,+N` / `,~N`。
 * 已知缺口：自定义分隔符地址 `\cREc` 不认，`\%x%e` 这种写法会漏（修前同样漏）。
 */
const SED_ADDR1 = String.raw`(?:\d+(?:~\d+)?|\$|/(?:\\.|[^/\n])*/[IM]*)`;
const SED_ADDR = String.raw`(?:${SED_ADDR1}(?:\s*,\s*(?:${SED_ADDR1}|[+~]\d+))?)`;
/** 命令起点：脚本开头、`;`、换行、`{`、`}` 之后，可带地址与 `!` */
const SED_CMD_PREFIX = String.raw`(?:^|[;\n{}])\s*(?:${SED_ADDR})?\s*!?\s*`;
const SED_EXEC_RE = new RegExp(`${SED_CMD_PREFIX}e(?=\\s|;|}|$)`);
const SED_WRITE_RE = new RegExp(`${SED_CMD_PREFIX}[wW]\\s*\\S`);
const SED_READ_RE = new RegExp(`${SED_CMD_PREFIX}[rR]\\s*\\S`);

/** 对单个 sed 脚本串做危险检测 */
function checkSedScript(script: string): DangerousSedInfo | null {
  if (SED_SUBST_EXEC_RE.test(script)) {
    return { dangerous: true, reason: "sed s///e 标志会将替换结果作为 shell 命令执行" };
  }
  if (SED_SUBST_WRITE_RE.test(script)) {
    return { dangerous: true, reason: "sed s///w 标志会将匹配行写入任意文件" };
  }
  if (SED_EXEC_RE.test(script)) {
    return { dangerous: true, reason: "sed e 命令会执行外部 shell 命令" };
  }
  if (SED_WRITE_RE.test(script)) {
    return { dangerous: true, reason: "sed w/W 命令会将行写入任意文件" };
  }
  if (SED_READ_RE.test(script)) {
    return { dangerous: true, reason: "sed r/R 命令会读取任意文件内容" };
  }
  return null;
}

// s<分隔符>...<分隔符>...<分隔符> 后紧跟含 e / w 的标志段；反向引用保证三段同一分隔符
const SED_SUBST_EXEC_RE = /\bs(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-z]*e[a-z]*/i;
const SED_SUBST_WRITE_RE = /\bs(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-z]*w[a-z]*\s/i;

/**
 * 修前的整条命令正则，只在 AST 解析不了时作为回退（宁严勿松）。
 * 它会误报（路径里的 `s.t.a.b.i.l.i.t.y`），所以不能当主判据。
 */
function detectDangerousSedLegacy(command: string): DangerousSedInfo {
  if (SED_SUBST_EXEC_RE.test(command)) {
    return { dangerous: true, reason: "sed s///e 标志会将替换结果作为 shell 命令执行" };
  }
  if (SED_SUBST_WRITE_RE.test(command)) {
    return { dangerous: true, reason: "sed s///w 标志会将匹配行写入任意文件" };
  }
  if (/(?:^|['";\n{])\s*e\s+\S/.test(command) && hasSedExprContext(command)) {
    return { dangerous: true, reason: "sed e 命令会执行外部 shell 命令" };
  }
  if (/(?:^|['";\n{])\s*[wW]\s+\S/.test(command) && hasSedExprContext(command)) {
    return { dangerous: true, reason: "sed w/W 命令会将行写入任意文件" };
  }
  if (/(?:^|['";\n{])\s*[rR]\s+\S/.test(command) && hasSedExprContext(command)) {
    return { dangerous: true, reason: "sed r/R 命令会读取任意文件内容" };
  }
  return { dangerous: false };
}

/**
 * 粗略判断命令是否含 sed 表达式上下文（带引号脚本或 -e）。
 * 用于降低回退分支里独立 e/w/r 命令检测的误报——只在明显是 sed 脚本时才拦。
 */
function hasSedExprContext(command: string): boolean {
  return (
    /g?sed\s+(-[a-z]*e|--expression|['"])/i.test(command) || /g?sed\s+[^|;&]*['"]/.test(command)
  );
}
