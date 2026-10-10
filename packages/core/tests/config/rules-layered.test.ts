/**
 * CLAUDE.md 多层级增强测试（Task 6）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseRulesFrontmatter,
  rulesPathsMatch,
  parseClaudeMd,
  loadAllCLAUDEmd,
  mergeProjectRules,
} from "@sid-code/core/config/rules.ts";
import { JitContextManager } from "@sid-code/core/config/jit-context.ts";

describe("parseRulesFrontmatter", () => {
  test("inline 数组写法", () => {
    const { paths, body } = parseRulesFrontmatter(`---
paths: ["src/**", "lib/**"]
---
正文`);
    expect(paths).toEqual(["src/**", "lib/**"]);
    expect(body.trim()).toBe("正文");
  });

  test("多行列表写法", () => {
    const { paths } = parseRulesFrontmatter(`---
paths:
  - src/**
  - tests/**
---
body`);
    expect(paths).toEqual(["src/**", "tests/**"]);
  });

  test("单值写法", () => {
    const { paths } = parseRulesFrontmatter(`---
paths: src/**
---
body`);
    expect(paths).toEqual(["src/**"]);
  });

  test("无 frontmatter 返回原内容", () => {
    const { paths, body } = parseRulesFrontmatter("# 标题\n内容");
    expect(paths).toBeUndefined();
    expect(body).toBe("# 标题\n内容");
  });
});

describe("rulesPathsMatch", () => {
  test("无 paths 条件始终匹配", () => {
    expect(rulesPathsMatch(undefined, [])).toBe(true);
    expect(rulesPathsMatch([], ["src/a.ts"])).toBe(true);
  });

  test("有 paths 条件但无活动文件不匹配", () => {
    expect(rulesPathsMatch(["src/**"], [])).toBe(false);
  });

  test("glob 匹配活动文件", () => {
    expect(rulesPathsMatch(["src/**"], ["src/foo/bar.ts"])).toBe(true);
    expect(rulesPathsMatch(["src/**"], ["lib/baz.ts"])).toBe(false);
  });

  test("任一 glob 匹配任一文件即生效", () => {
    expect(rulesPathsMatch(["src/**", "*.md"], ["README.md"])).toBe(true);
  });
});

describe("parseClaudeMd 带 frontmatter", () => {
  test("提取 paths 并正常解析段落", () => {
    const content = `---
paths: ["src/**"]
---
# Instructions
使用 TypeScript`;
    const rules = parseClaudeMd(content, "/test/CLAUDE.md");
    expect(rules.paths).toEqual(["src/**"]);
    expect(rules.instructions).toContain("使用 TypeScript");
  });
});

describe("loadAllCLAUDEmd 多层级", () => {
  let proj: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "sid-rules-"));
  });
  afterEach(() => {
    try {
      rmSync(proj, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("加载 .claude/rules/ 目录规则", async () => {
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n项目根规则");
    mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
    writeFileSync(join(proj, ".claude", "rules", "style.md"), "# Custom Rules\n- 缩进用 2 空格");

    const merged = await loadAllCLAUDEmd(proj);
    expect(merged).not.toBeNull();
    expect(merged!.rawContent).toContain("项目根规则");
    expect(merged!.rawContent).toContain("缩进用 2 空格");
  });

  test("CLAUDE.local.md 优先级最高（覆盖 model）", async () => {
    writeFileSync(join(proj, "CLAUDE.md"), "# Model\nclaude-sonnet");
    writeFileSync(join(proj, "CLAUDE.local.md"), "# Model\nclaude-opus");

    const merged = await loadAllCLAUDEmd(proj);
    expect(merged!.model).toBe("claude-opus");
  });

  test("frontmatter paths 不匹配的规则被跳过", async () => {
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n通用规则");
    mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
    // 只在编辑 python 文件时生效的规则
    writeFileSync(
      join(proj, ".claude", "rules", "py.md"),
      `---\npaths: ["**/*.py"]\n---\n# Custom Rules\n- Python 专用规则`,
    );

    // 活动文件是 .ts，不应包含 Python 规则
    const merged = await loadAllCLAUDEmd(proj, { activeFiles: ["src/foo.ts"] });
    expect(merged!.rawContent).not.toContain("Python 专用规则");

    // 活动文件是 .py，应包含
    const merged2 = await loadAllCLAUDEmd(proj, { activeFiles: ["src/foo.py"] });
    expect(merged2!.rawContent).toContain("Python 专用规则");
  });

  // ── 回归：作用域规则被同层无条件文件「夹带」注入 ──
  //
  // 真实事故：cwd=<repo>/website 做 VitePress 文档任务，却被注入 src/ui/CLAUDE.md 的 TUI 规范。
  // 当时的根因是启动期子目录扫描「先合并、后过滤」。2026-10-10 起启动期**不再扫子目录**
  // （家目录启动扫进 65 个兄弟项目、一句「你好」就超窗），子目录规则全部改由 JIT 触达加载，
  // 这条回归改为锁 JIT 侧的同一不变量：触达无条件目录不得夹带作用域规则。
  test("回归：子目录规则启动期不注入，JIT 触达时按作用域各自加载、互不夹带", async () => {
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n项目根规则");
    mkdirSync(join(proj, "docs"), { recursive: true });
    writeFileSync(join(proj, "docs", "CLAUDE.md"), "# Instructions\n无条件文档规则 CARRIER");
    mkdirSync(join(proj, "ui"), { recursive: true });
    writeFileSync(
      join(proj, "ui", "CLAUDE.md"),
      `---\npaths: ["ui/**"]\n---\n# Instructions\nTUI 专用规范 SCOPED`,
    );

    // 启动期：只有父链（项目根），子目录一份都不进——活动文件命中作用域也一样
    for (const opts of [undefined, { activeFiles: ["ui/Footer.tsx"] }]) {
      const merged = await loadAllCLAUDEmd(proj, opts);
      expect(merged!.rawContent).toContain("项目根规则");
      expect(merged!.rawContent).not.toContain("CARRIER");
      expect(merged!.rawContent).not.toContain("SCOPED");
    }

    // JIT：触达 docs 只拿 docs 的规则，不夹带 ui
    const mgr = new JitContextManager();
    const docsCtx = await mgr.discoverContext(join(proj, "docs", "a.md"), proj);
    expect(docsCtx).toContain("CARRIER");
    expect(docsCtx).not.toContain("SCOPED");
    // 触达 ui 下命中作用域的文件才拿到作用域规则
    const uiCtx = await mgr.discoverContext(join(proj, "ui", "Footer.tsx"), proj);
    expect(uiCtx).toContain("SCOPED");
  });

  test("回归：mergeProjectRules 不再丢弃 paths（兜底不失效）", () => {
    const scoped = parseClaudeMd(`---\npaths: ["ui/**"]\n---\n# Instructions\nA`, "/a/CLAUDE.md");
    const alsoScoped = parseClaudeMd(
      `---\npaths: ["api/**"]\n---\n# Instructions\nB`,
      "/b/CLAUDE.md",
    );
    // 两侧都有作用域 → 取并集（paths 是「任一 glob 命中即生效」的或语义）
    const both = mergeProjectRules(scoped, alsoScoped);
    expect(both.paths?.sort()).toEqual(["api/**", "ui/**"]);

    // 任一侧无条件 → 合并结果保持无条件，避免无条件规则被作用域规则连坐屏蔽
    const uncond = parseClaudeMd("# Instructions\nC", "/c/CLAUDE.md");
    expect(mergeProjectRules(uncond, scoped).paths).toBeUndefined();
    expect(mergeProjectRules(scoped, uncond).paths).toBeUndefined();
  });

  test("回归：frontmatter 元数据不进注入内容（不喂给模型）", async () => {
    mkdirSync(join(proj, "ui"), { recursive: true });
    writeFileSync(
      join(proj, "ui", "CLAUDE.md"),
      `---\npaths: ["ui/**"]\n---\n# Instructions\nUI 规范正文`,
    );
    // 子目录规则只经 JIT 注入（启动期不扫子目录），所以在 JIT 产物上断言
    const ctx = await new JitContextManager().discoverContext(join(proj, "ui", "a.tsx"), proj);
    expect(ctx).toContain("UI 规范正文");
    // `paths:` 是给加载器看的元数据，对模型无意义，不应出现在注入内容里
    expect(ctx).not.toMatch(/^paths:/m);
  });

  test("回归：loadedPaths 只含实际注入的文件（JIT 预标记事实源）", async () => {
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n根规则");
    mkdirSync(join(proj, "ui"), { recursive: true });
    writeFileSync(
      join(proj, "ui", "CLAUDE.md"),
      `---\npaths: ["ui/**"]\n---\n# Instructions\nUI 规范`,
    );

    // 子目录文件启动期不注入 → 绝不能进 loadedPaths，否则 JIT 预标记它 → 永久失效
    for (const opts of [undefined, { activeFiles: ["ui/a.tsx"] }]) {
      const merged = await loadAllCLAUDEmd(proj, opts);
      expect(merged!.loadedPaths).toBeDefined();
      expect(merged!.loadedPaths!.some((p) => p.includes(join("ui", "CLAUDE.md")))).toBe(false);
      expect(merged!.loadedPaths!.some((p) => p === join(proj, "CLAUDE.md"))).toBe(true);
    }
  });

  test("项目内无规则文件时不泄露项目内容", async () => {
    // 注意：开发机可能存在全局 ~/.claude/CLAUDE.md，会被正常加载（User 层）。
    // 这里只验证：项目目录内没有规则文件时，合并结果不包含任何项目级内容。
    const merged = await loadAllCLAUDEmd(proj);
    if (merged) {
      expect(merged.layer).toBe("user");
      expect(merged.sourcePath).not.toContain(proj);
    } else {
      expect(merged).toBeNull();
    }
  });

  test("M7: 父目录链上多层 CLAUDE.md 都加载（越深优先级越高）", async () => {
    // proj/CLAUDE.md（外层）+ proj/packages/app/CLAUDE.md（内层）
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n外层根规则ROOTMARK");
    const inner = join(proj, "packages", "app");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "CLAUDE.md"), "# Instructions\n内层应用规则INNERMARK");

    const merged = await loadAllCLAUDEmd(inner);
    expect(merged).not.toBeNull();
    // 两层都应被加载
    expect(merged!.rawContent).toContain("ROOTMARK");
    expect(merged!.rawContent).toContain("INNERMARK");
  });

  test("M9: symlink 指向的规则文件只加载一次（去重防重复）", async () => {
    const { symlinkSync } = await import("fs");
    writeFileSync(join(proj, "CLAUDE.md"), "# Instructions\n根规则");
    mkdirSync(join(proj, ".claude", "rules"), { recursive: true });
    const realRule = join(proj, ".claude", "rules", "real.md");
    writeFileSync(realRule, "# Custom Rules\n- 唯一规则 UNIQUERULE");
    // 同目录内建一个指向 real.md 的 symlink
    try {
      symlinkSync(realRule, join(proj, ".claude", "rules", "link.md"));
    } catch {
      // 某些环境不支持 symlink，跳过断言
      return;
    }

    const merged = await loadAllCLAUDEmd(proj);
    expect(merged).not.toBeNull();
    // UNIQUERULE 应只出现一次（symlink 去重），用正则统计出现次数
    const count = (merged!.rawContent.match(/UNIQUERULE/g) || []).length;
    expect(count).toBe(1);
  });
});
