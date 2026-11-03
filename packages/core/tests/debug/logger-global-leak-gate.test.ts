/**
 * 全局 logger 状态跨测试泄漏防复发门禁（D60）
 *
 * ## 它防的是什么
 *
 * `initLogger()` 改的是**进程级单例**（`debug/logger.ts`：恒定返回同一个实例并原地
 * reconfigure），所以一个测试文件把 logger 打开之后，如果没有复位，**同进程后续所有
 * 测试文件**都继承这个状态。而 logger 的 `console` 默认是 `true`、非 ERROR 级别走
 * `console.log`，于是下一个"把 console.log 整段捕获再解析"的测试就会莫名其妙地红。
 *
 * D60 的实测形态：`packages/core/tests/config/sid-home-path-derivation.test.ts` 打开
 * logger 却没复位 → `packages/cli/tests/command/agents-summarize-tools.test.ts` 的
 * `captureJson()` 把整段 `console.log` 当 JSON 解析 → `SyntaxError: Unrecognized
 * token '^['`（`^[` 是 ANSI 转义 `\x1b`）。只红一次、重跑就绿，极难归因。
 *
 * ## 判据（为什么是这三条）
 *
 * 一次 `initLogger(...)` 调用只要**可能往控制台打**，就必须显式声明"只写文件"：
 *
 * 1. `enabled` 未写或为 `false` → 不算污染（`normalizeOptions` 的默认值是 false）。
 * 2. `enabled` 为 `true`（或非字面量表达式，无法静态判定时保守处理）时，
 *    必须同时出现 `console: false` 或 `fileOnly: true` —— 二者任一都会让
 *    `Logger.log()` 跳过 `writeToConsole()`。
 * 3. 无法静态判定的 `enabled` 按"可能打开"处理：宁可让人补一行显式声明，
 *    也不要漏掉下一条同形泄漏。
 *
 * ## 为什么不检查"有没有复位"
 *
 * 复位是**时序**防护（`afterEach` 才安全，写在用例末尾在断言失败时执行不到），
 * 静态扫描无法可靠判定它是否覆盖了失败路径。`console: false` / `fileOnly: true`
 * 是**结构性**防护：打开时就不具备污染 console 的能力，与时序无关。所以判据选后者。
 *
 * ## 本门禁抓不到什么
 *
 * - 不打开 logger、但直接 `console.log` 的测试（不是本缺陷的形态，无法与合法的
 *   调试输出区分）。
 * - 字符串/模板字符串里的示意代码会被当作真调用扫到（不解析字符串是为了避免
 *   状态机在正则字面量上失灵 —— 同压力在 `sid-home-path-derivation.test.ts` 的
 *   `toCodeOnlyLines` 注释里有记录）。真出现误报时，把示例拆成拼接字符串。
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SELF = "logger-global-leak-gate.test.ts";

/**
 * 去掉注释再扫。行级分类（取每行最靠左的 `//` 或 `/*`），与
 * `sid-home-path-derivation.test.ts` 的 `toCodeOnlyLines` 同口径。
 *
 * 为什么复制而不是 import 那个函数：import 一个 `.test.ts` 会把它的 describe 一并
 * 注册进当前进程，等于把被测对象和门禁揉在一起；门禁要能独立运行。
 *
 * 为什么必须去注释：本仓大量注释**刻意**引用 `initLogger({ enabled: true, ... })`
 * 这类写法来说明"为什么不能这么写"。不去注释会逼下一个人删掉那些解释 —— 那比没有门禁更糟。
 */
