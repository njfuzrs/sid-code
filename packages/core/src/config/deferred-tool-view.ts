/**
 * 系统提示词里的「延迟工具」呈现判据（单一事实源）。
 *
 * 要解决的事故形态（2026-08-17 轨迹 20260817-141456-065fe328）：
 * `enter_worktree` 声明 `shouldDefer=true`，registry 的 activeDefinitions() 已把它排除出
 * 真实 API `tools[]`（实测首轮 25 个工具无它），但系统提示词文本仍原样列出
 * `- enter_worktree: 创建一个隔离的 Git Worktree 工作区并进入`，与真实可调用工具**同格式、无任何标注**。
 * 模型于是"知道"这个名字却从未见过它的 schema，生成阶段坍缩成当轮唯一共享 `enter_` 前缀的
 * `enter_plan_mode` —— 不是报错，是生成了一个 schema 自洽的错误调用。实测 5 次误触、
 * 4 份无用 plan 文件、任务卡死到用户手动打断。
 *
 * ⚠️ 判据只允许用**会话内不变的静态属性**，两条硬约束（都踩过）：
 *
 * 1. **不得读 `registry.isToolSearchEnabled()`** —— 它在 `loop.ts:715` 才定档，
 *    而系统提示词在 `app.ts:2620` 就构建完了，此刻恒为 registry 的初值 `false`。
 *    写成"仅当延迟加载启用时才分区"会让生产路径永远不分区（修复静默变空操作），
 *    而单测自己 `new Registry()` + `setToolSearchEnabled(true)` 会全绿。
 * 2. **不得读 `registry.isDeferred()`** —— 它内部经 `isToolDeferred()` 读
 *    `this.activatedTools`（运行时态）。而本模块的输出落在 `DYNAMIC_BOUNDARY`
 *    **之前**的静态前缀里，把运行时态渲染进去 = 每次 tool_search 激活都改写静态前缀
 *    = prompt cache 前缀击穿（cache 命中率 >70% 是北极星「更省」的主口径）。
 *    "已激活"这个运行时状态本来就有正确载体：动态区那条 per-turn
 *    `<available-deferred-tools>` delta（`loop.ts:1736-1780`）。
 *
 * 故本模块的判据是 registry `isToolDeferred()` 的**静态子集**：
 * `alwaysLoad` / keepLoaded 豁免 → 不延迟；`shouldDefer` / `mcp__` 前缀 → 延迟。
 * 刻意漏掉的两项正是运行时态（`activatedTools`）与运行时名单（`deferredTools`），
 * 见上面两条约束。
 */

/** 判定延迟所需的最小工具形状（只读静态字段，不碰执行/schema） */
export interface DeferralJudgeTool {
  name(): string;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
}

/** 判定所需的会话级静态配置 */
export interface DeferralJudgeOptions {
  /**
   * 用户配置的延迟加载豁免名单（`config.toolSearchKeepLoaded`）。
   * 命中即强制首轮可见，优先级高于 `shouldDefer` / `mcp__` 前缀 —— 与
   * `registry.isKeepLoaded()` 同一套匹配规则（精确名 或 `prefix*` 通配）。
   */
  keepLoaded?: string[];
  /**
   * `config.toolSearch === false`（用户恒关延迟加载）。
   *
   * 此时首轮发送全量 `definitions()`，**所有工具都真实可调用**，
   * 标注"需先 tool_search 激活"就是假信息，故一律判为不延迟。
   *
   * 只接受**配置层的 false**，不接受运行时定档结果（见文件头约束 1）。
   * `"auto"` / 百分比档无法在提示词构建时确定（要等 token 估算），保守按"会延迟"处理：
   * 偏差方向是安全的 —— 模型多调一次 tool_search（会得到"已可见"的回复），
   * 而不是坍缩成一个前缀相近的错误工具。
   */
  toolSearchDisabled?: boolean;
}

