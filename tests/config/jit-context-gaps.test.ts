/**
 * JIT 上下文机制 — 对标 CC 缺口修复的回归测试
 *
 * 覆盖 docs/bugfixes/todo/20260731-上下文JIT机制-对标CC全量缺口清单与优化方案.md
 * §12.5 的单测清单。每个 describe 对应一条缺口，注释里写清「修复前的错误行为」——
 * 断言本身看不出这一点，而不知道原来错在哪的人很容易把测试改绿。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync,
  utimesSync, chmodSync, existsSync, realpathSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setCwd, getCwd } from "@sid-code/core/bootstrap/state.ts";
import { JitContextManager } from "@sid-code/core/config/jit-context.ts";
import { MAX_MEMORY_CHARACTER_COUNT, getLargeMemoryFiles, resetLargeMemoryFiles } from "@sid-code/core/config/rules.ts";
import { collectJitAccessedPaths } from "@sid-code/core/tool/jit-affected-paths.ts";
import { mergeJitContextIntoPrompt } from "@sid-code/cli/app.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";

let base: string;
let proj: string;
/** 各测试都要 chdir 到 fixture（相对路径归一化依赖 cwd），跑完复原 */
let originalCwd: string;
let originalStateCwd: string;

// 注：凡是拿路径做**等值**断言的用例都要先 realpath。macOS 的 `os.tmpdir()` 返回
// `/var/folders/...`，而 `/var → /private/var` 是 symlink —— JIT 内部一切路径都过
// `safeResolvePath`，于是「登记的 realpath 键」与「测试手里的 /var 路径」字面不等。

beforeEach(() => {
  originalCwd = process.cwd();
  originalStateCwd = getCwd();
  base = mkdtempSync(join(tmpdir(), "jit-gaps-"));
  proj = join(base, "proj");
  mkdirSync(join(proj, "src", "ui"), { recursive: true });
  writeFileSync(join(proj, "src", "ui", "Footer.tsx"), "export const F = 1\n");
  resetLargeMemoryFiles();
});

afterEach(() => {
  process.chdir(originalCwd);
  setCwd(originalStateCwd);
  rmSync(base, { recursive: true, force: true });
  resetLargeMemoryFiles();
});

/**
 * 切到 fixture 目录。**两者都要切**：
 * - `process.chdir` 影响 `relative()` / `Bun.Glob` 等直接读进程 cwd 的调用；
 * - `setCwd` 影响 `normalizeToolPath` 的默认基准 —— 它读的是 bootstrap 全局 cwd
 *   而**不是** `process.cwd()`（为的是让 bash `cd` 能带动所有文件类工具，
 *   见 `path-utils.ts:29` 注释）。只 chdir 不 setCwd 时，传相对 projectRoot
 *   会被解析到真实仓库目录去，测试拿到的是本仓库自己的 CLAUDE.md。
 */
function chdirFixture(dir: string): void {
  process.chdir(dir);
  setCwd(realpathSync(dir));
}

describe("P1-4 路径归一化：相对路径 / ./ 前缀不得让 JIT 静默失效", () => {
  // 修复前：dirname("src/ui/Footer.tsx") = "src/ui"，与绝对 projectRoot 比对必然失败，
  // while 循环一次都不进 → 静默返回 null，无 warn 无 debug，纯黑洞。
  test.each([
    ["绝对路径", (root: string) => join(root, "src", "ui", "Footer.tsx")],
    ["相对路径", () => "src/ui/Footer.tsx"],
    ["./ 前缀", () => "./src/ui/Footer.tsx"],
  ])("%s 形态都应命中同一份规则", async (_label, build) => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const mgr = new JitContextManager();
    const ctx = await mgr.discoverContext(build(proj), proj);
    expect(ctx).toContain("UI_MARKER");
  });

  test("projectRoot 传相对路径也应工作（两侧同口径归一化）", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const ctx = await new JitContextManager().discoverContext("src/ui/Footer.tsx", ".");
    expect(ctx).toContain("UI_MARKER");
  });

  test("含 null byte 的路径被跳过而不抛出（不能让畸形入参中断整批）", async () => {
    chdirFixture(proj);
    const ctx = await new JitContextManager().discoverContext("src/\0ui/x.tsx", proj);
    expect(ctx).toBeNull();
  });
});

