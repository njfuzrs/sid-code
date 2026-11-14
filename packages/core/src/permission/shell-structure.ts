/**
 * shell 命令的结构化拆分：heredoc 剥离 + 管道分组。
 *
 * ## 为什么需要它
 *
 * `shell-parser.ts` 的 `splitCompoundCommand` 只返回**扁平**的子命令列表，且把换行
 * 一律当作命令分隔符。两个后果都在危险命令检测里变成了真 bug（2026-10-26 实测）：
 *
 * 1. **heredoc 正文被当成命令**。`cat > notes.md <<'EOF'`⏎`rm -rf / is dangerous`⏎`EOF`
 *    会拆出 `{ program: "rm", args: ["-rf", "/"] }`，于是一段文档正文被判成 critical
 *    硬拒（无出口）。正文是**数据**，是否当代码取决于接收者：`bash <<EOF` 才是脚本。
 * 2. **管道关系丢失**。`curl x | sh` 拆成 `["curl x", "sh"]` 后就分不清「这两段是同一个
 *    管道」还是「两条顺序执行的命令」，而「下载并执行」正是关于管道结构的判断。
 *
 * 本模块提供 `splitCommandStructure`（按管道分组）。扁平拆分仍由 `splitCompoundCommand`
 * 提供，它内部复用 heredoc 剥离。
 *
 * ## heredoc 剥离为什么搬走了
 *
 * 2026-11-11 起 `extractHeredocBlocks` 的实现住在 `tool/bash/heredoc.ts`——bash 解析器
 * 也必须先剥离正文再拆命令，而从 `tool/bash/` 反向 import `permission/` 会形成目录级双向
 * 依赖（`bash-security.ts` 已经 import 了 `tool/bash/parser.ts`）。**这里是 re-export，
 * 符号名与签名不变**，既有消费者零改动。
 *
 * ## 分隔符口径必须与 `splitCompoundCommand` 完全一致
 *
 * 两份实现共用一个事实源：`splitCommandStructure` 的拆分口径就是 `splitCompoundCommand`
 * 的口径，只是多保留了「哪几段属于同一管道」。测试 `shell-parser.test.ts` 里有一条
 * 「扁平结果与 splitCommandStructure 一致」的一致性断言，改一处漏另一处会红。
 */

import { extractHeredocBlocks } from "../tool/bash/heredoc.ts";

// re-export：符号名与签名不变，既有消费者（bash-security / shell-parser /
// shell-command-variants）零改动。实现在 tool/bash/heredoc.ts，理由见文件头注释。
export { extractHeredocBlocks } from "../tool/bash/heredoc.ts";
export type { HeredocBlock, HeredocExtraction } from "../tool/bash/heredoc.ts";

/** 管道的分隔符类型：`|` 连接同一管道的两段，其余分隔符开启新管道 */
type BoundaryKind = "pipe" | "break";

/**
 * 开启新管道的分隔符。第一条管道为 `"start"`。
 *
 * 为什么把类型细化到这一层（B3）：`cd <工作区> && git log` 与 `cd <工作区> ; git log`
 * 的语义不同——`&&` 后 cd 失败整条链就停了，而 `;` 后 cd 失败仍会在**原目录**继续跑。
 * 只读判定必须能看见这个差别，否则 `cd 不存在; git log` 会被当成「在目标目录里跑」放行。
 * `break` 粗粒度保留在 {@link BoundaryKind} 里是给状态机内部用的，对外这一层要能区分。
 */
export type PipelineBoundary = "start" | "&&" | "||" | ";" | "&" | "\n";

/** 一条管道：`a | b | c` 的 stages 是 `["a", "b", "c"]` */
export interface CommandPipeline {
  stages: string[];
  /** 本管道**前面**的分隔符（第一条为 `"start"`）。`|` 不开启新管道，不出现在这里。 */
  boundary: PipelineBoundary;
}

/**
 * 按「管道」分组拆分复合命令。
 *
 * 分隔符口径与 splitCompoundCommand 完全一致（后者就是本函数的扁平化），差别只在归类：
 * `|` 是同一管道的下一段，`&&` / `||` / `;` / 后台 `&` / 换行开启新管道。
 *
 * 为什么后台 & 和换行必须算分隔符：权限规则匹配是逐子命令做的
 * （checker.ts checkDenyRules/checkAllowRules），而 minimatch 的 `*` 不跨分隔符
 * 只在「整条被拆开」的前提下成立。漏拆时 `allow: ["Bash(ls *)"]` 会把
 * `ls & rm -rf dir` 整条吞掉放行，`deny: ["Bash(curl *)"]` 也拦不住
 * `ls &\ncurl evil.com`。对齐 CC splitCommand 把 & 与换行都当分隔符。
 *
 * 两个容易误拆的形态要排除：
 * - `&>` / `&>>` 是「全部输出重定向」，`&` 后面紧跟 `>` 不是后台符。
 * - `2>&1` / `>&2` 这类 fd 复制里的 `&` 前面是数字或 `>`，不是命令边界。
 *
 * heredoc 正文在进入状态机前已被剥离（见 extractHeredocBlocks）：正文是数据，不是子命令。
 */
