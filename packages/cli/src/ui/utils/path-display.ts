/**
 * 单行摘要的「显示化」与「按列宽收缩」纯函数集。
 *
 * 解决的问题（docs/_template/tui界面右侧空间没有被有效利用…）：工具 header 此前在**数据层**
 * 按固定 50 码点硬截断路径，导致两个毛病同时出现：
 *
 *   1. **右侧大片留白没被利用** —— 截断长度与终端宽度无关，120 列终端也只显示 50 列；
 *   2. **被砍掉的恰好是关键信息** —— 尾截断保住了 `/Users/xxx/Code/person/sid-code/` 这段
 *      对每一行都一样的噪音前缀，反而把唯一有区分度的文件名丢了：
 *      `⏺ read /Users/me/Code/person/sid-code/src/telemetry/cache-tel…`
 *
 * 职责划分（本文件是「怎么收缩」，不决定「收缩到多少」）：
 *
 *   - **数据层**（`ui-utils.ts` 的 `getToolSummary`）：调 `shortenPathForDisplay` 去掉与
 *     宽度无关的**语义噪音**（cwd 前缀 / home 前缀）。这一步不看终端宽度，纯粹是"同一个
 *     路径的更短等价写法"。
 *   - **视图层**（`ToolShared.tsx` 的 `ToolInfo`）：拿到真实可用列宽后调 `fitPathToWidth` /
 *     `fitTextToWidth` 收缩到刚好放得下。宽终端就多显示，窄终端才开始省略。
 *
 * 列宽一律走 `stringWidth`（CJK/emoji 占 2 列），不用 `.length`——见 src/ui/CLAUDE.md L2.3。
 */

import { homedir } from "node:os";
import { ELLIPSIS } from "../constants/collapse.ts";
import { stringWidth } from "@sid-code/tui-renderer/stringWidth.ts";

/** 路径省略时至少保留的尾部段数（`…/todo/foo.md` 这样至少能看出所在目录）。 */
const MIN_TAIL_SEGMENTS = 1;

/**
 * 把绝对路径改写成**更短的等价显示形式**（与终端宽度无关）。
 *
 * 优先级：
 *   1. cwd 之内 → 去掉 cwd 前缀转相对路径（`docs/bugfixes/todo/x.md`）。工具几乎总在当前
 *      项目里读写，这段前缀对每一行都一样，是纯噪音——去掉它省下的列数最多。
 *   2. home 之内 → `~/Code/other/x.md`。
 *   3. 其它 → 原样返回。
 *
 * 只做前缀替换，不做任何截断：截断是视图层按真实宽度的事（见 `fitPathToWidth`）。
 *
 * @param p 待显示的路径（相对路径原样返回）
 * @param cwd 当前工作目录，默认 `process.cwd()`
 * @param home 家目录，默认 `homedir()`
 */
export function shortenPathForDisplay(
  p: string,
  cwd: string = process.cwd(),
  home: string = homedir(),
): string {
  if (!p) return p;
  // 相对路径已经够短，且没有可去的前缀
  if (!p.startsWith("/")) return p;

  // cwd 前缀：注意要带分隔符比较，否则 `/a/bc` 会被 `/a/b` 误判为命中
  const cwdPrefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (p.startsWith(cwdPrefix)) {
    const rel = p.slice(cwdPrefix.length);
    // cwd 自身（p === cwd）时 rel 为空串，退回原样避免显示成空
    if (rel) return rel;
  }

  const homePrefix = home.endsWith("/") ? home : `${home}/`;
  if (p.startsWith(homePrefix)) {
    return `~/${p.slice(homePrefix.length)}`;
  }

  return p;
}

/**
 * 把**散文里内嵌的绝对路径**改写成短形式（`shortenPathForDisplay` 的 prose 版）。
 *
 * 场景：sub_agent 的 prompt 常写成「你在核查 sid-code 仓库（/Users/me/Code/person/sid-code）里
 * B1 批次…」。这段绝对路径对同批 fan-out 的每个子代理都一模一样，却把 header 的列宽预算
 * 吃光——于是 5 个并行子代理的卡片截断后长得完全一样，用户分不清谁在干什么：
 *
 *   ⏺ sub_agent general-purpose "你在核查 sid-code 仓库（/Users/zhour…   ← ×5，无区分度
 *
 * 去掉噪音后，同样的列宽能露出真正有区分度的部分（`B1 批次` / `B2 批次`）。
 *
 * 只替换 cwd / home 前缀，不改路径的其余部分，也不截断。cwd 优先（更长、更省）。
 */
