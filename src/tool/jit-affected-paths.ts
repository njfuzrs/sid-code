/**
 * JIT 路径自报的共享辅助（P2-9）。
 *
 * 各文件类工具实现 `ToolCapabilityFields.jitAffectedPaths` 时用这里的小工具，
 * 保证「怎么从 input 里挑出文件语义路径」这件事只有一套判定 —— 集中式硬编码名单
 * 正是被这次改造替掉的东西，不能在辅助层把它重新引回来。
 *
 * 契约见 `types.ts` 的 `jitAffectedPaths` 注释：纯函数、不 IO、不抛。
 */

import { extractGlobBaseDirectory } from "./glob.ts";
import type { Registry as ToolRegistry } from "./registry.ts";

/**
 * 从 input 上按字段名取字符串路径，过滤空值。
 *
 * 只接受调用方**显式列出**的字段名 —— 不做 `Object.keys` 遍历式猜测，
 * 否则 `pattern`（正则）、`url`、`content` 这类同为 string 的字段会被误当路径。
 */
export function pickPaths(input: unknown, ...fields: string[]): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const out: string[] = [];
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && v.trim()) out.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string" && item.trim()) out.push(item);
    }
  }
  return out;
}

/**
 * 从 glob/grep 类工具的 pattern 中提取「静态目录前缀」。
 *
 * `glob("src/ui/**\/*.tsx")` 这类把目录写在 pattern 里的调用，不提取前缀就只能
 * 退化成项目根，目标目录的规范拿不到（§8.9-2）。
 * 复用 glob 工具自身的 `extractGlobBaseDirectory`，不重写第二套算法。
 *
 * 返回空数组表示 pattern 里没有可用的静态目录（如 `**\/*.ts`、`*.md`）——
 * 此时调用方不应臆造路径，交由 JIT 侧按 `path` 参数或项目根处理。
 */
export function globPatternDirs(patterns: unknown): string[] {
  const list = typeof patterns === "string" ? [patterns] : Array.isArray(patterns) ? patterns : [];
  const out: string[] = [];
  for (const p of list) {
    if (typeof p !== "string" || !p.trim()) continue;
    try {
      const { baseDir } = extractGlobBaseDirectory(p);
      // baseDir 为空 = 通配符前无分隔符（pattern 相对 cwd，无目录信息可用）
      if (baseDir) out.push(baseDir);
    } catch {
      /* 提取失败静默跳过：契约要求 jitAffectedPaths 不抛 */
    }
  }
  return out;
}

/**
 * 把 `path`（搜索根）与 pattern 里的静态前缀组合成待探测路径。
 *
 * 两者都要报：`{path: "src", pattern: "ui/**\/*.tsx"}` 形态下，
 * 单看 `path` 只到 `src`、单看 pattern 前缀只有相对段 `ui`，
 * 组合出的 `src/ui` 才是真正被搜索的目录。
 */
export function searchToolPaths(input: unknown, patternField = "pattern"): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const root = typeof obj.path === "string" && obj.path.trim() ? obj.path : "";
  const patternDirs = globPatternDirs(obj[patternField]);

  const out: string[] = [];
  if (root) out.push(root);
  for (const d of patternDirs) {
    // 绝对前缀直接用；相对前缀拼在搜索根之下（无根时保持相对，由 JIT 侧按 cwd 归一化）
    if (d.startsWith("/")) out.push(d);
    else if (root) out.push(`${root.replace(/\/+$/, "")}/${d}`);
    else out.push(d);
  }
  return out;
}

/**
 * 从工具调用块提取「应触发 JIT 发现」的路径集合。
 *
 * 抽成纯函数导出是为了让下面几条判定可被直接测试（它们都曾是静默失效的来源）：
 *
 * 1. **工具白名单来自工具自报**（P2-9）：原实现在 `app.ts` 硬编码
 *    `["read","write","edit","grep","glob"]`，而仓库里接受路径参数的文件类工具有
 *    10 个 —— `read_many` / `notebook_edit` / `ls` / `lsp` 全部漏在外面。硬编码名单
 *    与真实注册的工具之间没有对账机制，新增工具必然漏（同 `exemptFromLoopDetection`
 *    从死名单改为工具自报的教训）。故改为读工具自报的 `jitAffectedPaths`，
 *    并由 `tests/tool/jit-affected-paths-audit.test.ts` 双向对账。
 *
 * 2. **glob 的目录写在 pattern 里也要认**（§8.9-2）：`glob("src/ui/**\/*.tsx")` 不带
 *    `path` 参数时，原实现退化为项目根 → 只加载根 CLAUDE.md，`src/ui` 的规范拿不到。
 *
 * 3. **相对路径不在这里归一化**（P1-4）：交给下游 `discoverDetailed` 统一处理，
 *    本函数只负责收集原始形态，保持纯函数、可测。
 *
 * @param resolveAffected 工具名 → 自报提取器。生产侧传
 *   `(n) => resolveJitPathExtractor(registry, n)`；测试侧可直接注入桩，
 *   无需拉起整个注册表。
 */
export function collectJitAccessedPaths(
  toolBlocks: Array<{ name: string; input: unknown }>,
  projectRoot: string,
  resolveAffected: (toolName: string) => ((input: unknown) => string[]) | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of toolBlocks) {
    const extract = resolveAffected(block.name);
    if (!extract) continue;
    let paths: string[];
    try {
      paths = extract(block.input) ?? [];
    } catch {
      continue; // 单个提取器抛错不影响其余（契约要求不抛，抛了说明入参畸形）
    }
    for (const p of paths) {
      if (!p || typeof p !== "string" || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  // 兜底：glob 既无 path 又无静态前缀（如 `**\/*.ts`）时，搜索根事实上就是项目根。
  // 只在**完全没收集到路径**时兜底，避免给已有明确目标的批次多注入一次根规则。
  if (out.length === 0 && toolBlocks.some((b) => b.name === "glob")) {
    out.push(projectRoot);
  }
  return out;
}

/**
 * 从注册表解析某工具的 JIT 路径提取器。
 *
 * 只认工具自报的 `jitAffectedPaths` —— 不做「按 file_path / path 字段名猜」的兜底。
 * 猜测式兜底会把非文件语义的同名字段（web_fetch 的 url、mcp 工具的 path 形参等）
 * 误当本地路径去 stat，产生无意义 IO 与误注入；而漏报的代价是 CI 可见的
 * （`tests/tool/jit-affected-paths-audit.test.ts` 对账文件类工具是否都自报了），
 * 所以这里选择 fail-closed。
 */
export function resolveJitPathExtractor(
  registry: ToolRegistry,
  toolName: string,
): ((input: unknown) => string[]) | undefined {
  const tool = registry.get(toolName) as
    | { jitAffectedPaths?: (input: unknown) => string[] }
    | undefined;
  if (!tool?.jitAffectedPaths) return undefined;
  return (input) => tool.jitAffectedPaths!(input);
}
