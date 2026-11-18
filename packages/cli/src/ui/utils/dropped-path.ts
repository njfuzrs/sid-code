/**
 * 还原终端拖拽文件路径的 shell 转义（`&` → `\&`、空格 → `\ `、整条路径加引号）。
 *
 * 背景：从 Finder 拖文件进输入框时，终端给的是**经过 shell 转义**的路径
 * （`/Users/x/16-Workflow\&Schedule/a.md`、`'/Volumes/My Disk/a.md'`），
 * 模型拿到这串字面量会照字面处理，找不到文件。
 *
 * 判据（四条全满足才替换，其余原样返回）：
 *   1. 单行——多行是代码块/粘贴正文，不是拖拽路径；
 *   2. 「去成对引号」或「反转义」至少有一项真的生效；
 *   3. 还原结果以路径前缀（`/`、`./`、`../`）开头——`echo a \& b` 这类 shell
 *      片段在 stat 之前就短路；
 *   4. 还原结果在文件系统里真实存在（existsSync）——防误伤的核心闸门。
 *
 * ⚠️ 判据 2 必须拿**原文 trim 后的串**比较，不能拿「去引号之后」的串比较。
 * 终端对「有引号但内部无转义字符」的路径（如 `'/Volumes/My Disk/a.md'`，空格在
 * 引号内不需要反斜杠）只给引号，此时 `unescaped === s` 成立、会早退，引号永远去不掉。
 *
 * 为什么不无条件反转义：用户粘贴的 shell 片段（`echo a \& b`）与 Windows
 * 路径（`C:\new`）里的反斜杠有本义，无条件还原会把它们改坏。
 *
 * @param exists 注入点（测试用），缺省用 node:fs 的 existsSync
 */
import { existsSync } from "node:fs";

/**
 * shell 会要求转义的特殊字符集。
 *
 * 只收 shell 里有特殊含义的字符，**不收** `n` / `t` / `P` 这类普通字母——
 * 否则 `C:\new\test` 会被还原成 `C:` + 换行 + `ew...`（Windows 路径负向对照）。
 */
const SHELL_SPECIALS = " &()[]{}!$'\"`;|<>*?~#\\";

/** 拖拽给的是绝对路径；`./` `../` 是手工输入的相对路径形态 */
const PATH_PREFIXES = ["/", "./", "../"] as const;

export function unescapeDroppedPath(
  text: string,
  exists: (p: string) => boolean = existsSync,
): string {
  // ① 多行粘贴是代码块/正文，不是拖拽路径
  if (text.includes("\n")) return text;

  const trimmed = text.trim();
  let s = trimmed;
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' || first === "'") && first === last) s = s.slice(1, -1);
  }

  // 反转义：只还原「反斜杠 + shell 特殊字符」这一确定形态。
  // 用字符集判定而不是内联字符类，避免 `[` `]` 在字符类里的转义歧义。
  const unescaped = s.replace(/\\(.)/g, (match, ch: string) =>
    SHELL_SPECIALS.includes(ch) ? ch : match,
  );

  // ② 两项都没生效 → 原样返回。比较对象是 trimmed（不是 s），
  //    否则「只有引号、内部无转义」的路径在这里早退，引号留给了模型。
  if (unescaped === trimmed) return text;

  // ③ shell 片段（`echo a \& b`、`grep a\&b`）不以路径前缀开头，stat 之前短路
  if (!PATH_PREFIXES.some((prefix) => unescaped.startsWith(prefix))) return text;

  // ④ 还原结果必须真实存在：不在磁盘上的路径宁可留着转义形态让用户手动处理，
  //    也不能凭猜测改用户内容（L4-A：不静默丢/改用户输入）
  if (!exists(unescaped)) return text;

  // ⑤ 命中：保留原文首尾空白——cleanPasteText 不 trim，原 insert 分支也不 trim，
  //    这里不补回去就等于凭这个函数引入了「粘贴被 trim」的新语义
  const lead = /^\s*/.exec(text)![0];
  const trail = /\s*$/.exec(text)![0];
  return lead + unescaped + trail;
}
