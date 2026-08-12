/**
 * sed 写操作检测 + 危险 sed 命令拦截
 *
 * 对标 claude-code sedValidation.ts checkSedConstraints：把 `sed -i` 当**文件写入**做
 * 权限门（非 acceptEdits 一律经路径校验），并对 sed 表达式中的执行/写文件标志
 * （`s///e` 执行 shell、`w file` / `s///w file` 写任意文件）做 denylist 拦截。
 */

import { parseBashCommand, extractSimpleCommands } from "./parser.ts";

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
 * - `e command`：执行外部命令并把输出插入
 * - `w filename` / `W filename`：把匹配行写入任意文件
 * - `s/pattern/repl/w filename`：替换后把行写入任意文件
 * - `r filename` / `R filename`：读取任意文件内容插入（信息泄露）
 *
 * 这些标志无论是否带 `-i` 都危险（不带 -i 也能执行 shell / 写文件），
 * 故对所有含 sed 子命令的调用检查。对标 claude-code 的 sed denylist。
 *
 * 保守策略：正则匹配 sed 命令段中的这些标志。误报可接受（落到人工确认，不误放行）。
 */
export function detectDangerousSed(command: string): DangerousSedInfo {
  let hasSed = false;
  try {
    const ast = parseBashCommand(command);
    for (const { command: cmd } of extractSimpleCommands(ast)) {
      if (cmd === "sed" || cmd === "gsed") {
        hasSed = true;
        break;
      }
    }
  } catch {
    // 解析失败时回退到字面量检测（宁严勿松）
    hasSed = /(^|[\s;&|(])g?sed\s/.test(command);
  }

  if (!hasSed) return { dangerous: false };

  // s///e：替换结果作为 shell 命令执行（GNU 扩展）。
  // 匹配 s<分隔符>...<分隔符>...<分隔符> 后紧跟含 e 的标志段。
  // 分隔符常见为 /，也支持 | # , 等；用反向引用保证三段同一分隔符。
  if (/\bs(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-z]*e[a-z]*/i.test(command)) {
    return { dangerous: true, reason: "sed s///e 标志会将替换结果作为 shell 命令执行" };
  }

  // s///w file：替换后把行写入任意文件
  if (/\bs(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-z]*w[a-z]*\s/i.test(command)) {
    return { dangerous: true, reason: "sed s///w 标志会将匹配行写入任意文件" };
  }

  // 独立的 e / w / W / r / R 命令（sed 脚本内，通常出现在 -e 表达式或引号脚本里）。
  // 匹配形如 `e command`、`w file`、`r file`——前置为脚本起始/分号/换行/引号。
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
 * 用于降低独立 e/w/r 命令检测的误报——只在明显是 sed 脚本时才拦。
 */
function hasSedExprContext(command: string): boolean {
  return (
    /g?sed\s+(-[a-z]*e|--expression|['"])/i.test(command) || /g?sed\s+[^|;&]*['"]/.test(command)
  );
}
