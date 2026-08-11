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
 * 从 shell 命令文本里提取**写入目标**路径（第 7 批 · §8.9 共同盲区）。
 *
 * ## 这是个什么盲区
 *
 * `bash` 用 `cat > src/ui/x.tsx`、`sed -i` 改了文件，JIT 完全不触发 ——
 * 模型接着改同目录的其它文件时，那个目录的规范一份都拿不到。CC 也没有这条，
 * 所以不是「我们落后」，但确实是能力上限。
 *
 * ## 为什么必须保守（宁漏不误）
 *
 * 误报的代价**高于**漏报：把不相干目录的规则灌进上下文既烧 token，又可能让模型
 * 遵循错误的规范。而漏报只是回到现状（本来就不触发）。所以这里只认几个
 * **高确定性形态**，任何拿不准的一律不报：
 *
 *   - `> path` / `>> path`（含 `1>` `2>` 等 fd 前缀）
 *   - `tee path` / `tee -a path`
 *   - `sed -i ... path` / `sed --in-place ... path`
 *   - `cp` / `mv` / `install` 的**目标**（最后一个非选项 token）
 *   - `touch` / `mkdir` 的每个非选项参数
 *
 * ⚠ 关于 `cp`/`mv`：这里原先写的不支持理由是「**目标可能是目录**、可能带多个源，
 * 语义判定复杂」。**「目标可能是目录」这条已被实测推翻** —— JIT 侧根本不需要区分：
 * 下游 `discoverDetailed` 有 `targetIsDir` 分支（`jit-context.ts:207`），传目录 /
 * 传尾斜杠 / 传不存在的路径三种形态全部安全（都能正确加载该路径的规则链）。
 * 那条注释是**按静态提取的难点写理由，而没有回头看下游能不能消化** —— 下游早就能了，
 * 上游还在因为一个不存在的约束拒绝提取。**注释里的理由也会过期，留着它下一个人会照着
 * 它继续拒绝正确的改动。**
 *
 * 刻意**不**支持的形态及理由（这些是设计取舍，不是待办；`tests/tool/bash-write-targets.test.ts`
 * 里有对应的显式断言，免得未来有人「顺手」加上而没有任何东西变红）：
 *   - `rm path`：删掉之后那个目录的规则**不再适用于任何后续操作**，注入是纯浪费。
 *   - `python gen.py` 这类**程序自己写文件**：任意程序可写任意路径，要支持等于要
 *     静态分析任意程序。不是「难」而是「不可能」。
 *   - 变量与命令替换（`> $OUT`、`> $(mktemp)`）：值在运行时才知道，静态提取必错。
 *   - `cp a*.ts dst`：源含通配不影响提取（只取目标）；但**目标**含通配一律放弃。
 *   - 进程替换 `>(cmd)`、fd 复制 `>&2`：不是文件路径。
 *   - `/dev/*`、`/tmp/*`：不是项目内业务文件，报了只会白扫。
 *
 * 契约同 `jitAffectedPaths`：纯函数、不 IO、不抛。
 */
export function bashWriteTargets(command: unknown): string[] {
  if (typeof command !== "string" || !command.trim()) return [];
  // 超长命令（通常是 heredoc 灌大段内容）只看前段，避免正则在极端输入上退化
  const cmd = command.length > 4000 ? command.slice(0, 4000) : command;

  const out: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    let p = raw.trim();
    // 去掉成对引号（`> "src/a b.ts"`）
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1);
    }
    if (!p) return;
    // 含变量 / 命令替换 / 通配 → 静态提取不可靠，直接放弃（宁漏不误）
    if (/[$`*?]/.test(p)) return;
    // 不是文件路径的形态：fd 复制（`&2`）、进程替换残留、纯选项
    if (p.startsWith("&") || p.startsWith("-")) return;
    // 设备/临时目录不是业务文件，报了只是白扫一遍目录链
    if (/^\/dev\//.test(p) || /^\/tmp\//.test(p) || p === "/dev/null") return;
    if (!out.includes(p)) out.push(p);
  };

  // 目标 token：优先整段匹配引号内内容（`> "src/my dir/a.ts"` 含空格，按空白切会截断），
  // 否则取到下一个空白/管道/重定向符为止。
  const TARGET = `"[^"]*"|'[^']*'|[^>&|;<\\s]+`;

  // ① 重定向：`>` / `>>`，允许前置 fd 数字（`2> log`）。
  //    非引号分支的 `[^>&|;<\s]` 起始确保排除 `>&2`、`>>|` 这类非路径目标。
  for (const m of cmd.matchAll(new RegExp(`(?:^|[\\s;&|])\\d*>>?\\s*(${TARGET})`, "g"))) push(m[1]);

  // ② tee：`tee out.txt` / `tee -a out.txt`
  for (const m of cmd.matchAll(new RegExp(`(?:^|[\\s;&|])tee\\s+((?:-[a-zA-Z-]+\\s+)*)(${TARGET})`, "g"))) push(m[2]);

  // ③ sed 原地改：`sed -i 's/a/b/' file` / `sed --in-place=bak -e ... file`
  //    取该 sed 片段的**最后一个**非选项参数作为目标文件。
  for (const seg of cmd.split(/[;|&\n]+/)) {
    if (!/(?:^|\s)sed\s/.test(seg)) continue;
    if (!/\s-i\b|--in-place/.test(seg)) continue;
    const toks = seg.trim().split(/\s+/);
    const last = toks[toks.length - 1];
    // 最后一个 token 是脚本本体（`'s/a/b/'`）而非文件时不报
    if (last && !/^-/.test(last) && !/^['"]?s[/|,]/.test(last)) push(last);
  }

  // ④ 文件搬运/创建：`cp` / `mv` / `install` 取**目标**（最后一个非选项 token），
  //    `touch` / `mkdir` 的每个非选项参数都是目标。
  //    目标是目录（`src/ui/`）或尚不存在的路径都没问题 —— 下游 discoverDetailed 能消化
  //    （见函数头注释里被推翻的那条理由）。过滤全部复用 push()，所以 `$VAR` / 通配 /
  //    `/tmp` / `-` 前缀这些形态与 ①②③ 保持同一套判据，不会因为新增动词而绕过。
  for (const seg of cmd.split(/[;|&\n]+/)) {
    const trimmed = seg.trim();
    const m = trimmed.match(/^(cp|mv|install|touch|mkdir)\s+(.*)$/);
    if (!m) continue;
    const verb = m[1];
    // 选项与其自带的值都要滤掉。`install -m 644 a b` 里的 `644` 不是路径，
    // 但它也不是最后一个 token，所以对 cp/mv/install 无害；对 touch/mkdir
    // 逐个 push 的分支则需要它 —— `mkdir -m 755 dir` 会把 `755` 当目标。
    const raw = m[2].split(/\s+/).filter(Boolean);
    const toks: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      if (t.startsWith("-")) {
        // 带值的短选项（`-m 644` / `-t dir`）：跳过它后面那个 token
        if (/^-[mtoglS]$/.test(t)) i++;
        continue;
      }
      toks.push(t);
    }
    if (toks.length === 0) continue;
    if (verb === "touch" || verb === "mkdir") {
      for (const t of toks) push(t);
    } else {
      // cp/mv/install：只取目标。多源形态（`cp a b dst/`）下这正是唯一正确的选择。
      push(toks[toks.length - 1]);
    }
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
