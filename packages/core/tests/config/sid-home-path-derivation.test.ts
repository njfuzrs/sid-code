/**
 * `SID_CONFIG_DIR` 必须管得住所有配置根目录派生路径（含 debug.log / audit.log）。
 *
 * ## 缺陷本体
 *
 * `debugLogFile` / `auditLogFile` 的默认值曾是**字面量** `"~/.sid-code/debug.log"`
 * （`config/config.ts` 与 `config/app-config.ts` 各一份副本），而展开侧
 * （`debug/logger.ts`）用 `join(homedir(), p.slice(1))` —— `homedir()` 不读 env。
 * 于是 `SID_CONFIG_DIR=<tmp>` 把配置目录隔离了，**日志仍写真实 HOME**。
 * 实测（修复前）：`SID_CONFIG_DIR=/tmp/probe/cfg` 下 `logFilePath` 仍是
 * `/Users/<user>/.sid-code/debug.log`，`/tmp/probe/cfg` 里一个文件都没有。
 *
 * 排查发现这不是一个 typo 而是结构性问题：`config/paths.ts` 的模块注释两处明写
 * 「杜绝各模块自行 `join(homedir(), ".sid-code", ...)`」，实际违反者 6 处
 * （debug.log ×2 副本 / audit.log ×3 副本 / output-styles / rules / daemon logs /
 * compact-stats），且 `trace/digest.ts` 用的是**另一个 env 名** `SID_CODE_HOME`，
 * 与权威定义的 `SID_CONFIG_DIR` 互不认识。
 *
 * ## 两道判据，缺一不可
 *
 * 1. **行为**：默认值与 logger 展开都跟随 `SID_CONFIG_DIR`（并覆盖老用户
 *    `app.json` 里已经存着字面量的情形 —— 磁盘值优先于新默认值，只改默认值对他们无效）。
 * 2. **静态门禁**：各包 src 下不许新增 `join(homedir(), ".sid-code"` 与
 *    `"~/.sid-code` 字面量。这条拦的是**下一个**违反者 —— 上面那 6 处说明
 *    「注释里写明令禁止」这种防线的实际拦截率是 0。
 *
 * ⚠ 门禁本身做了变异自证（见 `新增违规能被抓到` 用例）：往扫描器喂一段人造违规源码，
 * 断言它报出来。否则这条门禁会变成又一条「防线全在、调用全 0」的死门禁。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSidHome,
  sidHomePath,
  sidPaths,
  expandSidHomePath,
} from "@sid-code/core/config/paths.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { createDefaultAppConfig } from "@sid-code/core/config/app-config.ts";
import { initLogger } from "@sid-code/core/debug/logger.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("SID_CONFIG_DIR 覆盖日志落盘路径（缺陷 B 本体）", () => {
  let TMP: string;
  /** 进程原有值（可能是 preload 设的隔离兜底），afterEach 必须还回去 —— 直接 delete 会把兜底一起抹掉 */
  let prevConfigDir: string | undefined;
  let prevCodeHome: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    prevCodeHome = process.env.SID_CODE_HOME;
    TMP = mkdtempSync(join(tmpdir(), "sid-home-derive-"));
    process.env.SID_CONFIG_DIR = TMP;
    delete process.env.SID_CODE_HOME;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    if (prevCodeHome === undefined) delete process.env.SID_CODE_HOME;
    else process.env.SID_CODE_HOME = prevCodeHome;
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("defaultConfig 的 debugLogFile / auditLogFile 落在 SID_CONFIG_DIR 下", () => {
    const c = defaultConfig();
    expect(c.debugLogFile).toBe(join(TMP, "debug.log"));
    expect(c.auditLogFile).toBe(join(TMP, "audit.log"));
    // 反向断言：不含 `~` 字面量。修复前这里是 "~/.sid-code/debug.log"。
    expect(c.debugLogFile).not.toContain("~");
  });

  test("createDefaultAppConfig 的 debugLogFile 与 defaultConfig 一致（两份副本不许漂移）", () => {
    expect(createDefaultAppConfig().debugLogFile).toBe(defaultConfig().debugLogFile);
  });

  test("logger 真的把日志写进 SID_CONFIG_DIR（不只是路径字符串对）", async () => {
    const logger = initLogger({ enabled: true, logFile: defaultConfig().debugLogFile });
    expect(logger.getLogFilePath()).toBe(join(TMP, "debug.log"));
    logger.info("TEST", "sid-home-derivation 探针");
    // logger 用 createWriteStream（异步），落盘不在同一 tick —— 让事件循环转一圈再断言。
    // 只断言路径字符串会漏掉"路径对但写不进去"，所以这条必须看文件真的出现。
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(TMP, "debug.log"))).toBe(true);
  });

  test("老用户 app.json 里存着的 ~/.sid-code 字面量也被重定向", () => {
    // 磁盘值优先于新默认值：`saveAppConfig` 会把当时的默认值连带写进 app.json，
    // 所以老用户的磁盘上就是那个字面量 —— 只改默认值对他们完全无效，必须在展开侧兜住。
    expect(expandSidHomePath("~/.sid-code/debug.log")).toBe(join(TMP, "debug.log"));
    expect(expandSidHomePath("~\\.sid-code\\debug.log")).toBe(join(TMP, "debug.log"));
  });

  test("用户手写的其它 ~ 路径语义不变（仍展开到真实家目录）", () => {
    // 这条是防「修得过头」：把所有 `~` 都指向 SID_CONFIG_DIR 会让
    // settings.json 里手写的 "~/somewhere/x.log" 落到配置目录里去。
    const expanded = expandSidHomePath("~/somewhere/x.log");
    expect(expanded.endsWith(join("somewhere", "x.log"))).toBe(true);
    expect(expanded.startsWith(TMP)).toBe(false);
  });

  test("非 ~ 开头的绝对路径原样返回", () => {
    expect(expandSidHomePath("/var/log/sid.log")).toBe("/var/log/sid.log");
    // `~foo`（无分隔符）不是家目录语法，不许拼成 `<home>foo` —— 旧 logger 的 slice(1) 就是这么错的
    expect(expandSidHomePath("~foo")).toBe("~foo");
  });

  test("sidPaths.debugLog / auditLog 与 sidHomePath 同源", () => {
    expect(sidPaths.debugLog()).toBe(sidHomePath("debug.log"));
    expect(sidPaths.auditLog()).toBe(sidHomePath("audit.log"));
  });
});