export function splitCommandStructure(cmd: string): CommandPipeline[] {
  const { stripped } = extractHeredocBlocks(cmd);
  const pipelines: string[][] = [];
  /** 与 pipelines 一一对应：该管道前面的分隔符 */
  const boundaries: PipelineBoundary[] = [];
  let stages: string[] = [];
  let current = "";
  /** 下一条管道的前置分隔符（尚未被某个管道消费） */
  let pendingBoundary: PipelineBoundary = "start";

  const emit = (kind: BoundaryKind, boundary: PipelineBoundary = "start") => {
    const trimmed = current.trim();
    if (trimmed) stages.push(trimmed);
    current = "";
    if (kind === "break" && stages.length > 0) {
      pipelines.push(stages);
      boundaries.push(pendingBoundary);
      stages = [];
      pendingBoundary = boundary;
    }
  };

  let i = 0;
  // 引号/转义状态
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  // 子 shell 嵌套深度：$(...) 和 (...)
  let parenDepth = 0;
  // 花括号嵌套深度：${...}
  let braceDepth = 0;

  while (i < stripped.length) {
    const ch = stripped[i];
    const next = i + 1 < stripped.length ? stripped[i + 1] : "";

    // 反斜杠转义：跳过下一个字符
    if (ch === "\\" && !inSingleQuote) {
      current += ch + next;
      i += 2;
      continue;
    }

    if (ch === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

    if (ch === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      current += ch;
      i++;
      continue;
    }

    // 在任何引号内，直接追加
    if (inSingleQuote || inDoubleQuote || inBacktick) {
      current += ch;
      i++;
      continue;
    }

    if (ch === "$" && next === "(") {
      parenDepth++;
      current += ch + next;
      i += 2;
      continue;
    }

    if (ch === "$" && next === "{") {
      braceDepth++;
      current += ch + next;
      i += 2;
      continue;
    }

    if (ch === "(") {
      parenDepth++;
      current += ch;
      i++;
      continue;
    }

    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      current += ch;
      i++;
      continue;
    }

    if (ch === "}") {
      if (braceDepth > 0) braceDepth--;
      current += ch;
      i++;
      continue;
    }

    // 在子 shell 或变量展开内，不拆分
    if (parenDepth > 0 || braceDepth > 0) {
      current += ch;
      i++;
      continue;
    }

    if (ch === "&" && next === "&") {
      emit("break", "&&");
      i += 2;
      continue;
    }

    if (ch === "|" && next === "|") {
      emit("break", "||");
      i += 2;
      continue;
    }

    // 单管道：同一管道的下一段
    if (ch === "|") {
      emit("pipe");
      i++;
      continue;
    }

    if (ch === ";") {
      emit("break", ";");
      i++;
      continue;
    }

    // 后台 &（`&&` 已在上面处理）。`&>` / `&>>` 是输出重定向，
    // N>&M / >&N 是 fd 复制，都不能当命令边界。
    // 必须看「前一个字符」而不是「前一个非空白字符」：2>&1 & other 里第二个 &
    // 前面是空格，它是真后台符；若跳过空白去看，会看到 1 而把它误判成 fd 复制。
    if (ch === "&" && next !== ">") {
      const prevCh = i > 0 ? stripped[i - 1] : "";
      const prevIsDigit = prevCh >= "0" && prevCh <= "9";
      if (!prevIsDigit && prevCh !== ">") {
        emit("break", "&");
        i++;
        continue;
      }
    }

    // 换行：shell 里等价于 `;`。引号 / 子 shell 内的换行已在上面被原样保留。
    if (ch === "\n") {
      emit("break", "\n");
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  emit("break");
  return pipelines.map((s, idx) => ({ stages: s, boundary: boundaries[idx] ?? "start" }));
}

/**
 * 这个程序名是不是「会把 stdin 当代码执行」的解释器。
 *
 * heredoc 的接收者判定要用它：`bash <<EOF` 的正文是脚本（要递归判危险），
 * `cat > f <<EOF` 的正文是数据（不参与匹配）。
 */
const SHELL_LIKE_PROGRAMS =
  /^(sh|bash|zsh|dash|ksh|fish|ash|mksh|python[23]?(\.\d+)?|perl|ruby|node|nodejs)$/;

export function isShellLikeProgram(program: string): boolean {
  return SHELL_LIKE_PROGRAMS.test(program);
}
