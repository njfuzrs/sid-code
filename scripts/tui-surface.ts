#!/usr/bin/env bun
/**
 * TUI 渲染端口面盘点（B9 / T0.1）。
 *
 * 回答一个问题：**CLI 到底依赖渲染底座的哪些东西**。这张清单就是新底座必须提供的
 * 「端口面」，也是 render-port 层要覆盖的全部范围。
 *
 * 四块产出，全部从源码机械扫出，不靠目测：
 *
 * 1. CLI 消费的底座符号（静态 import / 动态 `await import()` 解构），按引用文件数排序；
 * 2. 宿主组件（Box / Text / Static …）上实际出现的 JSX props 及其字面量取值；
 * 3. 底座源码读取的环境变量（新底座要么保留、要么在契约里写明改名 / 删除，D125）；
 * 4. CLI 绕过底座直接往 stdout 写的位置（端口层管不到，设计文档 §1.5）。
 *
 * 为什么要脚本：设计文档 §1.2 初稿的手工计数已经错过一次（把注释里提到的 ScrollBox
 * 计成了真实依赖）。数字要能复算，才能在 T0.2 codemod 前后对比「端口面没有变」。
 *
 * 用法：
 *   bun run tui:surface            # 重新生成 packages/cli/src/ui/render-port/SURFACE.md
 *   bun run tui:surface --check    # 只比对签名（符号 / props / 环境变量集合），漂移则退 1
 *
 * 签名只取**集合**不取计数：计数随日常 UI 改动天天变，拿它做门禁只会逼人反复重生成；
 * 集合变了才说明端口面真的变了（多了一个符号 / prop / 环境变量），那正是要被看见的事。
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI_SRC = join(ROOT, "packages/cli/src");
const CLI_TESTS = join(ROOT, "packages/cli/tests");
const RENDERER_SRC = join(ROOT, "packages/tui-renderer/src");
/** 端口层自己：它是适配器，不是消费者，扫描消费者时要排除。 */
const PORT_DIR = join(CLI_SRC, "ui/render-port");
export const SURFACE_MD = join(PORT_DIR, "SURFACE.md");

const RENDERER_PREFIX = "@sid-code/tui-renderer/";

// ───────────────────────── 基础工具 ─────────────────────────

/** 递归收集 .ts/.tsx（跟随 symlink —— tui-renderer/src 本身就是 symlink）。 */
export function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 剥注释（保留换行与长度）。必须先剥：ui/ 下大量注释在讲 cc 的 ScrollBox 等组件，
 * 不剥就会把注释里的示例代码计成依赖 —— §1.2 初稿就是这么错的。
 * `(^|[^:])//` 避开字符串里的 `https://`。
 */
export function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/**
 * 把导入说明符归一成「底座模块名」，不是底座导入则返回 null。
 *
 * 两种形态都认：`@sid-code/tui-renderer/x.ts`（T0.2 之前），以及解析后落进
 * `ui/render-port/` 的相对路径（T0.2 之后 CLI 只认端口）。后者统一记成 `render-port/…`。
 */
export function rendererModuleOf(spec: string, fromFile?: string): string | null {
  if (spec.startsWith(RENDERER_PREFIX)) return spec.slice(RENDERER_PREFIX.length);
  if (fromFile && spec.startsWith(".")) {
    const abs = resolve(fromFile, "..", spec);
    const rel = relative(PORT_DIR, abs);
    if (!rel.startsWith("..")) return `render-port/${rel || "index"}`;
  }
  if (spec.startsWith("@sid-code/cli/ui/render-port")) {
    return `render-port/${spec.slice("@sid-code/cli/ui/render-port/".length) || "index"}`;
  }
  return null;
}

// ───────────────────────── 1. 符号 ─────────────────────────

export interface ImportedSymbol {
  /** 底座模块（相对底座 src） */
  module: string;
  /** 导出名；默认导出为 "default" */
  exported: string;
  /** 本文件里的本地名 */
  local: string;
  typeOnly: boolean;
  dynamic: boolean;
}