describe("P2-5 路径口径：不得 toLowerCase（大小写敏感 FS 上两份规则会撞成一份）", () => {
  // 修复前：normalizedDir = targetDir.toLowerCase()，于是 src/Ui 与 src/ui 被判为
  // 同一目录 → 先访问哪个，另一个的规则就永远拿不到。
  test("src/Ui 与 src/ui 是两个独立目录，各自的规则都应能加载", async () => {
    mkdirSync(join(proj, "src", "Ui"), { recursive: true });
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# lower\nLOWER_MARKER");
    writeFileSync(join(proj, "src", "Ui", "CLAUDE.md"), "# upper\nUPPER_MARKER");
    writeFileSync(join(proj, "src", "Ui", "a.tsx"), "x\n");
    chdirFixture(proj);

    // 本机 FS 是否区分大小写 —— 决定这个用例断言什么。
    // 大小写不敏感（macOS APFS 默认 / Windows NTFS）时上面两次 writeFileSync 写的是
    // **同一个 inode**，第二次直接覆盖第一次：`src/ui/CLAUDE.md` 的内容已经是 UPPER。
    // 此时「LOWER_MARKER 拿不到」是文件系统的事实，不是 JIT 的缺陷，断它必然假失败。
    const caseSensitive = !existsSync(join(proj, "src", "UI", "CLAUDE.md"));

    const mgr = new JitContextManager();
    const lower = await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    const upper = await mgr.discoverContext(join(proj, "src", "Ui", "a.tsx"), proj);

    if (caseSensitive) {
      // 真正要守的行为：两个目录各自的规则都能拿到（旧实现 toLowerCase 后第二份永远拿不到）
      expect(lower).toContain("LOWER_MARKER");
      expect(upper).toContain("UPPER_MARKER");
    } else {
      // 不敏感 FS 上两条路径是同一份文件：首次注入，二次去重返回 null。
      // 这里能守的是「不把两个不同目录的规则串味」——realpath 去重后二次不应重复注入。
      expect(lower).toContain("UPPER_MARKER"); // 被第二次写覆盖后的真实内容
      expect(upper).toBeNull();
    }
  });
});

describe("P0-2 符号链接不得跨出项目边界", () => {
  // 修复前：路径段比对只挡住 proj-evil 这类字符串前缀兄弟目录（P0-1），
  // symlink 形态（proj/link → /outside）仍能爬出去把项目外规则注入进来。
  test("项目内 symlink 指向项目外时，项目外的 CLAUDE.md 不得被注入", async () => {
    const outside = join(base, "outside");
    mkdirSync(join(outside, "sub"), { recursive: true });
    writeFileSync(join(outside, "CLAUDE.md"), "# 项目外\nOUTSIDE_LEAK_MARKER");
    writeFileSync(join(outside, "sub", "a.ts"), "x\n");
    symlinkSync(outside, join(proj, "link"));
    chdirFixture(proj);

    const ctx = await new JitContextManager().discoverContext(join(proj, "link", "sub", "a.ts"), proj);
    expect(ctx).toBeNull();
  });

  test("祖先链中途是 symlink 时同样挡住（入口在项目内也不放行）", async () => {
    const outside = join(base, "vendor-real");
    mkdirSync(join(outside, "pkg"), { recursive: true });
    writeFileSync(join(outside, "CLAUDE.md"), "# 项目外\nOUTSIDE_LEAK_MARKER");
    writeFileSync(join(outside, "pkg", "b.ts"), "x\n");
    // proj/vendor 是 symlink，其下 pkg/b.ts 的祖先链会爬到项目外
    symlinkSync(outside, join(proj, "vendor"));
    chdirFixture(proj);

    const ctx = await new JitContextManager().discoverContext(join(proj, "vendor", "pkg", "b.ts"), proj);
    expect(ctx === null || !ctx.includes("OUTSIDE_LEAK_MARKER")).toBe(true);
  });

  test("项目根本身是 symlink 时规则仍能正常加载（边界两侧同口径，不得误伤）", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    const linkRoot = join(base, "proj-link");
    symlinkSync(proj, linkRoot);
    chdirFixture(linkRoot);

    // 经链接路径访问 + 用链接路径当 projectRoot：只解引用一侧会导致比对失败、一份都加载不到
    const ctx = await new JitContextManager().discoverContext(
      join(linkRoot, "src", "ui", "Footer.tsx"),
      linkRoot,
    );
    expect(ctx).toContain("UI_MARKER");
  });

  test("symlink 环不得导致死循环（对齐 CC visitedDirs）", async () => {
    // proj/loop → proj（自指），从 loop 下访问会让 dirname 上溯在环里打转
    symlinkSync(proj, join(proj, "loop"));
    writeFileSync(join(proj, "CLAUDE.md"), "# 根\nROOT_MARKER");
    chdirFixture(proj);
    const ctx = await new JitContextManager().discoverContext(
      join(proj, "loop", "src", "ui", "Footer.tsx"),
      proj,
    );
    // 只要能返回（不 hang）即通过；内容命中根规则是附带的正确行为
    expect(ctx === null || typeof ctx === "string").toBe(true);
  });
});