describe("SID_CODE_HOME 收敛为兼容别名（env 名分裂修复）", () => {
  let prevConfigDir: string | undefined;
  let prevCodeHome: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    prevCodeHome = process.env.SID_CODE_HOME;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    if (prevCodeHome === undefined) delete process.env.SID_CODE_HOME;
    else process.env.SID_CODE_HOME = prevCodeHome;
  });

  test("只设 SID_CODE_HOME 时 getSidHome 也认（老用户脚本不被静默打断）", () => {
    delete process.env.SID_CONFIG_DIR;
    process.env.SID_CODE_HOME = "/tmp/sid-legacy-home";
    expect(getSidHome()).toBe("/tmp/sid-legacy-home");
  });

  test("两个都设时 SID_CONFIG_DIR 优先（它是权威名）", () => {
    process.env.SID_CONFIG_DIR = "/tmp/sid-authoritative";
    process.env.SID_CODE_HOME = "/tmp/sid-legacy-home";
    expect(getSidHome()).toBe("/tmp/sid-authoritative");
  });

  test("空串视为未设置，回落下一档", () => {
    process.env.SID_CONFIG_DIR = "   ";
    process.env.SID_CODE_HOME = "/tmp/sid-legacy-home";
    expect(getSidHome()).toBe("/tmp/sid-legacy-home");
  });

  test("trace 的 resolvePaths 认 SID_CONFIG_DIR（此前只认 SID_CODE_HOME）", async () => {
    delete process.env.SID_CODE_HOME;
    process.env.SID_CONFIG_DIR = "/tmp/sid-trace-authoritative";
    const { resolvePaths } = await import("@sid-code/core/trace/digest.ts");
    expect(resolvePaths().root).toBe("/tmp/sid-trace-authoritative");
  });
});

// ───────────────────────── 静态门禁 ─────────────────────────

/**
 * 违规形态。两条都是「绕过 getSidHome()、直接从 homedir() 派生配置根目录」。
 */