/** 解析 `{ a, b as c, type D, default: e }` 这类列表。`destructure` 区分 import 与解构语法。 */
function parseNameList(list: string, destructure: boolean, clauseTypeOnly: boolean) {
  const out: Array<{ exported: string; local: string; typeOnly: boolean }> = [];
  for (const raw of list.split(",")) {
    let s = raw.trim();
    if (!s) continue;
    let typeOnly = clauseTypeOnly;
    if (s.startsWith("type ")) {
      typeOnly = true;
      s = s.slice(5).trim();
    }
    const sep = destructure ? /\s*:\s*/ : /\s+as\s+/;
    const [exported, local] = s.split(sep);
    out.push({ exported: exported!, local: (local ?? exported)!, typeOnly });
  }
  return out;
}

/** 抽一个文件里所有来自底座的导入符号。 */
export function extractRendererImports(content: string, fromFile?: string): ImportedSymbol[] {
  const src = stripComments(content);
  const out: ImportedSymbol[] = [];

  // 静态：import [type] <clause> from "spec"；也覆盖 export {…} from（转发同样算依赖）
  for (const m of src.matchAll(
    /\b(import|export)\s+(type\s+)?([\w$\s{},*]*?)\s*from\s*["']([^"']+)["']/g,
  )) {
    const module = rendererModuleOf(m[4]!, fromFile);
    if (!module) continue;
    const clauseTypeOnly = Boolean(m[2]);
    let clause = m[3]!.trim();
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const n of parseNameList(braces[1]!, false, clauseTypeOnly)) {
        out.push({ module, ...n, dynamic: false });
      }
      clause = clause.replace(braces[0], "");
    }
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) {
      out.push({ module, exported: "*", local: ns[1]!, typeOnly: clauseTypeOnly, dynamic: false });
      clause = clause.replace(ns[0], "");
    }
    const def = clause.replace(/,/g, "").trim();
    if (def && m[1] === "import") {
      out.push({
        module,
        exported: "default",
        local: def,
        typeOnly: clauseTypeOnly,
        dynamic: false,
      });
    }
  }

  // 动态：const { a, default: b } = await import("spec")
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const module = rendererModuleOf(m[2]!, fromFile);
    if (!module) continue;
    for (const n of parseNameList(m[1]!, true, false)) {
      out.push({ module, ...n, dynamic: true });
    }
  }
  // 动态但未解构：const x = await import("spec") —— 记成整模块依赖，宁多勿漏
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const module = rendererModuleOf(m[2]!, fromFile);
    if (!module) continue;
    out.push({ module, exported: "*", local: m[1]!, typeOnly: false, dynamic: true });
  }
  // inline 类型：import("spec").X
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)\.([\w$]+)/g)) {
    const module = rendererModuleOf(m[1]!, fromFile);
    if (!module) continue;
    out.push({ module, exported: m[2]!, local: m[2]!, typeOnly: true, dynamic: false });
  }
  return out;
}

/**
 * 符号的展示名 = 签名键。默认导出取本地名（`import Box from …/Box.tsx` → `Box`），
 * 命名导出取导出名。这样 T0.2 把 `import Box from "…/Box.tsx"` 改成
 * `import { Box } from "render-port"` 之后，签名不变 —— 端口面没变，签名就不该变。
 */
export function symbolKey(s: ImportedSymbol): string {
  return s.exported === "default" || s.exported === "*" ? s.local : s.exported;
}

// ───────────────────────── 2. JSX props ─────────────────────────

/** 从 `i`（指向 `{`）开始找配对的 `}`，跳过字符串与模板字面量。返回 `}` 的下标。 */
function matchBrace(src: string, i: number): number {
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (k++; k < src.length && src[k] !== q; k++) if (src[k] === "\\") k++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k;
  }
  return src.length;
}