/** keepLoaded 名单匹配（与 registry.isKeepLoaded 同规则：精确名 或 `prefix*`） */
function isKeepLoaded(name: string, patterns: string[] | undefined): boolean {
  if (!patterns) return false;
  for (const p of patterns) {
    if (p === name) return true;
    if (p.endsWith("*") && name.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/**
 * 工具在**本轮系统提示词构建时刻**是否属于"不在首轮 schema 里"的延迟工具。
 *
 * 判据顺序与 `registry.isToolDeferred()` 保持一致（豁免优先于延迟声明）。
 */
export function isStaticallyDeferred(
  tool: DeferralJudgeTool,
  options?: DeferralJudgeOptions,
): boolean {
  if (options?.toolSearchDisabled) return false;
  if (tool.alwaysLoad) return false;
  if (isKeepLoaded(tool.name(), options?.keepLoaded)) return false;
  if (tool.shouldDefer) return true;
  // MCP 工具默认延迟（registry.ts:356 同源，按前缀识别）
  return tool.name().startsWith("mcp__");
}

/** 按"首轮可调用 / 需先激活"把工具分成两组，保持入参顺序 */
export function partitionByDeferral<T extends DeferralJudgeTool>(
  tools: T[],
  options?: DeferralJudgeOptions,
): { live: T[]; deferred: T[] } {
  const live: T[] = [];
  const deferred: T[] = [];
  for (const t of tools) {
    (isStaticallyDeferred(t, options) ? deferred : live).push(t);
  }
  return { live, deferred };
}

/**
 * 延迟工具行内标记。
 *
 * 之所以每一行都带（而不是只靠分区标题）：模型可能只读到清单中间的某一行，
 * 也可能在 `<scheduling-capability>` 这类正文段落里遇到工具名——标记跟着名字走，
 * 才能保证"看到名字的地方就看到激活要求"。5 个字符 × 19 个延迟工具 ≈ 95 字符，
 * 相对它防住的一次任务卡死可以忽略。
 */
export const DEFERRED_MARK = "[需激活]";
export const DEFERRED_MARK_EN = "[activate first]";

/**
 * 延迟工具分区的说明文字。
 *
 * 措辞与 `loop.ts` 每轮注入的 `<available-deferred-tools>` reminder **刻意保持一致**
 * （"用 tool_search 按名称 select:<工具名> 调出"），消除"两处描述同一件事却措辞不同"
 * 带来的认知负担 —— 那正是本次事故里模型信任了系统提示词、忽略了 reminder 的一半原因。
 */
export const DEFERRED_SECTION_TITLE = "### 未加载的工具（需先用 tool_search 激活）";
export const DEFERRED_SECTION_NOTE =
  "以下工具**尚未加载**到本轮上下文，直接调用会失败（模型无法调用不在本轮工具列表里的名字）。" +
  "需要时先用 `tool_search` 按名称调出（`select:<工具名>`，多个用逗号分隔），激活后即可正常调用。" +
  "注意不要把它们与上面同前缀的已加载工具混淆（如 `enter_worktree` 与 `enter_plan_mode` 是两个不同的工具）。";

export const DEFERRED_SECTION_TITLE_EN =
  "### Not-yet-loaded tools (activate with tool_search first)";
export const DEFERRED_SECTION_NOTE_EN =
  "The tools below are **not loaded** into this turn's context; calling one directly will fail " +
  "(a model cannot call a name that is absent from the current tool list). " +
  "Pull one in with `tool_search` by name (`select:<tool_name>`, comma-separated for several), then call it normally. " +
  "Do not confuse them with the loaded tools sharing a prefix (e.g. `enter_worktree` vs `enter_plan_mode`).";

/**
 * 紧跟在「可直接调用」清单之后的一行指针。
 *
 * 分区块本身排在 `<tool-guide>` 末尾（那里才轮到各工具的完整使用指南，保证
 * "名单归名单、指南归指南"两个区各自同质），但**警告必须紧贴工具清单** ——
 * 模型是在读清单的那一刻决定调哪个名字的，警告离得太远就等于没写。
 */
export function renderDeferredPointer(count: number, isEn = false): string {
  if (count === 0) return "";
  return isEn
    ? `\n⚠️ Another ${count} tool(s) exist but are **not loaded** into this turn — see "Not-yet-loaded tools" at the end of this section. Calling one without activating it first will fail.\n`
    : `\n⚠️ 另有 ${count} 个工具**尚未加载**到本轮（见本段末尾「未加载的工具」）。未激活就调用会失败，不要与上面同前缀的已加载工具混淆。\n`;
}

/** 渲染延迟工具分区；无延迟工具时返回空串（不留空标题） */
export function renderDeferredSection(lines: string[], guides: string[], isEn = false): string {
  if (lines.length === 0 && guides.length === 0) return "";
  const title = isEn ? DEFERRED_SECTION_TITLE_EN : DEFERRED_SECTION_TITLE;
  const note = isEn ? DEFERRED_SECTION_NOTE_EN : DEFERRED_SECTION_NOTE;
  const body = lines.length > 0 ? `\n${lines.join("\n")}` : "";
  const guideBody = guides.length > 0 ? `\n${guides.join("\n")}` : "";
  return `\n${title}\n${note}\n${body}${guideBody}\n`;
}
