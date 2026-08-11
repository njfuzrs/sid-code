/**
 * 作用域规则闸门回归测试（审计清单第 1、11 条）
 *
 * 第 1 条：`loadAllCLAUDEmd` 的 `activeFiles` 此前在全部 5 个生产调用点都不传，
 * 恒为 `[]`，而 `rulesPathsMatch` 对空列表一律返回 false —— 带 `paths:` frontmatter
 * 的子目录 CLAUDE.md 在主加载路径**永不注入**（死闸门）。
 *
 * 第 11 条：JIT 上下文以「追加到系统提示词末尾」生效，但覆盖式重建
 * （`rebuildSystemPrompt` / CLAUDE.md watcher）直接 setSystemPrompt 抹掉且不回灌；
 * 因 `loadedFiles` 已标记该文件，再触达也不补 —— 规则永久丢失直到重启。
 *
 * 两条会叠加：第 1 条让 JIT 成为作用域规则的唯一注入途径，第 11 条把这条途径的产物抹掉。
 *
 * ⚠ 关键：**单文件 fixture 测不出第 1 条**（旧实现看似正常），必须同层多文件。
 * 这正是原缺陷长期为绿的原因。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { loadAllCLAUDEmd, collectActiveScopeFiles } from "@sid-code/core/config/rules.ts";
import { JitContextManager } from "@sid-code/core/config/jit-context.ts";
import { mergeJitContextIntoPrompt } from "@sid-code/cli/app.ts";

/** 在 fixture 里初始化一个 git 仓库（collectActiveScopeFiles 的 git 信号需要它） */
function initGitRepo(dir: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", timeout: 5000 });
  run(["init", "-q"]);
  // 提交身份：CI 环境可能没有全局配置，缺了会让后续 git 命令失败
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
}

describe("第 1 条：主加载路径的 paths 作用域规则闸门", () => {
  let proj: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "active-scope-"));
    initGitRepo(proj);
    // 根规则（无条件）
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n根规则 ROOT_MARKER");
    // 同层两个子目录规则：一个无条件（载体），一个带作用域（被测目标）。
    // 必须两个 —— 单文件时同层 merge 不发生，旧实现看似正常，测不出缺陷。
    mkdirSync(join(proj, "docs"), { recursive: true });
    writeFileSync(join(proj, "docs", "CLAUDE.md"), "# Instructions\n无条件文档规则 CARRIER");
    mkdirSync(join(proj, "src", "ui"), { recursive: true });
    writeFileSync(
      join(proj, "src", "ui", "CLAUDE.md"),
      `---\npaths: ["src/ui/**"]\n---\n# Instructions\nTUI 规范 UI_SCOPED`,
    );
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  test("不传 activeFiles 时自动采集 —— cwd 命中作用域则注入（摘掉自动采集即变红）", async () => {
    // 在作用域内产生一个改动，模拟"用户正在改 src/ui"
    writeFileSync(join(proj, "src", "ui", "App.tsx"), "export const A = 1;");

    // startDir = src/ui：cwd 目录标记 + git 变更都落在作用域内
    const merged = await loadAllCLAUDEmd(join(proj, "src", "ui"));
    expect(merged!.rawContent).toContain("UI_SCOPED");
    // 无条件规则不受影响
    expect(merged!.rawContent).toContain("ROOT_MARKER");
  });

  test("cwd 在作用域外时作用域规则正确落空（不夹带，防历史事故重演）", async () => {
    // 真实事故形态：cwd=website 做文档任务，却被注入 src/ui 的 TUI 规范。
    // 关键：src/ui 下**有未提交改动**（本仓库长期如此），若 git 信号不按 cwd 收窄就会重演。
    writeFileSync(join(proj, "src", "ui", "App.tsx"), "export const A = 1;");
    mkdirSync(join(proj, "website"), { recursive: true });
    writeFileSync(join(proj, "website", "index.md"), "# 文档");

    const merged = await loadAllCLAUDEmd(join(proj, "website"));
    expect(merged!.rawContent).not.toContain("UI_SCOPED");
    // 无条件规则仍在（不是一刀切全拦）
    expect(merged!.rawContent).toContain("ROOT_MARKER");
  });

  test("显式传 [] 仍表示「无活动范围」（拒绝语义保留，供测试断言）", async () => {
    writeFileSync(join(proj, "src", "ui", "App.tsx"), "export const A = 1;");
    const merged = await loadAllCLAUDEmd(join(proj, "src", "ui"), { activeFiles: [] });
    expect(merged!.rawContent).not.toContain("UI_SCOPED");
  });

  test("未注入的作用域规则不得进 loadedPaths（否则 JIT 预标记它 → 永久失效）", async () => {
    mkdirSync(join(proj, "website"), { recursive: true });
    writeFileSync(join(proj, "website", "index.md"), "# 文档");

    const merged = await loadAllCLAUDEmd(join(proj, "website"));
    const uiMarked = merged!.loadedPaths!.some((p) => p.includes(join("src", "ui", "CLAUDE.md")));
    expect(uiMarked).toBe(false);
  });
});