describe("P1-5 作用域未命中只跳过该文件，不得连带抑制同目录无条件规则", () => {
  // 修复前：break 跳出的是整个候选文件名循环 → src/ui/CLAUDE.md 因 paths 未命中被跳过时，
  // 同目录的 .claude/CLAUDE.md（无条件）也被连带跳过，永远拿不到。
  test("带 paths 的 CLAUDE.md 未命中时，同目录 .claude/CLAUDE.md 仍应注入", async () => {
    mkdirSync(join(proj, "src", "ui", ".claude"), { recursive: true });
    writeFileSync(
      join(proj, "src", "ui", "CLAUDE.md"),
      '---\npaths: ["src/other/**"]\n---\n# 不该命中\nSCOPED_MISS_MARKER\n',
    );
    writeFileSync(join(proj, "src", "ui", ".claude", "CLAUDE.md"), "# 无条件\nUNCONDITIONAL_MARKER\n");
    chdirFixture(proj);

    const ctx = await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(ctx).toContain("UNCONDITIONAL_MARKER");
    expect(ctx).not.toContain("SCOPED_MISS_MARKER");
  });

  test("paths 命中时正文注入且不含 frontmatter 元数据", async () => {
    writeFileSync(
      join(proj, "src", "ui", "CLAUDE.md"),
      '---\npaths: ["src/ui/**"]\n---\n# UI 规范\nUI_SCOPED_MARKER\n',
    );
    chdirFixture(proj);
    const ctx = await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(ctx).toContain("UI_SCOPED_MARKER");
    // frontmatter 是给 harness 看的元数据，不该喂给模型
    expect(ctx).not.toContain("paths:");
  });

  test("作用域未命中的目录不登记 scannedDirs：同目录换个命中的文件应重新判定", async () => {
    mkdirSync(join(proj, "src", "other"), { recursive: true });
    writeFileSync(join(proj, "src", "other", "x.ts"), "x\n");
    writeFileSync(
      join(proj, "src", "CLAUDE.md"),
      '---\npaths: ["src/other/**"]\n---\n# 只对 other\nOTHER_ONLY_MARKER\n',
    );
    chdirFixture(proj);

    const mgr = new JitContextManager();
    // 先访问不命中的（src/ui 下）→ 跳过，且不得把 src 记为已扫描
    const miss = await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(miss).toBeNull();
    // 再访问命中的 → 必须能拿到
    const hit = await mgr.discoverContext(join(proj, "src", "other", "x.ts"), proj);
    expect(hit).toContain("OTHER_ONLY_MARKER");
  });
});

