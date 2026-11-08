/**
 * 命令退出码语义解释（对标 claude-code commandSemantics.ts）
 *
 * 很多命令用退出码传递"信息"而非"失败"：
 *   - grep/rg 退出码 1 = 无匹配（正常）
 *   - diff 退出码 1 = 文件有差异（正常）
 *   - find 退出码 1 = 部分目录不可访问（部分成功）
 *   - test/[ 退出码 1 = 条件为假（正常）
 *   - which / type / command -v 退出码 1 = 未找到命令（正常）
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
  /**
   * 放在结果**首行**的语义说明。
   *
   * 与 `message` 的区别是位置：`message` 追加在输出末尾当附注，适合「无匹配」这种
   * 读过正文才知道含义的场合；`header` 放在最前，适合「这个非 0 退出码不是坏消息」
   * 这种**必须先纠正模型判断**的场合——模型读结果的第一眼决定它要不要重试。
   *
   * 目前只有 `gh pr checks` 退出码 8（pending）用它：CI 未完成是等待中的正常状态，
   * 报成失败会诱导模型「换个办法再查」或去修一个不存在的缺陷（G8）。
   */
  header?: string;
}

/**
 * args 只给少数需要看子参数才能定语义的命令用（如 `command -v`），其余忽略即可。
 */
type CommandSemantic = (exitCode: number, args: string[]) => CommandResultInterpretation;

/** 默认语义：仅退出码 0 为成功 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode) => ({
  isError: exitCode !== 0,
});

/** grep/rg 语义：0=有匹配，1=无匹配（非错误），≥2=真错误 */
const GREP_SEMANTIC: CommandSemantic = (exitCode) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? "无匹配" : undefined,
});

/**
 * 命令查找语义（which / type / command -v）：0=找到，1=未找到（非错误），≥2=真错误。
 *
 * 为什么要收录（2026-10-09 轨迹 20261009-135641-0083c051 实测）：模型探测可选工具时
 * 常写 `mdls ... ; which exiftool tesseract`，`;` 串联取最后一段退出码，`which` 没找到
 * 返回 1，于是前面已成功拿到的输出整条被包成「命令执行失败（退出码 1）」。
 * 「没装这个工具」正是模型要的答案，不是故障，报成失败只会诱导无谓重试或改道。
 *
 * 这些命令找不到时输出里本来就写明了是哪个（`exiftool not found`），附注只需点明语义。
 */
const LOOKUP_SEMANTIC: CommandSemantic = (exitCode) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? "未找到命令" : undefined,
});

/**
 * gh 语义（E1）：只认 `gh pr checks`，退出码 8 = 有检查 pending（**不是**命令错误）。
 *
 * 依据 gh 2.97.0 的 `gh pr checks --help`：
 *
 * ```
 * Additional exit codes:
 * 	8: Checks pending
 * ```
 *
 * 这条说明由 `exit-code-semantics.test.ts` 的 T-E1-4 快照守着 —— gh 改语义时测试红，
 * 提示回头复核本表，而不是静默地把 pending 报成失败或反过来。
 *
 * 为什么退出码 1（有检查失败）**不**特殊处理：它确实该报错，模型需要知道 CI 红了。
 * 为什么只认 `pr checks` 不认 `gh pr view`：实测触发会话 `20261108-112620-7dd98bf5`
 * 里 44 条退出码 8 **全部**来自 `gh pr checks`，`gh pr view` 一次都没有（它不查 checks
 * 就不返回 8）。按想象扩表会让「哪些命令有这个退出码」失去轨迹依据。
 *
 * 匹配靠 `extractExitCodeCommand` 取**最后一个简单命令**，所以
 * `cd x && gh pr checks 1` 命中，`gh pr checks 1 | head`（退出码属于 head）不命中。
 */
const GH_SEMANTIC: CommandSemantic = (exitCode, args) => {
  if (args[0] === "pr" && args[1] === "checks" && exitCode === 8) {
    return {
      isError: false,
      header: "检查未全部完成（gh 退出码 8 = pending，不是命令错误）",
    };
  }
  return DEFAULT_SEMANTIC(exitCode, args);
};

/** 命令专属语义表 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  ["gh", GH_SEMANTIC],
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
  ["which", LOOKUP_SEMANTIC],
  ["type", LOOKUP_SEMANTIC],
  // `command` 只有带 -v / -V 才是查找；`command foo` 是绕过别名执行 foo，
  // 退出码属于 foo，必须走默认语义，否则会把 foo 的真失败吞成成功。
  [
    "command",
    (exitCode, args) =>
      args[0] === "-v" || args[0] === "-V"
        ? LOOKUP_SEMANTIC(exitCode, args)
        : DEFAULT_SEMANTIC(exitCode, args),
  ],
]);

/**
 * 提取决定整条命令退出码的"最后一个简单命令"（命令名 + 参数）。
 *
 * 管道/逻辑连接符下，退出码由最后一个命令决定（不考虑 pipefail —— 与 claude-code
 * 一致，采用启发式，不用于安全判断）。解析失败时回退取首词。
 */
function extractExitCodeCommand(command: string): { command: string; args: string[] } {
  try {
    const ast = parseBashCommand(command);
    const simpleCommands = extractSimpleCommands(ast);
    if (simpleCommands.length > 0) {
      const last = simpleCommands[simpleCommands.length - 1];
      if (last?.command) return { command: last.command, args: last.args };
    }
  } catch {
    /* 解析失败，回退 */
  }
  // 回退：按空白切词
  const words = command.trim().split(/\s+/);
  return { command: words[0] || "", args: words.slice(1) };
}

/**
 * 按命令语义解释退出码。
 *
 * @param command 原始命令字符串
 * @param exitCode 进程退出码
 * @returns isError（是否真错误）+ 可选 message（非错误的语义提示）
 */
export function interpretExitCode(command: string, exitCode: number): CommandResultInterpretation {
  const last = extractExitCodeCommand(command);
  const semantic = COMMAND_SEMANTICS.get(last.command) ?? DEFAULT_SEMANTIC;
  return semantic(exitCode, last.args);
}