const FORBIDDEN_PATTERNS = [
  { name: 'join(homedir(), ".sid-code"', re: /homedir\(\)\s*,\s*"\.sid-code"/ },
  { name: '"~/.sid-code" 字面量', re: /"~[/\\]\\?\.sid-code/ },
] as const;

/**
 * 豁免清单，每条都要写理由 —— 不写理由的豁免会在半年后变成"当初大概有原因"。
 *
 * - `config/paths.ts`：权威定义本身，`getSidHome()` 的回落分支必须自己拼一次。
 * - `skill/builtin/skill-creator/scripts/init_skill.ts`：**独立脚本**，由 skill 以
 *   子进程方式跑，不在 harness 的模块图里，import 不到 `@sid-code/core`。它已经
 *   正确读了 `SID_CONFIG_DIR`（`process.env.SID_CONFIG_DIR?.trim() || …`）。
 * - `skill/builtin-embedded.generated.ts`：生成物（把 skill 脚本原文嵌成字符串）。
 * - `cli/src/ui/utils/memory-files.ts`：那个字面量是**给用户看的显示名**
 *   （`probe(sidHomePath("CLAUDE.md"), "~/.sid-code/CLAUDE.md", …)` —— 真实路径已走
 *   `sidHomePath`，第二个参数只是 UI 上那行字）。
 */
const EXEMPT = [
  "packages/core/src/config/paths.ts",
  "packages/core/src/skill/builtin/skill-creator/scripts/init_skill.ts",
  "packages/core/src/skill/builtin-embedded.generated.ts",
  "packages/cli/src/ui/utils/memory-files.ts",
] as const;

/**
 * 去掉注释再扫。
 *
 * 必要性：本仓大量注释**刻意**引用这两个字面量来说明「为什么不能改回去」
 * （`CONTRIBUTING.md`：这类注释是资产，不许因为看着啰嗦就删）。不去注释的话，
 * 门禁会逼下一个人删掉那些解释，正好把知识删干净 —— 那比没有门禁更糟。
 *
 * ## 为什么是行级分类，不是逐字符状态机
 *
 * 先写的是逐字符状态机（追踪 `"` / `'` / 反引号，以便区分字符串里的 `//` 与真注释），
 * 它**在本仓真实源码上失灵**：`output-styles.ts:58` 有正则字面量
 * `replace(/^["']|["']$/g, "")` —— 状态机不认识正则字面量，把里面的 `"` 当成字符串
 * 开头，此后整个文件的状态全乱，`/** … *\/` 块注释一路当代码扫，于是误报三处注释。
 *
 * 行级分类只需一条规则：在每行里**从左到右找第一个注释开启标记**（`//` 或 `/*`），
 * 按它的类型处理。顺序必须是"取最靠左的那个"，不能先扫完块注释再扫行注释 ——
 * 后者在本仓踩过：`config.ts` 有一行行注释写着 `不写 "~/.sid-code/*.log" 字面量`，
 * 里面那个 `/*` 被当成块注释开启，于是往下 13 行代码全被吞掉，
 * **门禁在有违规时仍然报绿**（12 pass 里没有它）。
 *
 * `//` 前一个字符是 `:` 或 `/` 时不算注释（避开 `https://`）。
 *
 * 代价是诚实的：把 `//` 或 `/*` 写在字符串里（`"a//b"`）会被误截。真出现了会让门禁
 * **漏报**而不是误报 —— 对一条"拦下一个违反者"的门禁来说这个方向可接受，
 * 误报的方向不可接受（它会逼人删掉解释性注释）。
 */
export function toCodeOnlyLines(src: string): string[] {
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
    // 从左到右找最靠左的注释开启标记
    let scanFrom = 0;
    for (;;) {
      let lineAt = -1;
      for (let i = scanFrom; i + 1 < line.length; i++) {
        if (line[i] === "/" && line[i + 1] === "/") {
          const prev = i > 0 ? line[i - 1] : "";
          if (prev === ":" || prev === "/") continue;
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
  return out;
}

/** 扫一份源码，返回命中的 `{line, pattern, text}`。导出供变异自证复用。 */
export function scanForForbidden(src: string): { line: number; pattern: string; text: string }[] {
  const hits: { line: number; pattern: string; text: string }[] = [];
  toCodeOnlyLines(src).forEach((text, idx) => {
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.re.test(text)) hits.push({ line: idx + 1, pattern: p.name, text: text.trim() });
    }
  });
  return hits;
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "_vendor") continue;
      collectSourceFiles(full, acc);
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("门禁：不许绕过 getSidHome() 派生配置根目录", () => {
  test("packages/*/src 下零违规", () => {
    const pkgRoot = join(REPO_ROOT, "packages");
    const pkgs = readdirSync(pkgRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(pkgRoot, e.name, "src"));

    const violations: string[] = [];
    for (const src of pkgs) {
      for (const file of collectSourceFiles(src)) {
        const rel = file.slice(REPO_ROOT.length + 1);
        if (EXEMPT.some((x) => rel === x)) continue;
        for (const hit of scanForForbidden(readFileSync(file, "utf-8"))) {
          violations.push(`${rel}:${hit.line} [${hit.pattern}] ${hit.text}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("变异自证：新增违规能被抓到（否则这条门禁是死的）", () => {
    const fakeViolations = [
      'const dir = join(homedir(), ".sid-code", "output-styles");',
      'debugLogFile: "~/.sid-code/debug.log",',
    ];
    for (const line of fakeViolations) {
      expect(scanForForbidden(line).length).toBeGreaterThan(0);
    }
  });

  test("变异自证：注释里的同款字面量不报（否则会逼人删掉解释性注释）", () => {
    const comments = [
      '// 此前这里写 join(homedir(), ".sid-code")，不读 env',
      '/** 默认值曾是 "~/.sid-code/debug.log" 字面量 */',
      '/*\n * join(homedir(), ".sid-code", "logs")\n */',
    ];
    for (const src of comments) {
      expect(scanForForbidden(src)).toEqual([]);
    }
  });

  test("变异自证：行注释里含 /* 不会吞掉后续代码（这条曾让门禁在有违规时报绿）", () => {
    // 实测过的失败形态：先扫块注释再扫行注释，则下面第 1 行里的 `/*` 被当成块注释开启，
    // 第 2 行的真违规被整行吞掉，门禁报绿。判据是"最靠左的注释标记胜出"。
    const src = [
      '// 不写 "~/.sid-code/*.log" 字面量：',
      'debugLogFile: "~/.sid-code/debug.log",',
    ].join("\n");
    const hits = scanForForbidden(src);
    expect(hits.length).toBe(1);
    expect(hits[0]!.line).toBe(2);
  });

  test("变异自证：合规写法不误报", () => {
    const ok = [
      'const dir = sidHomePath("output-styles");',
      "debugLogFile: sidPaths.debugLog(),",
      'return join(getSidHome(), "trajectories", "sessions");',
    ];
    for (const src of ok) {
      expect(scanForForbidden(src)).toEqual([]);
    }
  });
});

// ───────────────────── 运行时判据：假 HOME 子进程 ─────────────────────

/**
 * 观察副作用而不是观察断言结果 —— `CLAUDE.md` 那条实测教训：污染时测试同样全绿。
 *
 * 手法与 `tests/build/no-real-trajectory-writes-runtime.test.ts` 同源：把 `HOME`
 * 指向临时目录起子进程（`homedir()` 读 `$HOME`，但**只在进程启动时**生效，所以必须
 * 起子进程），再看那个假家目录有没有被写。用假 HOME 而不是数真实家目录的差值，
 * 是因为这个仓库多任务并行是常态 —— 数真实目录会被别的终端里正在跑的会话搞成假红。
 */
describe("运行时判据：SID_CONFIG_DIR 生效时假 HOME 不被写", () => {
  /**
   * 清理放在 afterEach 而不是用例末尾。
   *
   * 理由是实测踩到的：断言失败时 `test()` 体当场抛出，末尾的 `rmSync` 根本不执行 ——
   * 于是**仓库根**留下 4 个 `.tmp-sid-home-probe-xxxxxx` 目录。在这个"随时有多个任务并行"的仓库里，
   * 工作区里冒出来的目录会被下一个人误判成别人的在途工作（`CLAUDE.md` 那条铁律的反面：
   * 判错了就可能被误删）。所以自建的临时目录必须在失败路径上也清掉。
   */
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("debug.log 落在 SID_CONFIG_DIR，假家目录零新增", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "sid-fake-home-"));
    created.push(fakeHome);
    const cfgDir = join(fakeHome, "isolated-cfg");
    mkdirSync(cfgDir, { recursive: true });

    // 探针脚本落在**仓库内**的临时目录：`@sid-code/core/...` 是 workspace 别名，
    // 放在 /tmp 下的文件解析不到它（实测 `Cannot find module '@sid-code/core/config/config.ts'`）。
    const probeDir = mkdtempSync(join(REPO_ROOT, ".tmp-sid-home-probe-"));
    created.push(probeDir);
    const probe = join(probeDir, "probe.ts");
    await Bun.write(
      probe,
      [
        `import { defaultConfig } from "@sid-code/core/config/config.ts";`,
        `import { initLogger } from "@sid-code/core/debug/logger.ts";`,
        // fileOnly：不让日志本身也打到 stdout，否则它会混进下面要断言的那行路径
        `const lg = initLogger({ enabled: true, console: false, fileOnly: true, logFile: defaultConfig().debugLogFile });`,
        `lg.info("PROBE", "hello");`,
        `await new Promise((r) => setTimeout(r, 50));`,
        `console.log(lg.getLogFilePath());`,
      ].join("\n"),
    );

    const proc = Bun.spawn(["bun", probe], {
      cwd: REPO_ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: fakeHome, SID_CONFIG_DIR: cfgDir },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code, `子进程失败: ${stderr}`).toBe(0);
    expect(stdout.trim()).toBe(join(cfgDir, "debug.log"));
    expect(existsSync(join(cfgDir, "debug.log"))).toBe(true);
    // 关键判据：修复前这里会出现 <fakeHome>/.sid-code/debug.log
    expect(existsSync(join(fakeHome, ".sid-code"))).toBe(false);
    // 清理走 afterEach（见 describe 顶部注释）：断言失败时这里执行不到
  }, 30_000);
});