describe("P1-1 候选文件名与 rules 目录：与主加载路径同一事实源", () => {
  test("CLAUDE.local.md 应被 JIT 发现（此前完全盲区）", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.local.md"), "# 本地私有\nLOCAL_MARKER");
    chdirFixture(proj);
    const ctx = await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(ctx).toContain("LOCAL_MARKER");
  });

  test(".claude/rules/*.md 应被 JIT 发现，且多份全部注入（不是只取第一份）", async () => {
    mkdirSync(join(proj, "src", "ui", ".claude", "rules"), { recursive: true });
    writeFileSync(join(proj, "src", "ui", ".claude", "rules", "a.md"), "# A\nRULE_A_MARKER");
    writeFileSync(join(proj, "src", "ui", ".claude", "rules", "b.md"), "# B\nRULE_B_MARKER");
    chdirFixture(proj);
    const ctx = await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    // 主加载路径 loadRulesFromDir 是逐文件注入，JIT 侧必须一致
    expect(ctx).toContain("RULE_A_MARKER");
    expect(ctx).toContain("RULE_B_MARKER");
  });

  test("rules 目录下的文件也走 paths 作用域判定", async () => {
    mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
    writeFileSync(
      join(proj, ".claude", "rules", "ui-only.md"),
      '---\npaths: ["src/ui/**"]\n---\n# 仅 UI\nRULES_SCOPED_MARKER\n',
    );
    mkdirSync(join(proj, "docs"), { recursive: true });
    writeFileSync(join(proj, "docs", "d.md"), "x\n");
    chdirFixture(proj);

    const hit = await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(hit).toContain("RULES_SCOPED_MARKER");

    const miss = await new JitContextManager().discoverContext(join(proj, "docs", "d.md"), proj);
    expect(miss === null || !miss.includes("RULES_SCOPED_MARKER")).toBe(true);
  });

  test("同一份文件经不同 symlink 触达只注入一次（realpath 去重）", async () => {
    writeFileSync(join(proj, "src", "CLAUDE.md"), "# src\nSRC_MARKER");
    mkdirSync(join(proj, "src", "ui", ".claude"), { recursive: true });
    // .claude/CLAUDE.md 是指向 src/CLAUDE.md 的链接：realpath 相同，不该注入两遍
    symlinkSync(join(proj, "src", "CLAUDE.md"), join(proj, "src", "ui", ".claude", "CLAUDE.md"));
    chdirFixture(proj);

    const ctx = await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(ctx).toContain("SRC_MARKER");
    const occurrences = (ctx ?? "").split("SRC_MARKER").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("P1-2 快照新鲜度：会话中途改规则应生效", () => {
  // 修复前：loadedFiles 是 Set<path>，命中即无条件跳过 → 改了规则永远用旧内容。
  test("mtime/size 变化后重新读盘并返回新内容", async () => {
    const rulePath = join(proj, "src", "ui", "CLAUDE.md");
    writeFileSync(rulePath, "# v1\nOLD_MARKER");
    chdirFixture(proj);

    const mgr = new JitContextManager();
    const first = await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(first).toContain("OLD_MARKER");

    // 改内容（长度不同 → size 判据也变），并显式推进 mtime 避免同秒写入被判未变
    writeFileSync(rulePath, "# v2\nNEW_MARKER_LONGER");
    const future = new Date(Date.now() + 5000);
    utimesSync(rulePath, future, future);

    // 换一个同目录的新文件访问（避开 scannedDirs 短路），验证会重读
    writeFileSync(join(proj, "src", "ui", "Other.tsx"), "y\n");
    const second = await mgr.discoverContext(join(proj, "src", "ui", "Other.tsx"), proj);
    expect(second).toContain("NEW_MARKER");
    expect(mgr.getLoadedContexts()).not.toContain("OLD_MARKER");
  });

  test("invalidate(path) 清除单份快照 + 其目录扫描登记", async () => {
    const rulePath = join(proj, "src", "ui", "CLAUDE.md");
    writeFileSync(rulePath, "# v1\nOLD_MARKER");
    chdirFixture(proj);

    const mgr = new JitContextManager();
    await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(mgr.getLoadedContexts()).toContain("OLD_MARKER");

    expect(mgr.invalidate(rulePath)).toBe(true);
    expect(mgr.getLoadedContexts()).toBeNull();

    // 目录登记也被清 → 同一个文件再次访问能重新加载
    writeFileSync(rulePath, "# v2\nNEW_MARKER");
    const again = await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(again).toContain("NEW_MARKER");
  });

  test("pruneStale() 剔除已变更条目、保留未变更条目（压缩前回灌用）", async () => {
    const uiRule = join(proj, "src", "ui", "CLAUDE.md");
    const rootRule = join(proj, "CLAUDE.md");
    writeFileSync(uiRule, "# ui\nUI_MARKER");
    writeFileSync(rootRule, "# root\nROOT_MARKER");
    chdirFixture(proj);

    const mgr = new JitContextManager();
    const ctx = await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(ctx).toContain("UI_MARKER");
    expect(ctx).toContain("ROOT_MARKER");

    writeFileSync(uiRule, "# ui v2\nUI_CHANGED_LONGER");
    const future = new Date(Date.now() + 5000);
    utimesSync(uiRule, future, future);

    expect(mgr.pruneStale()).toBe(1);
    const remaining = mgr.getLoadedContexts() ?? "";
    expect(remaining).toContain("ROOT_MARKER"); // 未变更的保留 → 压缩后立即回灌
    expect(remaining).not.toContain("UI_MARKER"); // 已变更的剔除 → 留给下次触达重读
  });

  test("规则文件被删除后 pruneStale 丢弃其缓存（不回灌已消失的规则）", async () => {
    const uiRule = join(proj, "src", "ui", "CLAUDE.md");
    writeFileSync(uiRule, "# ui\nUI_MARKER");
    chdirFixture(proj);
    const mgr = new JitContextManager();
    await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);

    rmSync(uiRule);
    expect(mgr.pruneStale()).toBeGreaterThanOrEqual(1);
    expect(mgr.getLoadedContexts()).toBeNull();
  });
});

describe("P2-7 reset()：清空去重集与正文", () => {
  test("reset 后计数归零、正文清空、可重新加载", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const mgr = new JitContextManager();
    await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(mgr.getLoadedCount()).toBeGreaterThan(0);

    mgr.reset();
    expect(mgr.getLoadedCount()).toBe(0);
    expect(mgr.getLoadedContexts()).toBeNull();
    expect(mgr.getLoadedBytes()).toBe(0);

    const again = await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(again).toContain("UI_MARKER");
  });
});

describe("P1-7 记账：getLoadedBytes 反映注入总量", () => {
  test("bytes 随注入增长，等于各块长度之和", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const mgr = new JitContextManager();
    expect(mgr.getLoadedBytes()).toBe(0);

    await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    const blocks = mgr.getLoadedBlocks();
    expect(mgr.getLoadedBytes()).toBe(blocks.reduce((s, b) => s + b.length, 0));
    expect(mgr.getLoadedBytes()).toBeGreaterThan(0);
  });

  test("markLoaded 的占位条目不计入 bytes（内容由系统提示词主体承载，重复记账会虚高）", async () => {
    const rulePath = join(proj, "CLAUDE.md");
    writeFileSync(rulePath, "# root\nROOT_MARKER");
    chdirFixture(proj);
    const mgr = new JitContextManager();
    mgr.markLoaded([rulePath]);
    expect(mgr.getLoadedCount()).toBe(1);
    expect(mgr.getLoadedBytes()).toBe(0);
    expect(mgr.getLoadedContexts()).toBeNull();
  });

  test("markLoaded 的文件被修改后，JIT 应接手重新注入", async () => {
    const rulePath = join(proj, "src", "ui", "CLAUDE.md");
    writeFileSync(rulePath, "# v1\nOLD_MARKER");
    chdirFixture(proj);
    const mgr = new JitContextManager();
    mgr.markLoaded([rulePath]); // 模拟启动期已注入

    // 未改动时 JIT 不重复注入
    expect(await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj)).toBeNull();

    writeFileSync(rulePath, "# v2\nNEW_MARKER_LONGER");
    const future = new Date(Date.now() + 5000);
    utimesSync(rulePath, future, future);
    writeFileSync(join(proj, "src", "ui", "Other.tsx"), "y\n");

    const after = await mgr.discoverContext(join(proj, "src", "ui", "Other.tsx"), proj);
    expect(after).toContain("NEW_MARKER");
  });
});

