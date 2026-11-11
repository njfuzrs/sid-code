/**
 * 外部内容来源判定 + 不可信包裹（B14 / HB-13a）。
 *
 * 问题：MCP 工具、MCP 资源工具、web_search 的结果进上下文时与用户消息、普通工具输出完全同构。
 * 模型没有任何确定性依据区分「这是外部数据」还是「这是可信内容」，唯一依据是它自己的常识。
 * 本模块给出代码层的形态标记，配合 system prompt 的「外部内容安全边界」段（system-prompt.ts
 * 的 buildExternalContentBoundarySection），把「边界-仅prompt」补成「边界-强制（标记）」。
 *
 * ## 为什么判定放在执行器，不在工具内部
 *
 * 1. 主循环的 finalOutput 在成形前会被 6 处改写（hook 替换输出、hook 附加上下文、hook 反馈、
 *    连续编辑失败提醒、改参告知前置、状态查询提示）。工具内部写的标签会被 PostToolUse 的
 *    getUpdatedToolOutput 整段冲掉（query/tool-executor.ts 的 replaced 分支），而且现有测试
 *    只断言替换生效，不会发现标签丢了。
 * 2. `read` 家族的判定依据是「文件路径在工作目录集合内/外」，工具层拿不到 PathValidator
 *    （LegacyTool.execute(input, signal?, onProgress?) 没有 context 位），执行器层才有
 *    deps.permissionChecker。
 *
 * ## 范围（PR-1 = 三档，file 档留到 PR-2）
 *
 * 本文件当前只实现三档**无条件外部来源**：`mcp__*` 工具、ReadMcpResource / ListMcpResources、
 * web_search。它们不存在「什么算可信材料」的判断，只加文本标记、不改任何执行或权限行为。
 *
 * `file` 档（read / read_many / grep 的工作区外判定）留给 B14 方案 PR-2：它会动「更准」
 * （模型对自己工作材料也开始怀疑），必须先用 ⑫ 基线量过。判定函数保留 isWithinWorkingDirs
 * 参数位，PR-2 只需补分支，两处调用点不用动。
 *
 * 不包 `web_fetch`：它已有更强的隔离提炼（正文交独立小模型、不进主上下文）+ 降级路径显式
 * 标注不可信 + 出站 URL 闸门。改成 XML 标签会把「已隔离的受控输出」降级成和原始注入文本
 * 同一档，是削弱而不是增强。
 */

/** 外部内容来源。undefined = 不需要包裹（可信工作材料）。 */
export type ContentProvenance = "mcp" | "mcp-resource" | "web_search" | "file";

/**
 * MCP 资源工具名。
 *
 * ⚠️ 这两个名字**不带 `mcp__` 前缀**，按前缀判定会漏 —— 台账最初写「三类」时漏掉的正是
 * 这两档（另一档 read_many / grep 归 PR-2）。反漂移哨兵
 * （tests/tool/content-provenance.test.ts）从真实 registry 取名单对账，删/改名会红。
 */
const MCP_RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ReadMcpResource",
  "ListMcpResources",
]);

/**
 * 判定一次工具调用的结果是否来自外部不可信来源。
 *
 * 只做静态判定（工具名 + 入参路径）：无 LLM、无交互、无副作用，逐次调用零成本。
 *
 * `isWithinWorkingDirs` 是 PathValidator.isWithinWorkingDirectories 的形状
 * （工作区 ∪ `--add-dir` 白名单，不是裸工作区 —— 用户显式 --add-dir 的目录是他的工作材料，
 * 不该包）。PR-1 的三档用不到它；PR-2 的 `file` 档才用它。
 */
export function resolveContentProvenance(
  toolName: string,
  input: Record<string, unknown> | undefined,
  isWithinWorkingDirs: (absPath: string) => boolean,
): ContentProvenance | undefined {
  // MCP 工具的注册名统一是 `mcp__<server>__<tool>`（mcp/manager.ts 的 buildMcpToolName）。
  // 第三方 server 是本机之外的进程/服务，返回内容 100% 不受本机控制。
  if (toolName.startsWith("mcp__")) return "mcp";
  if (MCP_RESOURCE_TOOL_NAMES.has(toolName)) return "mcp-resource";
  // 搜索引擎返回的标题 / URL / snippet 是攻击者可控文本的经典载体（SEO 投毒）。
  if (toolName === "web_search") return "web_search";

  // `file` 档（read / read_many / grep 的工作区外判定）留到 PR-2：判定要按入参路径解析后
  // 再比（相对路径不能按字符串前缀猜），依赖上面两个参数。
  return undefined;
}

/**
 * 把工具结果包进 `<external-content>`。
 *
 * - 标签名与既有的 `<subagent-result>` / `<result>` 区分，语义更准；
 * - `untrusted="true"` 沿用既有闭集：现有 5 处消费方按这个属性名 grep，改名会让它们静默失效；
 * - `source` 只写**粗粒度类别**，不写 MCP server 名 —— serverName 可能是
 *   `plugin:<plugin>:<server>`（mcp/manager.ts 注释），进 prompt 等于把插件内部结构摊给模型；
 *   而模型从工具名 `mcp__<server>__<tool>` 已经知道是哪个 server，无需重复。
 */
export function wrapExternalContent(body: string, source: ContentProvenance): string {
  return `<external-content source="${source}" untrusted="true">\n${body}\n</external-content>`;
}
