/**
 * 命令退出码语义解释（对标 claude-code commandSemantics.ts）
 *
 * 很多命令用退出码传递"信息"而非"失败"：
 *   - grep/rg 退出码 1 = 无匹配（正常）
 *   - diff 退出码 1 = 文件有差异（正常）
 *   - find 退出码 1 = 部分目录不可访问（部分成功）
 *   - test/[ 退出码 1 = 条件为假（正常）
 *
 * 旧实现（bash.ts）一刀切 `exitCode !== 0 → isError`，导致这些命令被误标为失败，
 * 对模型是噪声并诱导无谓重试。此模块按命令语义精确判定。
 */

import { parseBashCommand, extractSimpleCommands } from "./parser.ts";

export interface CommandResultInterpretation {
  /** 是否真正视为错误 */
  isError: boolean;
  /** 非错误但有特殊语义时的提示信息（如 "无匹配"），供输出附注 */
  message?: string;
}

type CommandSemantic = (exitCode: number) => CommandResultInterpretation;

/** 默认语义：仅退出码 0 为成功 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode) => ({
  isError: exitCode !== 0,
});

/** grep/rg 语义：0=有匹配，1=无匹配（非错误），≥2=真错误 */
const GREP_SEMANTIC: CommandSemantic = (exitCode) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? "无匹配" : undefined,
});

/** 命令专属语义表 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  ["grep", GREP_SEMANTIC],
  ["egrep", GREP_SEMANTIC],
  ["fgrep", GREP_SEMANTIC],
  ["rg", GREP_SEMANTIC],
  ["ag", GREP_SEMANTIC],
  // find：0=成功，1=部分目录不可访问（部分成功），≥2=真错误
  [
    "find",
    (exitCode) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? "部分目录不可访问" : undefined,
    }),
  ],
  // diff：0=无差异，1=有差异（非错误），≥2=真错误
  [
    "diff",
    (exitCode) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? "文件存在差异" : undefined,
    }),
  ],
  // test / [：0=条件为真，1=条件为假（非错误），≥2=真错误
  [
    "test",
    (exitCode) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? "条件为假" : undefined,
    }),
  ],
  [
    "[",
    (exitCode) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? "条件为假" : undefined,
    }),
  ],
]);

/**
 * 提取决定整条命令退出码的"最后一个简单命令"的命令名。
 *
 * 管道/逻辑连接符下，退出码由最后一个命令决定（不考虑 pipefail —— 与 claude-code
 * 一致，采用启发式，不用于安全判断）。解析失败时回退取首词。
 */
function extractExitCodeCommand(command: string): string {
  try {
    const ast = parseBashCommand(command);
    const simpleCommands = extractSimpleCommands(ast);
    if (simpleCommands.length > 0) {
      const last = simpleCommands[simpleCommands.length - 1];
      if (last?.command) return last.command;
    }
  } catch {
    /* 解析失败，回退 */
  }
  // 回退：取整条命令首词
  return command.trim().split(/\s+/)[0] || "";
}

/**
 * 按命令语义解释退出码。
 *
 * @param command 原始命令字符串
 * @param exitCode 进程退出码
 * @returns isError（是否真错误）+ 可选 message（非错误的语义提示）
 */
export function interpretExitCode(command: string, exitCode: number): CommandResultInterpretation {
  const baseCommand = extractExitCodeCommand(command);
  const semantic = COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC;
  return semantic(exitCode);
}