function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split("\n")) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    let scanFrom = 0;
    for (;;) {
      let lineAt = -1;
      for (let i = scanFrom; i + 1 < line.length; i++) {
        if (line[i] === "/" && line[i + 1] === "/") {
          const prev = i > 0 ? line[i - 1] : "";
          if (prev === ":" || prev === "/") continue; // 避开 https://
          lineAt = i;
          break;
        }
      }
      const blockAt = line.indexOf("/*", scanFrom);
      if (lineAt === -1 && blockAt === -1) break;
      if (lineAt !== -1 && (blockAt === -1 || lineAt < blockAt)) {
        line = line.slice(0, lineAt);
        break;
      }
      const end = line.indexOf("*/", blockAt + 2);
      if (end === -1) {
        line = line.slice(0, blockAt);
        inBlock = true;
        break;
      }
      line = line.slice(0, blockAt) + line.slice(end + 2);
      scanFrom = blockAt;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 从 `initLogger(` 的左括号位置起，按括号配对取出完整实参文本。
 * 跳过字符串 / 模板字符串里的括号，避免 `logFile: join(dir, "x")` 之外的干扰。
 */
function extractCallArgs(src: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  // 括号不配对（截断的源码/示意片段）时返回到行尾，仍然参与判据
  return src.slice(openParen + 1);
}

/** 该次调用是否可能把日志打到控制台。 */
function isConsoleLeaking(args: string): boolean {
  const enabled = /\benabled\s*:\s*([^,\n}]+)/.exec(args);
  if (!enabled) return false; // normalizeOptions 默认 enabled: false
  const value = enabled[1]!.trim();
  if (value === "false") return false;
  // 不是字面量 false 时保守视为"可能打开"：变量、表达式、以及 true
  const consoleOff = /\bconsole\s*:\s*false\b/.test(args);
  const fileOnlyOn = /\bfileOnly\s*:\s*true\b/.test(args);
  return !(consoleOff || fileOnlyOn);
}