export function stripPathNoiseInText(
  text: string,
  cwd: string = process.cwd(),
  home: string = homedir(),
): string {
  if (!text) return text;
  let out = text;
  // cwd 先替换：它更长，命中时省下的列数更多。用 split/join 做字面量替换，
  // 避免把路径里的正则元字符（如 `.`、`+`）当模式解释。
  if (cwd) out = out.split(cwd).join(".");
  if (home) out = out.split(home).join("~");
  return out;
}

/**
 * 按列宽收缩**普通文本**（prose：命令、prompt 摘要等），保留头部、尾部追加省略号。
 *
 * 文本类内容的信息密度在开头（命令的动词、prompt 的主语），所以尾截断是对的。
 * 路径类内容相反——用 `fitPathToWidth`。
 */
export function fitTextToWidth(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (stringWidth(text) <= maxCols) return text;

  // 预留 1 列给省略号
  const budget = Math.max(1, maxCols - 1);
  let acc = "";
  let width = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (width + w > budget) break;
    acc += ch;
    width += w;
  }
  return acc + ELLIPSIS;
}

/**
 * 按列宽收缩**路径**：从**头部**按目录段省略，尽量保住文件名。
 *
 * 与 `fitTextToWidth` 相反的截断方向，因为路径的信息密度在尾部：
 *
 *   `docs/bugfixes/todo/20260801-韧性层架构对齐CC-方案.md`
 *   → `…/todo/20260801-韧性层架构对齐CC-方案.md`   （砍目录，文件名完整）
 *
 * 尾部元信息后缀（`read` 的 ` (行 1-100)`）会被识别并原样保留——它是用户要看的参数，
 * 不能因为路径长就被挤掉。
 *
 * 兜底：连"文件名本身"都放不下时，对文件名做**中段**省略并保住扩展名
 * （`2026…方案.md`），因为扩展名决定了这是什么文件。
 */
export function fitPathToWidth(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (stringWidth(text) <= maxCols) return text;

  // 剥离尾部元信息后缀 ` (行 1-100)` / ` (前 100 行)`，收缩只作用于路径本身
  const suffixMatch = text.match(/\s\([^()]*\)$/);
  const suffix = suffixMatch ? suffixMatch[0] : "";
  const pathPart = suffix ? text.slice(0, text.length - suffix.length) : text;
  const suffixWidth = stringWidth(suffix);

  // 后缀本身就吃掉了预算 → 没有路径可显示的余地，整体退回文本式尾截断
  const pathBudget = maxCols - suffixWidth;
  if (pathBudget <= 0) return fitTextToWidth(text, maxCols);

  if (stringWidth(pathPart) <= pathBudget) return pathPart + suffix;

  const segments = pathPart.split("/");
  const basename = segments[segments.length - 1] ?? "";

  // 从右往左尽量多保留段，前缀用 `…/` 表示省略
  // （i 是保留的段数，从多到少试，取第一个放得下的）
  for (let keep = segments.length - 1; keep >= MIN_TAIL_SEGMENTS; keep--) {
    const candidate = `${ELLIPSIS}/${segments.slice(-keep).join("/")}`;
    if (stringWidth(candidate) <= pathBudget) return candidate + suffix;
  }

  // 连 `…/文件名` 都放不下 → 对文件名做中段省略，保住扩展名
  const fitted = elideBasename(basename, pathBudget);
  return fitted + suffix;
}

/**
 * 中段省略文件名，保住扩展名：`20260801-很长的名字.md` → `202608….md`。
 *
 * 扩展名标识文件类型，是尾部最该保住的信息；名字主体则头部信息量更大（日期/编号前缀）。
 */
function elideBasename(basename: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (stringWidth(basename) <= maxCols) return basename;

  const dot = basename.lastIndexOf(".");
  // 无扩展名，或扩展名长得离谱（不像扩展名）→ 退回普通尾截断
  const ext = dot > 0 ? basename.slice(dot) : "";
  const extWidth = stringWidth(ext);
  if (!ext || extWidth > 8 || extWidth + 2 > maxCols) {
    return fitTextToWidth(basename, maxCols);
  }

  const stem = basename.slice(0, dot);
  // 预算 = 总预算 - 扩展名 - 省略号
  const stemBudget = maxCols - extWidth - 1;
  let acc = "";
  let width = 0;
  for (const ch of stem) {
    const w = stringWidth(ch);
    if (width + w > stemBudget) break;
    acc += ch;
    width += w;
  }
  return `${acc}${ELLIPSIS}${ext}`;
}