describe("P2-2 大小告警：只登记不截断", () => {
  test("超限文件被登记，但注入内容完整未截断", async () => {
    const body = "X".repeat(MAX_MEMORY_CHARACTER_COUNT + 100);
    const rulePath = join(proj, "src", "ui", "CLAUDE.md");
    writeFileSync(rulePath, `# 大文件\nHEAD_MARKER\n${body}\nTAIL_MARKER\n`);
    chdirFixture(proj);

    const ctx = await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    // 关键：首尾都在 —— 静默截断会让尾部规则消失而模型以为读全了
    expect(ctx).toContain("HEAD_MARKER");
    expect(ctx).toContain("TAIL_MARKER");
    expect(ctx!.length).toBeGreaterThan(MAX_MEMORY_CHARACTER_COUNT);

    // 登记键是 realpath（同一份文件经不同 symlink / 不同候选名触达时才能去重成一条），
    // 而 fixture 路径是 /var/... 形态 —— 断言必须同口径，否则字面不等假失败。
    const large = getLargeMemoryFiles();
    expect(large.some((f) => f.path === realpathSync(rulePath))).toBe(true);
  });

  test("未超限的文件不进告警登记", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# 小文件\nSMALL_MARKER");
    chdirFixture(proj);
    await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(getLargeMemoryFiles()).toHaveLength(0);
  });
});

