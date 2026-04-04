/**
 * Bash 命令路径校验
 * 从命令中提取文件路径并校验写入安全性
 */

import { parseBashCommand, extractSimpleCommands, extractRedirectTargets } from "./parser.ts";

/** 写入命令及其目标参数位置 */
const WRITE_COMMANDS: Record<string, { targetArgIndex: number | "last" }> = {
  cp: { targetArgIndex: "last" },
  mv: { targetArgIndex: "last" },
  rm: { targetArgIndex: 1 },
  mkdir: { targetArgIndex: 1 },
  rmdir: { targetArgIndex: 1 },
  touch: { targetArgIndex: 1 },
  chmod: { targetArgIndex: "last" },
  chown: { targetArgIndex: "last" },
};

/** 提取的路径信息 */
export interface ExtractedPath {
  path: string;
  isWrite: boolean;
}

/**
 * 从 Bash 命令中提取所有文件路径
 */
export function extractPathsFromCommand(command: string): ExtractedPath[] {
  const paths: ExtractedPath[] = [];
  const ast = parseBashCommand(command);

  // 1. 重定向目标（写入）
  for (const target of extractRedirectTargets(ast)) {
    paths.push({ path: target, isWrite: true });
  }

  // 2. 写入命令的目标参数
  for (const { command: cmd, args } of extractSimpleCommands(ast)) {
    const spec = WRITE_COMMANDS[cmd];
    if (!spec) continue;

    // 过滤掉选项参数（以 - 开头）
    const nonOptionArgs = args.filter(a => !a.startsWith("-"));
    if (nonOptionArgs.length === 0) continue;

    if (spec.targetArgIndex === "last") {
      paths.push({ path: nonOptionArgs[nonOptionArgs.length - 1], isWrite: true });
    } else if (spec.targetArgIndex < nonOptionArgs.length) {
      // rm/mkdir/touch 等：所有非选项参数都是目标
      for (const arg of nonOptionArgs) {
        paths.push({ path: arg, isWrite: true });
      }
    }

    // sed -i 的目标文件
    if (cmd === "sed" && args.some(a => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
      // sed -i 的最后一个非选项参数是目标文件
      const lastNonOption = nonOptionArgs[nonOptionArgs.length - 1];
      if (lastNonOption && !lastNonOption.startsWith("s/") && !lastNonOption.startsWith("'") && !lastNonOption.startsWith('"')) {
        paths.push({ path: lastNonOption, isWrite: true });
      }
    }
  }

  return paths;
}
