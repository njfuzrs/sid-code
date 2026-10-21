/**
 * bash 输出剥离终端控制序列（20261020 会话评估发现 12）。
 *
 * 实测 3 次 `affected-tests:run` 的输出里夹着 bracketed paste（`ESC[?2004h/l`）、
 * OSC 9;4 进度、DCS 等序列，剥离后从 22,548 字符缩到 7,630 字符。模型看不到颜色、
 * 也用不上光标控制，这些字节只会占上下文、挤掉截断窗口里的真实内容。
 *
 * 剥离范围：CSI（含 SGR 颜色、私有模式 `?…h/l`、光标移动、清屏）、OSC、DCS/SOS/PM/APC、
 * 以及两字符的 Fe/Fp 转义（`ESC 7`、`ESC =` 等）。`\r` `\t` `\n` 不动 —— 它们是文本。
 *
 * ⚠️ 调用顺序：必须在 `isBinaryOutput` **之后**。二进制判定依赖控制字符密度，
 * 先剥会让一段真二进制看起来更「干净」。
 *
 * 只剥**结构完整**的序列：截断的序列、孤立 ESC 原样保留，真二进制里偶然出现的
 * `ESC [` 不会把后面的内容吞掉。
 */

// CSI：ESC [ 参数(0x30–0x3F)* 中间(0x20–0x2F)* 终止(0x40–0x7E)（ECMA-48 §5.4）
const CSI = String.raw`\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]`;
// OSC：ESC ] … 以 BEL 或 ST（ESC \）结束；正文不跨控制字符（防吞整段）
const OSC = String.raw`\x1b\][^\x00-\x08\x0a-\x1f]*?(?:\x07|\x1b\\)`;
// DCS / SOS / PM / APC：ESC P|X|^|_ … ST
const STRING_SEQ = String.raw`\x1b[PX^_][^\x1b]*?\x1b\\`;
// 两字符转义：ESC 后跟 0x30–0x7E 中除 [ ] P X ^ _ 之外的字节（如 ESC 7 / ESC 8 / ESC = / ESC >）
const TWO_CHAR = String.raw`\x1b[\x30-\x4f\x51-\x57\x59-\x5a\x5c\x60-\x7e]`;

const TERMINAL_CONTROL_RE = new RegExp(`${OSC}|${STRING_SEQ}|${CSI}|${TWO_CHAR}`, "g");

/** 剥掉文本里结构完整的终端控制序列；不含 ESC 时原样返回（快路径） */
export function stripTerminalControl(text: string): string {
  if (!text.includes("\x1b")) return text;
  return text.replace(TERMINAL_CONTROL_RE, "");
}