describe("P2-8 失败可见化：区分 ENOENT 与真实错误", () => {
  test("不存在的候选文件不记为失败（ENOENT 属正常）", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const r = await new JitContextManager().discoverDetailed(
      join(proj, "src", "ui", "Footer.tsx"),
      proj,
    );
    expect(r.failures).toHaveLength(0);
  });

  test("不可读的规则文件记为 failure（EACCES），且不静默丢弃", async () => {
    const rulePath = join(proj, "src", "ui", "CLAUDE.md");
    writeFileSync(rulePath, "# UI\nUI_MARKER");
    chmodSync(rulePath, 0o000);
    chdirFixture(proj);
    try {
      const r = await new JitContextManager().discoverDetailed(
        join(proj, "src", "ui", "Footer.tsx"),
        proj,
      );
      // root 身份下 chmod 000 仍可读，此时跳过该断言（CI 容器常以 root 运行）
      if (r.text === null) {
        expect(r.failures.length).toBeGreaterThan(0);
        expect(r.failures[0].phase).toBe("read");
      }
    } finally {
      chmodSync(rulePath, 0o644);
    }
  });

  test("访问目标本身不存在时（write 新建文件）按 dirname 处理，不记 failure", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const r = await new JitContextManager().discoverDetailed(
      join(proj, "src", "ui", "BrandNew.tsx"),
      proj,
    );
    expect(r.text).toContain("UI_MARKER");
    expect(r.failures).toHaveLength(0);
  });
});

describe("P1-3 埋点字段：discoverDetailed 的结构化明细", () => {
  test("命中时给出 reason / bytes / relPath / elapsedMs", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const r = await new JitContextManager().discoverDetailed(
      join(proj, "src", "ui", "Footer.tsx"),
      proj,
    );
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0].reason).toBe("nested_traversal");
    expect(r.loaded[0].relPath).toBe("src/ui/CLAUDE.md");
    expect(r.loaded[0].bytes).toBeGreaterThan(0);
    expect(r.loaded[0].oversized).toBe(false);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("paths 命中的归因是 path_glob_match（区别于无条件规则）", async () => {
    writeFileSync(
      join(proj, "src", "ui", "CLAUDE.md"),
      '---\npaths: ["src/ui/**"]\n---\n# UI\nUI_MARKER\n',
    );
    chdirFixture(proj);
    const r = await new JitContextManager().discoverDetailed(
      join(proj, "src", "ui", "Footer.tsx"),
      proj,
    );
    expect(r.loaded[0].reason).toBe("path_glob_match");
  });

  test("CLAUDE.local.md 的归因是 local", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.local.md"), "# 本地\nLOCAL_MARKER");
    chdirFixture(proj);
    const r = await new JitContextManager().discoverDetailed(
      join(proj, "src", "ui", "Footer.tsx"),
      proj,
    );
    expect(r.loaded[0].reason).toBe("local");
  });

  test("作用域跳过计入 scopeSkipped（JIT 浪费率的分子）", async () => {
    writeFileSync(
      join(proj, "src", "ui", "CLAUDE.md"),
      '---\npaths: ["src/other/**"]\n---\n# 不命中\nMISS\n',
    );
    chdirFixture(proj);
    const r = await new JitContextManager().discoverDetailed(
      join(proj, "src", "ui", "Footer.tsx"),
      proj,
    );
    expect(r.scopeSkipped).toBe(1);
    expect(r.text).toBeNull();
  });

  test("未命中时也返回结构化结果（覆盖率的分母不能缺失）", async () => {
    chdirFixture(proj);
    const r = await new JitContextManager().discoverDetailed(
      join(proj, "src", "ui", "Footer.tsx"),
      proj,
    );
    expect(r.text).toBeNull();
    expect(r.loaded).toHaveLength(0);
  });
});

