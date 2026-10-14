/**
 * 家目录前缀替换（数据主权整改 PR-B，P1-7 / P1-8）
 *
 * 上传的轨迹带 `working_directory` 等绝对路径，家目录前缀里就是本机用户名。
 * 这里只把**家目录前缀**换成 `~`，保留其后的相对路径结构：
 *   - 不做 hash：`file_path` / `command` 里的路径是评测分歧分析的核心字段，hash 后两臂不可比；
 *     平台侧 `distill-skill-rules.ts` 按 `working_directory` 是否含 `sid-code` 推断来源仓库，
 *     前缀替换不影响它，hash 会；
 *   - 只用于**外发侧**（上传 / OTLP），本地落盘不动——本地轨迹要能直接复制路径去打开文件；
 *   - 默认关：会改变平台按项目 / 用户的聚合口径，默认值要先与平台侧对齐再定。
 *
 * 需同时覆盖 JSON 转义形态：Windows 的 `C:\Users\x` 在 JSON 文本里是 `C:\\Users\\x`。
 */

import { homedir } from "node:os";

/** 正则转义 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把文本中的家目录前缀替换为 `~`。
 *
 * 左右边界都要卡住：右侧必须是路径分隔符 / 引号 / 空白 / 结尾，
 * 否则 `/Users/alice` 会误改 `/Users/alice2/...`；左侧不能紧贴路径字符，
 * 否则 `/data/Users/alice` 这类恰好包含同名片段的路径也会被改。
 *
 * @param text 任意文本（通常是 JSON / JSONL）
 * @param home 家目录，缺省取 os.homedir()；测试注入用
 */
export function redactHomeDir(text: string, home: string = homedir()): string {
  const h = home.replace(/[\\/]+$/, "");
  // 家目录过短（`/`、空串、`C:`）时替换会把整棵树都改掉，宁可不做
  if (h.length < 3) return text;

  const forms = new Set<string>([h]);
  if (h.includes("\\")) forms.add(h.replace(/\\/g, "\\\\")); // JSON 转义形态
  let out = text;
  for (const f of forms) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_.\\-/\\\\])${escapeRe(f)}(?=[\\\\/"'\\s:,;)\\]}]|$)`,
      "g",
    );
    out = out.replace(re, "~");
  }
  return out;
}