/** 扫一份源码，返回会往控制台打日志的 `initLogger(...)` 调用（带行号与实参）。 */
function scanForConsoleLeak(src: string): { line: number; args: string }[] {
  const code = stripComments(src);
  const hits: { line: number; args: string }[] = [];
  const re = /\binitLogger\s*\(/g;
  for (const m of code.matchAll(re)) {
    const openParen = m.index! + m[0].length - 1;
    const args = extractCallArgs(code, openParen);
    if (!isConsoleLeaking(args)) continue;
    const line = code.slice(0, m.index!).split("\n").length;
    hits.push({ line, args: args.replace(/\s+/g, " ").trim() });
  }
  return hits;
}

/**
 * 豁免清单，每条都要写理由 —— 不写理由的豁免半年后会变成"当初大概有原因"。
 *
 * 这是**唯一**一个合法需要 `console: true` 的测试：它的被测对象就是 `consoleToStderr`
 * 的控制台分流（断言 INFO 走 stderr、stdout 保持干净），声明 `console: false` 会让
 * 用例失去意义。它已经在 `finally` 里 `initLogger({ enabled: false })` 复位。
 */
const EXEMPT = [
  {
    file: "packages/core/tests/daemon/unattended-pipeline.test.ts",
    reason:
      "被测对象就是 consoleToStderr 的控制台分流（必须 console: true 才能验），且 finally 里已复位",
  },
] as const;

function collectTestFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      collectTestFiles(full, acc);
    } else if (entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("防复发门禁：测试不许把全局 logger 打开成往控制台打", () => {
  /**
   * 全部测试根。少扫一个根 = 那个包里的泄漏无人拦，而本门禁仍然报绿 ——
   * 这正是 `no-real-path-writes.test.ts` 用同样写法覆盖 6 个根的原因。
   */
  const testRoots = [
    join(REPO_ROOT, "packages", "core", "tests"),
    join(REPO_ROOT, "packages", "cli", "tests"),
    join(REPO_ROOT, "packages", "shared", "tests"),
    join(REPO_ROOT, "packages", "tui", "tests"),
    join(REPO_ROOT, "tests"),
    join(REPO_ROOT, "plugins", "tests"),
  ];

  test("每个打开 logger 的测试都声明了 console: false / fileOnly: true", () => {
    const files = testRoots.flatMap((r) => collectTestFiles(r));
    // 扫描面非空：目录挪走/改名时不能静默变成"永远通过"
    expect(files.length).toBeGreaterThan(100);

    const violations: string[] = [];
    let scannedCalls = 0;

    for (const file of files) {
      if (file.endsWith(SELF)) continue; // 本文件的变异自证用例里就写着违规示例
      const rel = file.slice(REPO_ROOT.length + 1);
      if (EXEMPT.some((x) => x.file === rel)) continue;
      const text = readFileSync(file, "utf-8");
      if (!text.includes("initLogger")) continue;
      scannedCalls++;
      for (const hit of scanForConsoleLeak(text)) {
        violations.push(`  - ${rel}:${hit.line} → initLogger(${hit.args})`);
      }
    }

    // 至少扫到几个真实调用方：正则或函数名漂移时先在这条失败，而不是门禁空转成绿灯。
    // 故意写低（实测 8 个文件 / 14 处调用）：写成精确相等会让"新增一个合规测试"也变红。
    expect(scannedCalls).toBeGreaterThanOrEqual(5);

    if (violations.length > 0) {
      throw new Error(
        `以下 initLogger 调用会把日志打到控制台，泄漏给同进程后续测试文件（D60）：\n` +
          `${violations.join("\n")}\n\n` +
          `修法：加 console: false（或 fileOnly: true），并在 afterEach 里 ` +
          `initLogger({ enabled: false }) 复位。\n` +
          `理由见 packages/core/tests/debug/logger-global-leak-gate.test.ts 的文件头注释。`,
      );
    }
  });

  test("变异自证：违规写法能被抓到（否则这条门禁是死的）", () => {
    const bad = [
      // D60 的两个真实形态
      "const logger = initLogger({ enabled: true, logFile: defaultConfig().debugLogFile });",
      "const logger = initLogger({ enabled: true, level: LogLevel.WARN });",
      // 多行对象字面量同样要抓到
      "initLogger({\n  enabled: true,\n  level: LogLevel.WARN,\n  logFile: f,\n});",
      // 非字面量 enabled：无法静态判定，保守报红
      "initLogger({ enabled: flag, fileOnly: false });",
    ];
    for (const src of bad) {
      expect(scanForConsoleLeak(src).length, src).toBeGreaterThan(0);
    }
  });

  test("变异自证：合规写法不误报", () => {
    const ok = [
      "initLogger({ enabled: true, level: LogLevel.WARN, console: false });",
      "initLogger({ enabled: true, console: false, fileOnly: false });",
      "initLogger({ enabled: true, fileOnly: true });",
      "initLogger({ enabled: false });",
      // 不写 enabled 时 normalizeOptions 默认 false，不算污染
      'initLogger({ logFile: join(dir, "debug.log") });',
      // 跨行 + 嵌套调用
      'initLogger({\n  enabled: true,\n  logFile: join(dir, "debug.log"),\n  console: false,\n});',
    ];
    for (const src of ok) {
      expect(scanForConsoleLeak(src), src).toEqual([]);
    }
  });

  test("变异自证：注释里的示意代码不误报（否则会逼人删掉解释性注释）", () => {
    const commented = [
      "// 修法：不要写 initLogger({ enabled: true })，要写 console: false",
      "/** 旧写法 initLogger({ enabled: true, level: LogLevel.WARN }) 会泄漏 */",
      "/*\n * initLogger({ enabled: true })\n */",
      "// 想看原始 URL 用 https://example.com/initLogger({ enabled: true })",
    ];
    for (const src of commented) {
      expect(scanForConsoleLeak(src), src).toEqual([]);
    }
  });

  test("变异自证：带引号实参里的括号不会截断判定", () => {
    // 实参里有字符串含 ")" 时，朴素配对会提前闭合，把后面的 console: false 漏掉 → 误报。
    const src = 'initLogger({ enabled: true, logFile: join(dir, "a)b.log"), console: false });';
    expect(scanForConsoleLeak(src)).toEqual([]);
  });
});
