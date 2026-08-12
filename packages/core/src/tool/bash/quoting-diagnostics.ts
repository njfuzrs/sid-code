/**
 * Shell 命令引号畸形诊断（中文/多行/特殊字符场景）
 *
 * 背景（实测坐实的根因）：
 *   模型在 `command` 字符串里手写 shell 引号执行 `git commit -m "..."` 一类命令时，
 *   若 message 内层含**未转义的引号**（如中文语境下常见的 `从"对齐 CC"升级为"实测"`），
 *   外层 `"..."` 会被内层引号提前闭合，剩余内容被 shell 拆成独立参数/命令，
 *   典型报错：退出码 127 + `command not found` / `路径规格 'xxx' 未匹配任何 Git 已知文件`。
 *
 *   注意：这**不是** eval 二次解析导致（已实测：直接 `zsh -c` 与 `eval '...'` 结果一致），
 *   也**不是**全角标点导致（全角 `（）「」` 对 shell 无特殊含义，实测正常）。
 *   真正的元凶就是「模型手写引号 + 内层引号未转义」。改 eval 或 escape 都无效——
 *   命令进 bash 工具时已经是畸形字符串，任何 shell 拿到都会炸。
 *
 * 正解是**引导模型换安全写法**：含引号/多行/特殊字符的内容不要塞进 `-m "..."`，
 *   改用 heredoc + stdin（`git commit -F - << 'EOF' ... EOF`）——heredoc 内的引号、
 *   全角标点、多行都按字面量处理，实测可稳健通过。
 *
 * 本模块负责：命令失败时**识别是否疑似引号畸形**，是则在错误输出后附一段针对性引导，
 *   把模型从"原样重发→再次失败"的死循环里拉出来。纯启发式，只在失败路径调用，
 *   不影响成功命令。
 */

/**
 * 判断一条命令是否**疑似**因引号畸形而失败。
 *
 * 判据（需同时满足，降低误报）：
 *   1. 原命令里出现了「引号包裹的长文本」特征：含 `-m "` / `-m '` 或 `-F` 之外的
 *      内联双引号，且命令体较长 / 含换行。
 *   2. 且失败信号符合 shell 拆词特征：退出码 127（command not found），
 *      或 stderr 含 "command not found" / "未匹配" / "not found" / "unexpected"。
 *
 * @param command 原始命令字符串
 * @param exitCode 进程退出码
 * @param output 命令的合并输出（stdout+stderr，已截断）
 */
export function looksLikeQuotingBreakage(
  command: string,
  exitCode: number,
  output: string,
): boolean {
  // 失败信号：退出码 127，或输出含典型的 shell 拆词报错。
  const shellSplitSignal =
    exitCode === 127 ||
    /command not found|未找到命令|not found|unexpected (?:token|EOF|end)|未匹配任何|did not match|unmatched|quote>|dquote>/i.test(
      output,
    );
  if (!shellSplitSignal) return false;

  // 命令特征：内联引号 + 真正的「引号畸形信号」（不平衡 或 内层嵌套）。
  // 只有"手写引号包长文本且引号写坏"才有此风险；简单命令（cd/ls/git status）不命中。
  const hasInlineQuote = /["']/.test(command);
  if (!hasInlineQuote) return false;

  // 引号是否不平衡：双引号或单引号总数为奇数 → 必然有一个引号未闭合，
  // 会吞掉后续内容直到下一个引号或行尾，是最强的畸形信号。
  const doubleQuoteCount = (command.match(/"/g) || []).length;
  const singleQuoteCount = (command.match(/'/g) || []).length;
  const unbalancedQuotes = doubleQuoteCount % 2 === 1 || singleQuoteCount % 2 === 1;

  // 疑似内层同类引号嵌套：`-m "..."..."` 这种外层引号被内层提前闭合
  // （即本次事故的形态：-m "text"更多text"more"）。
  const nestedQuoteHint = /-m\s+"[^"]*"[^"]*"/.test(command) || /-m\s+'[^']*'[^']*'/.test(command);

  // 判定：只有出现真正的畸形信号（不平衡 / 嵌套）才命中。
  // 注意：多行本身**不是**判据——合法的多行命令（如正常 heredoc、多行脚本）引号是平衡的，
  // 不该被误判。只有当多行命令同时引号不平衡/嵌套时，才由上面两个信号命中。
  return unbalancedQuotes || nestedQuoteHint;
}

/**
 * 生成针对引号畸形的引导文案。附在失败输出之后，教模型换 heredoc 写法。
 *
 * 关键：给出**可直接照抄的正确写法**，而不是空泛地说"注意转义"。
 * 弱模型只会原样重发，必须给它一个确定性的替代模板。
 */
export function quotingBreakageHint(command: string): string {
  // 粗略识别是不是 git commit，是的话给最贴切的 heredoc 模板。
  const isGitCommit = /\bgit\s+commit\b/.test(command);

  if (isGitCommit) {
    return [
      "",
      '⚠️ 命令疑似因引号未转义而被 shell 拆断——commit message 里的引号/多行内容把外层 -m "..." 提前闭合了。',
      "不要原样重发，改用 heredoc 从 stdin 读取（引号、中文标点、多行都按字面量处理，最稳）：",
      "",
      "git commit -F - << 'SIDEOF'",
      "<在这里粘贴完整 commit message，可含任意引号/中文/多行，无需转义>",
      "SIDEOF",
      "",
      "注意 EOF 定界符用单引号包裹（<< 'SIDEOF'），可禁用 $ 和反引号展开，内容完全按字面量。",
    ].join("\n");
  }

  return [
    "",
    "⚠️ 命令疑似因引号未转义而被 shell 拆断（内层引号提前闭合了外层引号）。",
    "不要原样重发。含引号/多行/特殊字符的长文本，改用 heredoc 从 stdin 传入，避免手写引号转义：",
    "",
    "<命令> << 'SIDEOF'",
    "<在这里粘贴完整内容，可含任意引号/中文/多行，无需转义>",
    "SIDEOF",
    "",
    "或：把内容用 write 工具写到临时文件，再让命令从文件读取（如 git commit -F <文件>）。",
  ].join("\n");
}