export interface PropUse {
  component: string;
  prop: string;
  /** 字面量取值（"x" 或 {"x"} / {123} / {true}），非字面量为 null */
  literal: string | null;
}

/** 扫出 `<Component …>` 开标签上的全部 prop。 */
export function extractJsxProps(content: string, components: Iterable<string>): PropUse[] {
  const src = stripComments(content);
  const out: PropUse[] = [];
  for (const comp of components) {
    const re = new RegExp(`<${comp.replace(/\$/g, "\\$")}(?=[\\s/>])`, "g");
    for (const m of src.matchAll(re)) {
      let i = m.index! + comp.length + 1;
      while (i < src.length) {
        while (/\s/.test(src[i] ?? "")) i++;
        const c = src[i];
        if (c === undefined || c === ">" || (c === "/" && src[i + 1] === ">")) break;
        if (c === "{") {
          // {...spread}
          const end = matchBrace(src, i);
          out.push({ component: comp, prop: "...spread", literal: null });
          i = end + 1;
          continue;
        }
        const name = /^[A-Za-z_$][\w$:-]*/.exec(src.slice(i, i + 64));
        if (!name) break; // 不是合法属性 —— 多半是泛型 `<Box<T>`，放弃这个标签
        i += name[0].length;
        while (/\s/.test(src[i] ?? "")) i++;
        let literal: string | null = "true"; // 裸属性 = true
        if (src[i] === "=") {
          i++;
          while (/\s/.test(src[i] ?? "")) i++;
          if (src[i] === '"' || src[i] === "'") {
            const q = src[i]!;
            const end = src.indexOf(q, i + 1);
            literal = src.slice(i + 1, end);
            i = end + 1;
          } else if (src[i] === "{") {
            const end = matchBrace(src, i);
            const expr = src.slice(i + 1, end).trim();
            const lit = /^(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?|true|false))$/.exec(expr);
            literal = lit ? (lit[1] ?? lit[2] ?? lit[3])! : null;
            i = end + 1;
          } else {
            literal = null;
          }
        }
        out.push({ component: comp, prop: name[0], literal });
      }
    }
  }
  return out;
}

// ───────────────────────── 3. 环境变量 ─────────────────────────

/**
 * 底座源码读取的环境变量名。覆盖 `process.env.X`、`process.env["X"]`，以及
 * `const env = process.env` / `options?.env ?? process.env` 之后的 `env.X` / `env["X"]`。
 * 第二类只在文件里确实出现过 `process.env` 时才认，避免把普通对象的 `env.foo` 计进来。
 */
export function extractEnvVars(content: string): string[] {
  const src = stripComments(content);
  const names = new Set<string>();
  const NAME = String.raw`([A-Za-z_][A-Za-z0-9_]*)`;
  for (const m of src.matchAll(new RegExp(String.raw`process\.env\.${NAME}`, "g")))
    names.add(m[1]!);
  for (const m of src.matchAll(new RegExp(String.raw`process\.env\[\s*["']${NAME}["']\s*\]`, "g")))
    names.add(m[1]!);
  if (/process\.env\b/.test(src)) {
    for (const m of src.matchAll(new RegExp(String.raw`\benv\??\.${NAME}`, "g"))) names.add(m[1]!);
    for (const m of src.matchAll(new RegExp(String.raw`\benv\[\s*["']${NAME}["']\s*\]`, "g")))
      names.add(m[1]!);
  }
  // 环境变量名约定全大写开头；`env.get` / `env.has` 这类方法名排除
  return [...names].filter((n) => /^[A-Z_]/.test(n));
}

// ───────────────────────── 4. 直写 stdout ─────────────────────────

export interface DirectWrite {
  file: string;
  line: number;
  code: string;
  kind: "终端序列" | "普通输出";
}