describe("collectActiveScopeFiles", () => {
  let proj: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "scope-collect-"));
    initGitRepo(proj);
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  test("cwd 目录标记带末尾斜杠（少了它 dir/** 形状的规则会静默失配）", () => {
    mkdirSync(join(proj, "src", "ui"), { recursive: true });
    const files = collectActiveScopeFiles(proj, join(proj, "src", "ui"));
    expect(files).toContain("src/ui/");
    // 这就是必须带斜杠的原因：Bun.Glob 对无斜杠的目录名不匹配 dir/**
    expect(new Bun.Glob("src/ui/**").match("src/ui")).toBe(false);
    expect(new Bun.Glob("src/ui/**").match("src/ui/")).toBe(true);
  });

  test("采集 git 变更文件的真实路径（目录标记无法满足扩展名作用域）", () => {
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "a.py"), "x = 1");

    const files = collectActiveScopeFiles(proj, proj);
    expect(files).toContain("src/a.py");
    // 扩展名作用域只能靠真实文件路径命中，目录标记一律失配 —— 只做目录标记等于只修一半
    expect(new Bun.Glob("**/*.py").match("src/")).toBe(false);
    expect(new Bun.Glob("**/*.py").match("src/a.py")).toBe(true);
  });

  test("git 变更按 cwd 子树收窄（cwd 外的改动不进作用域）", () => {
    mkdirSync(join(proj, "src", "ui"), { recursive: true });
    mkdirSync(join(proj, "website"), { recursive: true });
    writeFileSync(join(proj, "src", "ui", "App.tsx"), "export const A = 1;");
    writeFileSync(join(proj, "website", "index.md"), "# 文档");

    const inWebsite = collectActiveScopeFiles(proj, join(proj, "website"));
    expect(inWebsite.some((f) => f.startsWith("src/ui"))).toBe(false);
    expect(inWebsite).toContain("website/index.md");

    // cwd=项目根时全仓变更都算（用户确实在全项目范围工作）
    const atRoot = collectActiveScopeFiles(proj, proj);
    expect(atRoot).toContain("src/ui/App.tsx");
    expect(atRoot).toContain("website/index.md");
  });

  test("非 git 仓库时不 fail-open（退回仅 cwd 标记，而非匹配一切）", () => {
    const plain = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      mkdirSync(join(plain, "src", "ui"), { recursive: true });
      const files = collectActiveScopeFiles(plain, join(plain, "src", "ui"));
      expect(files).toEqual(["src/ui/"]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("路径含空格/中文不被 git 转义破坏（-z NUL 分隔）", () => {
    mkdirSync(join(proj, "my dir"), { recursive: true });
    writeFileSync(join(proj, "my dir", "中文 文件.ts"), "x");
    const files = collectActiveScopeFiles(proj, proj);
    expect(files).toContain("my dir/中文 文件.ts");
  });
});

describe("第 11 条：覆盖式重建必须回灌 JIT 上下文", () => {
  let proj: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "jit-reinject-"));
    mkdirSync(join(proj, "src", "ui"), { recursive: true });
    writeFileSync(
      join(proj, "src", "ui", "CLAUDE.md"),
      `---\npaths: ["src/ui/**"]\n---\n# Instructions\nTUI 规范 UI_SCOPED`,
    );
    writeFileSync(join(proj, "src", "ui", "App.tsx"), "export const A = 1;");
  });

  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  test("JIT 注入后，覆盖式重建若不回灌则永久丢失（缺陷本体）", async () => {
    const mgr = new JitContextManager();
    const ctx = await mgr.discoverContext(join(proj, "src", "ui", "App.tsx"), proj);
    expect(ctx).toContain("UI_SCOPED");

    // 覆盖式重建（不回灌）—— 这是修复前 rebuildSystemPrompt 的行为
    const rebuilt = "BASE_PROMPT_REBUILT";
    expect(rebuilt).not.toContain("UI_SCOPED");

    // 且不会自愈：loadedFiles 已标记，再触达同一文件返回 null
    const again = await mgr.discoverContext(join(proj, "src", "ui", "App.tsx"), proj);
    expect(again).toBeNull();
  });

  test("回灌后作用域规则重新可见（applySystemPrompt 的真实判定逻辑）", async () => {
    const mgr = new JitContextManager();
    await mgr.discoverContext(join(proj, "src", "ui", "App.tsx"), proj);
    const loaded = mgr.getLoadedContexts();
    expect(loaded).toContain("UI_SCOPED");

    // 走生产同一个函数，而不是在测试里重写一份等价逻辑
    const merged = mergeJitContextIntoPrompt("BASE_PROMPT_REBUILT", loaded);
    expect(merged.appended).toBe(true);
    expect(merged.prompt).toContain("UI_SCOPED");
    expect(merged.prompt).toContain("BASE_PROMPT_REBUILT");
  });

  test("回灌幂等：已含该正文时不重复追加（压缩路径会反复调用）", async () => {
    const mgr = new JitContextManager();
    await mgr.discoverContext(join(proj, "src", "ui", "App.tsx"), proj);
    const loaded = mgr.getLoadedContexts();

    const once = mergeJitContextIntoPrompt("BASE", loaded);
    const twice = mergeJitContextIntoPrompt(once.prompt, loaded);

    expect(twice.appended).toBe(false);
    expect(twice.prompt).toBe(once.prompt);
    expect(twice.prompt.split("UI_SCOPED").length - 1).toBe(1);
  });

  test("无已加载 JIT / jitContext 关闭时原样返回（不产生多余空行）", () => {
    expect(mergeJitContextIntoPrompt("BASE", null)).toEqual({ prompt: "BASE", appended: false });
    expect(mergeJitContextIntoPrompt("BASE", "")).toEqual({ prompt: "BASE", appended: false });
    expect(mergeJitContextIntoPrompt("BASE", undefined)).toEqual({ prompt: "BASE", appended: false });
  });
});