describe("回灌幂等：逐块判定（不依赖拼接顺序与集合快照）", () => {
  // 修复前：整串 includes 的幂等性依赖「两次调用之间集合没变」。
  // 集合新增一块后拼出的整串与提示词里已有的部分不再字面相等 → 整串追加 → 旧块重复。
  test("集合中途新增一块时，只追加缺失的那块", () => {
    const a = "--- BLOCK_A ---";
    const b = "--- BLOCK_B ---";
    const first = mergeJitContextIntoPrompt("BASE", [a]);
    expect(first.appended).toBe(true);

    const second = mergeJitContextIntoPrompt(first.prompt, [a, b]);
    expect(second.appended).toBe(true);
    // A 只出现一次（整串判定下会出现两次）
    expect(second.prompt.split(a).length - 1).toBe(1);
    expect(second.prompt).toContain(b);
  });

  test("同一组块重复调用不产生变化", () => {
    const blocks = ["--- BLOCK_A ---", "--- BLOCK_B ---"];
    const first = mergeJitContextIntoPrompt("BASE", blocks);
    const second = mergeJitContextIntoPrompt(first.prompt, blocks);
    expect(second.appended).toBe(false);
    expect(second.prompt).toBe(first.prompt);
  });

  test("空列表 / null 原样返回，不产生多余空行", () => {
    expect(mergeJitContextIntoPrompt("BASE", []).prompt).toBe("BASE");
    expect(mergeJitContextIntoPrompt("BASE", null).prompt).toBe("BASE");
    expect(mergeJitContextIntoPrompt("BASE", undefined).prompt).toBe("BASE");
  });

  test("兼容单字符串形态（既有调用方）", () => {
    const r = mergeJitContextIntoPrompt("BASE", "--- BLOCK ---");
    expect(r.appended).toBe(true);
    expect(r.prompt).toContain("--- BLOCK ---");
  });
});

describe("P1-6 收口下沉：ContextManager.setSystemPrompt 自动回灌", () => {
  // 修复前：靠 App.applySystemPrompt 这条**纪律**收口，而 /memory reload 拿着 ctxMgr
  // 直接调裸 setSystemPrompt 就绕过了 → JIT 规则永久丢失。
  test("裸 setSystemPrompt 也会带回 JIT 块（无可绕过路径）", () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    const block = "--- 新发现的项目上下文 (src/ui/CLAUDE.md) ---\nUI_MARKER\n--- 上下文结束 ---";
    ctxMgr.setJitBlocksProvider(() => [block]);

    // 模拟 /memory reload：覆盖式重建，完全不知道 JIT 的存在
    ctxMgr.setSystemPrompt("REBUILT_PROMPT");
    expect(ctxMgr.getSystemPrompt()).toContain("REBUILT_PROMPT");
    expect(ctxMgr.getSystemPrompt()).toContain("UI_MARKER");
  });

  test("重复写入不重复追加（逐块幂等）", () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    const block = "--- BLOCK ---";
    ctxMgr.setJitBlocksProvider(() => [block]);
    ctxMgr.setSystemPrompt("BASE");
    const once = ctxMgr.getSystemPrompt();
    ctxMgr.setSystemPrompt(once);
    expect(ctxMgr.getSystemPrompt().split(block).length - 1).toBe(1);
  });

  test("未注入 provider 时行为与改造前一致（子代理 / headless / 旧测试路径）", () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.setSystemPrompt("PLAIN");
    expect(ctxMgr.getSystemPrompt()).toBe("PLAIN");
  });

  test("provider 抛错时不阻断提示词写入（丢规则轻于丢整个提示词）", () => {
    const ctxMgr = new ContextManager({ maxTokens: 100_000 });
    ctxMgr.setJitBlocksProvider(() => {
      throw new Error("boom");
    });
    ctxMgr.setSystemPrompt("STILL_WRITTEN");
    expect(ctxMgr.getSystemPrompt()).toBe("STILL_WRITTEN");
  });
});