/** 参数里出现转义序列 / 模式常量 / OSC 序列变量 → 判为终端序列（与底座写的是同一块终端）。 */
const TERMINAL_ARG = /\\x1b|\\u001b|\\e\[|ENABLE_|DISABLE_|_QUERY|_SEQUENCE|oscSeq|\bOSC\b|\bBEL\b/;

export function extractDirectWrites(content: string, file: string): DirectWrite[] {
  const lines = stripComments(content).split("\n");
  const out: DirectWrite[] = [];
  lines.forEach((l, idx) => {
    if (!/\bstdout\.write\(|writeSync\(\s*(?:process\.)?stdout\.fd/.test(l)) return;
    out.push({
      file,
      line: idx + 1,
      code: l.trim(),
      kind: TERMINAL_ARG.test(l) ? "终端序列" : "普通输出",
    });
  });
  return out;
}

// ───────────────────────── 汇总 ─────────────────────────

export interface Surface {
  symbols: Map<
    string,
    { modules: Set<string>; files: Set<string>; typeOnly: boolean; dynamic: boolean }
  >;
  props: Map<
    string,
    { count: number; files: Set<string>; literals: Map<string, number>; dynamic: number }
  >;
  envVars: Map<string, Set<string>>;
  directWrites: DirectWrite[];
  srcFiles: number;
  testFiles: string[];
}

/** 宿主组件 = 从底座导入的、首字母大写的值（不是类型、不是 hook）且以 JSX 标签出现的符号。 */
function hostComponentLocals(imports: ImportedSymbol[]): string[] {
  return imports.filter((s) => !s.typeOnly && /^[A-Z]/.test(s.local)).map((s) => s.local);
}

export function analyze(): Surface {
  const symbols: Surface["symbols"] = new Map();
  const props: Surface["props"] = new Map();
  const envVars: Surface["envVars"] = new Map();
  const directWrites: DirectWrite[] = [];
  let srcFiles = 0;

  for (const file of collectFiles(CLI_SRC)) {
    if (!relative(PORT_DIR, file).startsWith("..")) continue; // 端口层自己不算消费者
    const rel = relative(ROOT, file);
    const content = readFileSync(file, "utf8");
    const imports = extractRendererImports(content, file);
    if (imports.length > 0) srcFiles++;
    for (const s of imports) {
      const key = symbolKey(s);
      const e = symbols.get(key) ?? {
        modules: new Set(),
        files: new Set(),
        typeOnly: true,
        dynamic: false,
      };
      e.modules.add(s.module);
      e.files.add(rel);
      e.typeOnly &&= s.typeOnly;
      e.dynamic ||= s.dynamic;
      symbols.set(key, e);
    }
    const comps = hostComponentLocals(imports);
    for (const p of extractJsxProps(content, comps)) {
      // 用签名键（Box / Text …）而非本地别名聚合，`Ansi as AnsiRaw` 归到 Ansi
      const imp = imports.find((s) => s.local === p.component)!;
      const key = `${symbolKey(imp)}.${p.prop}`;
      const e = props.get(key) ?? { count: 0, files: new Set(), literals: new Map(), dynamic: 0 };
      e.count++;
      e.files.add(rel);
      if (p.literal === null) e.dynamic++;
      else e.literals.set(p.literal, (e.literals.get(p.literal) ?? 0) + 1);
      props.set(key, e);
    }
    directWrites.push(...extractDirectWrites(content, rel));
  }
  for (const file of collectFiles(RENDERER_SRC)) {
    const rel = relative(RENDERER_SRC, file);
    for (const name of extractEnvVars(readFileSync(file, "utf8"))) {
      const s = envVars.get(name) ?? new Set();
      s.add(rel);
      envVars.set(name, s);
    }
  }

  const testFiles = existsSync(CLI_TESTS)
    ? collectFiles(CLI_TESTS)
        .filter((f) => extractRendererImports(readFileSync(f, "utf8"), f).length > 0)
        .map((f) => relative(ROOT, f))
        .sort()
    : [];

  return { symbols, props, envVars, directWrites, srcFiles, testFiles };
}

/** 签名：符号集合 + props 集合 + 环境变量集合。计数不进签名（理由见文件头）。 */
export function signature(s: Surface): string {
  const parts = [
    "symbols:" + [...s.symbols.keys()].sort().join(","),
    "props:" + [...s.props.keys()].sort().join(","),
    "env:" + [...s.envVars.keys()].sort().join(","),
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/**
 * §3 每个环境变量在新底座上的结论（B9 / T7.2c，D125）。**键集合必须等于扫描出的集合**，
 * `tests/scripts/tui-surface.test.ts` 双向校验：旧底座多读一个变量、或这里留着已不存在的变量，都会红。
 * 写的是「next 上怎么处理」，读取位置相对 `packages/tui/src`。
 */
const NEXT = (files: string) => `保留：${files}`;
export const ENV_DECISIONS: Record<string, string> = {
  __CFBundleIdentifier: NEXT("`terminal/extended-keys.ts`"),
  ALACRITTY_LOG: NEXT("`terminal/extended-keys.ts`"),
  CLAUDE_CODE_ACCESSIBILITY:
    "**改名** `SID_CODE_ACCESSIBILITY`（`cursor-helpers.ts`），功能保留；旧名留作别名到 T9，新名设置了（含空串）以新名为准",
  CLAUDE_CODE_COMMIT_LOG:
    "**删除**：旧底座的临时提交计时埋点（源码注释 temp debugging），next 没有对应插桩；帧耗时看 `bun run tui:bench`",
  CLAUDE_CODE_DEBUG_REPAINTS:
    "**删除**：只给 full reset 打日志；next 的 full reset 原因已经从 `onFrame` 的 `flickers[].reason` 暴露",
  CLAUDE_CODE_TMUX_TRUECOLOR:
    "**改名** `SID_CODE_TMUX_TRUECOLOR`（`colorize.ts`，T2.2 已做）；旧名留作别名到 T9",
  ConEmuANSI: NEXT("`terminal/extended-keys.ts`"),
  ConEmuPID: NEXT("`terminal/extended-keys.ts`"),
  ConEmuTask: NEXT("`terminal/extended-keys.ts`"),
  CURSOR_TRACE_ID: NEXT("`terminal/extended-keys.ts`"),
  GNOME_TERMINAL_SERVICE: NEXT("`terminal/extended-keys.ts`"),
  KITTY_WINDOW_ID: NEXT("`terminal/extended-keys.ts`、`osc.ts`、`sync-output.ts`"),
  KONSOLE_VERSION: NEXT("`terminal/extended-keys.ts`"),
  LC_TERMINAL: NEXT("`terminal/clipboard.ts`、`hyperlinks.ts`"),
  MSYSTEM:
    "保留：`terminal/extended-keys.ts`。旧底座 `clearTerminal.ts` 里的 win32 清屏分支 next 没有（见 `TERM_PROGRAM_VERSION`）",
  NODE_ENV: NEXT("`frame/schedule.ts`（R13）"),
  SESSIONNAME:
    "**不读**：旧底座只拿它认 cygwin，cygwin 不在扩展键白名单里，认出来与认不出来的可观察行为相同",
  SID_CODE_DEBUG:
    "保留（CLI 也读，见 help）。next 底座还不读：渲染层日志进 debug 输出归 T7.1a（E1）",
  SID_CODE_DISABLE_MOUSE_CLICKS:
    "保留。next 底座还不读：点击处理随选区接入归 T6.2b（M1 已钉住它不改变底座写的字节）",
  SID_DISABLE_TAB_STATUS: NEXT("`hooks/use-tab-status.ts`、`ink.tsx`（O2）"),
  SSH_CLIENT: NEXT("`terminal/extended-keys.ts`"),
  SSH_CONNECTION: NEXT("`terminal/extended-keys.ts`、`clipboard.ts`"),
  SSH_TTY: NEXT("`terminal/extended-keys.ts`"),
  STY: NEXT("`terminal/extended-keys.ts`、`osc.ts`、`clipboard.ts`、`sync-output.ts`"),
  TERM: NEXT("`terminal/*`"),
  TERM_PROGRAM: NEXT("`colorize.ts`、`text/bidi.ts`、`terminal/*`"),
  TERM_PROGRAM_VERSION:
    "**不读**：旧底座用它判 OSC 9;4 是否可用（CLI 不发 OSC 9;4，T7.2b）和 win32 VS Code 的清屏序列。next 清屏固定 `2J 3J H`，win32 旧控制台差异未实现，T9 前评估",
  TERMINAL_EMULATOR: NEXT("`terminal/extended-keys.ts`"),
  TERMINATOR_UUID: NEXT("`terminal/extended-keys.ts`"),
  TILIX_ID: NEXT("`terminal/extended-keys.ts`"),
  TMUX: NEXT("`colorize.ts`、`terminal/*`"),
  VisualStudioVersion: NEXT("`terminal/extended-keys.ts`"),
  VSCODE_GIT_ASKPASS_MAIN: NEXT("`terminal/extended-keys.ts`"),
  VTE_VERSION: NEXT("`terminal/extended-keys.ts`、`sync-output.ts`"),
  WSL_DISTRO_NAME: NEXT("`terminal/extended-keys.ts`"),
  WT_SESSION: NEXT("`terminal/extended-keys.ts`、`sync-output.ts`、`text/bidi.ts`"),
  XTERM_VERSION: NEXT("`terminal/extended-keys.ts`"),
  ZED_TERM: NEXT("`terminal/sync-output.ts`"),
};

const SIG_RE = /<!-- surface-signature: ([0-9a-f]+) -->/;

export function renderMarkdown(s: Surface): string {
  const L: string[] = [];
  const sig = signature(s);
  L.push("<!-- 本文件由 scripts/tui-surface.ts 生成，勿手改。重新生成：bun run tui:surface -->");
  L.push(`<!-- surface-signature: ${sig} -->`);
  L.push("");
  L.push("# 渲染端口面（CLI 对渲染底座的全部依赖）");
  L.push("");
  L.push(
    "B9 / T0.1 产物。新底座必须提供这里列出的全部符号与 props；render-port 层覆盖的就是这个范围。",
  );
  L.push(
    "签名只由**集合**决定（符号 / props / 环境变量），计数是生成时快照，日常 UI 改动会让它漂移，不影响签名。",
  );
  L.push("");
  L.push(
    `- 消费底座的源码文件：**${s.srcFiles}** 个（\`packages/cli/src\`，不含 \`ui/render-port/\` 自身）`,
  );
  L.push(`- 直接 import 底座的测试文件：**${s.testFiles.length}** 个（\`packages/cli/tests\`）`);
  L.push(
    `- 符号：**${s.symbols.size}** 个；宿主组件 props：**${s.props.size}** 种；底座读取的环境变量：**${s.envVars.size}** 个`,
  );
  L.push("");

  L.push("## 1. 符号（按引用文件数降序）");
  L.push("");
  L.push("| 符号 | 引用文件数 | 来源模块 | 备注 |");
  L.push("| --- | ---: | --- | --- |");
  const syms = [...s.symbols.entries()].sort(
    (a, b) => b[1].files.size - a[1].files.size || a[0].localeCompare(b[0]),
  );
  for (const [name, e] of syms) {
    const notes = [e.typeOnly ? "仅类型" : "", e.dynamic ? "含动态 import" : ""]
      .filter(Boolean)
      .join("、");
    L.push(
      `| \`${name}\` | ${e.files.size} | ${[...e.modules]
        .sort()
        .map((m) => `\`${m}\``)
        .join("<br>")} | ${notes} |`,
    );
  }
  L.push("");

  L.push("## 2. 宿主组件 props（按出现次数降序）");
  L.push("");
  L.push("「字面量取值」只列静态可知的值；「动态」是表达式取值的次数（运行时才知道值）。");
  L.push("");
  L.push("| 组件.prop | 次数 | 文件数 | 字面量取值（次数） | 动态 |");
  L.push("| --- | ---: | ---: | --- | ---: |");
  const props = [...s.props.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  );
  for (const [key, e] of props) {
    const lits = [...e.literals.entries()].sort((a, b) => b[1] - a[1]);
    const shown = lits.slice(0, 8).map(([v, n]) => `\`${v.replace(/\|/g, "\\|")}\` ${n}`);
    if (lits.length > 8) shown.push(`…另 ${lits.length - 8} 种`);
    L.push(`| \`${key}\` | ${e.count} | ${e.files.size} | ${shown.join("、")} | ${e.dynamic} |`);
  }
  L.push("");

  L.push("## 3. 底座读取的环境变量");
  L.push("");
  L.push(
    "新底座逐个决定保留 / 改名 / 删除（D125，T7.2c 定论）。改名的旧名留作别名，T9 删除旧底座时一并去掉。" +
      "`CLAUDE_CODE_DISABLE_MOUSE` 只出现在旧底座的注释里，从来没有代码读它，所以不在表内。",
  );
  L.push("");
  L.push("| 变量 | 读取位置（相对 tui-renderer/src） | 新底座结论 |");
  L.push("| --- | --- | --- |");
  for (const [name, files] of [...s.envVars.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(
      `| \`${name}\` | ${[...files]
        .sort()
        .map((f) => `\`${f}\``)
        .join("<br>")} | ${ENV_DECISIONS[name] ?? "⚠️ 未定"} |`,
    );
  }
  L.push("");

  const term = s.directWrites.filter((w) => w.kind === "终端序列");
  const plain = s.directWrites.filter((w) => w.kind === "普通输出");
  L.push("## 4. CLI 绕过底座的 stdout 直写");
  L.push("");
  L.push(
    `端口层管不到这些写入，它们和底座写的是同一块终端（设计文档 §1.5）。终端序列 **${term.length}** 处，普通输出 ${plain.length} 处。` +
      "判定是启发式的（参数含转义 / 模式常量 / OSC 变量），T5.3 收口时逐条复核。",
  );
  L.push("");
  L.push("| 位置 | 类型 | 代码 |");
  L.push("| --- | --- | --- |");
  for (const w of [...term, ...plain]) {
    L.push(
      `| \`${w.file}:${w.line}\` | ${w.kind} | \`${w.code.replace(/\|/g, "\\|").slice(0, 100)}\` |`,
    );
  }
  L.push("");

  L.push("## 5. 直接 import 底座的测试文件");
  L.push("");
  for (const f of s.testFiles) L.push(`- \`${f}\``);
  L.push("");
  return L.join("\n");
}

if (import.meta.main) {
  const s = analyze();
  if (process.argv.includes("--check")) {
    const current = existsSync(SURFACE_MD)
      ? SIG_RE.exec(readFileSync(SURFACE_MD, "utf8"))?.[1]
      : undefined;
    const expected = signature(s);
    if (current !== expected) {
      console.error(
        `❌ 渲染端口面变了（SURFACE.md 签名 ${current ?? "缺失"} ≠ 实际 ${expected}）。\n` +
          `   CLI 新增或去掉了底座符号 / props / 环境变量。确认这是有意的之后跑：bun run tui:surface`,
      );
      process.exit(1);
    }
    console.log(`✅ 端口面签名一致：${expected}`);
  } else {
    writeFileSync(SURFACE_MD, renderMarkdown(s));
    console.log(
      `已写 ${relative(ROOT, SURFACE_MD)}：${s.symbols.size} 个符号 / ${s.props.size} 种 props / ` +
        `${s.envVars.size} 个环境变量 / ${s.directWrites.filter((w) => w.kind === "终端序列").length} 处终端直写 / ` +
        `${s.srcFiles} 个源码文件 / ${s.testFiles.length} 个测试文件`,
    );
  }
}