describe("P2-9 工具自报路径：collectJitAccessedPaths", () => {
  const resolver = (map: Record<string, (i: any) => string[]>) => (n: string) => map[n];

  test("读工具自报值，不认没自报的工具（fail-closed）", () => {
    const paths = collectJitAccessedPaths(
      [
        { name: "read", input: { file_path: "/a/b.ts" } },
        { name: "web_fetch", input: { url: "https://x/y/z" } },
      ],
      "/root",
      resolver({ read: (i) => [i.file_path] }),
    );
    expect(paths).toEqual(["/a/b.ts"]);
  });

  test("read_many 的 pattern 数组也能提取（原硬编码名单完全漏掉）", () => {
    const paths = collectJitAccessedPaths(
      [{ name: "read_many", input: { pattern: ["src/ui/**/*.tsx", "src/api/*.ts"] } }],
      "/root",
      resolver({ read_many: (i) => [...i.pattern] }),
    );
    expect(paths).toContain("src/ui/**/*.tsx");
  });

  test("去重：同一路径被多个工具块报出只保留一次", () => {
    const paths = collectJitAccessedPaths(
      [
        { name: "read", input: { file_path: "/a/b.ts" } },
        { name: "edit", input: { file_path: "/a/b.ts" } },
      ],
      "/root",
      resolver({ read: (i) => [i.file_path], edit: (i) => [i.file_path] }),
    );
    expect(paths).toEqual(["/a/b.ts"]);
  });

  test("提取器抛错时跳过该工具，不影响其余（隔离性）", () => {
    const paths = collectJitAccessedPaths(
      [
        { name: "bad", input: {} },
        { name: "read", input: { file_path: "/a/b.ts" } },
      ],
      "/root",
      resolver({
        bad: () => {
          throw new Error("boom");
        },
        read: (i) => [i.file_path],
      }),
    );
    expect(paths).toEqual(["/a/b.ts"]);
  });

  test("glob 无任何可用路径时退化为项目根", () => {
    const paths = collectJitAccessedPaths(
      [{ name: "glob", input: { pattern: "**/*.ts" } }],
      "/root",
      resolver({ glob: () => [] }),
    );
    expect(paths).toEqual(["/root"]);
  });

  test("glob 已有明确目标时不再叠加项目根（避免多注入一次根规则）", () => {
    const paths = collectJitAccessedPaths(
      [{ name: "glob", input: { path: "src/ui" } }],
      "/root",
      resolver({ glob: (i) => [i.path] }),
    );
    expect(paths).toEqual(["src/ui"]);
  });

  test("非文件工具批次返回空（不触发无意义的 JIT 扫描）", () => {
    const paths = collectJitAccessedPaths(
      [{ name: "bash", input: { command: "ls" } }],
      "/root",
      resolver({}),
    );
    expect(paths).toEqual([]);
  });
});

describe("SID_CODE_DISABLE_PROJECT_RULES 评测隔离开关仍然生效", () => {
  test("=1 时 JIT 整条禁用（避免 agent grep 泄露 case 锚点）", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const prev = process.env.SID_CODE_DISABLE_PROJECT_RULES;
    process.env.SID_CODE_DISABLE_PROJECT_RULES = "1";
    try {
      const r = await new JitContextManager().discoverDetailed(
        join(proj, "src", "ui", "Footer.tsx"),
        proj,
      );
      expect(r.text).toBeNull();
      expect(r.loaded).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.SID_CODE_DISABLE_PROJECT_RULES;
      else process.env.SID_CODE_DISABLE_PROJECT_RULES = prev;
    }
  });
});

describe("注入格式契约：静默条款不可省", () => {
  test("注入块必须含静默条款（缺失会让弱模型逐轮复述规则刷屏）", async () => {
    writeFileSync(join(proj, "src", "ui", "CLAUDE.md"), "# UI\nUI_MARKER");
    chdirFixture(proj);
    const ctx = await new JitContextManager().discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);
    expect(ctx).toContain("请勿向用户提及或复述本上下文");
  });
});
