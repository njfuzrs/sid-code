/**
 * JIT 上下文发现 — 项目边界与作用域回归测试
 *
 * ## 背景：字符串前缀判边界导致跨项目规则泄露（2026-07-31 修复）
 *
 * 原实现用 `currentDir.startsWith(projectRoot)` 判"是否还在项目内"。这是**字符串**
 * 前缀比较，不是**路径段**比较：`/tmp/proj-evil` 确实以 `/tmp/proj` 开头，于是
 * 相邻项目（或同级 git worktree、`sid-code-old` 这类备份目录）的 CLAUDE.md 会被
 * 当作本项目规则注入模型上下文——跨项目规则泄露，且用户看不见注入内容，很难发现。
 *
 * 正确判据：`dir === root || dir.startsWith(root + path.sep)`。
 *
 * 本文件同时锁定 JIT 的另外两条既有契约（避免边界修复回归它们）：
 * 幂等（同一份文件只注入一次）、frontmatter `paths:` 作用域判定。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JitContextManager } from "@sid-code/core/config/jit-context.ts";

/** 建一对同级目录：proj 与 proj-evil（后者是前者的字符串前缀延伸） */
function makeSiblingProjects() {
  const base = mkdtempSync(join(tmpdir(), "sid-jit-bnd-"));
  const proj = join(base, "proj");
  const evil = join(base, "proj-evil");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(evil, "src"), { recursive: true });
  writeFileSync(join(evil, "CLAUDE.md"), "# 邻居项目规则\nEVIL_MARKER");
  writeFileSync(join(evil, "src", "a.ts"), "export const a = 1\n");
  writeFileSync(join(proj, "src", "CLAUDE.md"), "# 本项目 src 规则\nGOOD_MARKER");
  writeFileSync(join(proj, "src", "b.ts"), "export const b = 1\n");
  return { base, proj, evil };
}

describe("JIT 项目边界", () => {
  test("兄弟目录（项目根的字符串前缀延伸）的 CLAUDE.md 不得被注入", async () => {
    const { base, proj, evil } = makeSiblingProjects();
    try {
      const mgr = new JitContextManager();
      const ctx = await mgr.discoverContext(join(evil, "src", "a.ts"), proj);
      expect(ctx).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("项目内的子目录 CLAUDE.md 仍能正常加载（边界修复不得误伤）", async () => {
    const { base, proj } = makeSiblingProjects();
    try {
      const mgr = new JitContextManager();
      const ctx = await mgr.discoverContext(join(proj, "src", "b.ts"), proj);
      expect(ctx).not.toBeNull();
      expect(ctx!).toContain("GOOD_MARKER");
      expect(ctx!).not.toContain("EVIL_MARKER");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("同一份 CLAUDE.md 只注入一次（幂等，避免逐轮重复注入击穿缓存）", async () => {
    const { base, proj } = makeSiblingProjects();
    try {
      const mgr = new JitContextManager();
      const first = await mgr.discoverContext(join(proj, "src", "b.ts"), proj);
      expect(first).not.toBeNull();
      // 同目录下换一个文件再次触达：规则已加载，不应再次返回
      writeFileSync(join(proj, "src", "c.ts"), "export const c = 1\n");
      const second = await mgr.discoverContext(join(proj, "src", "c.ts"), proj);
      expect(second).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("JIT frontmatter paths 作用域", () => {
  test("paths 未命中时跳过；同目录换成命中的文件仍能拿到规则", async () => {
    const base = mkdtempSync(join(tmpdir(), "sid-jit-scope-"));
    try {
      const ui = join(base, "src", "ui");
      mkdirSync(ui, { recursive: true });
      writeFileSync(
        join(ui, "CLAUDE.md"),
        "---\npaths:\n  - \"src/ui/**/*.tsx\"\n---\n# TUI 规范\nSCOPED_MARKER",
      );
      writeFileSync(join(ui, "README.md"), "# 文档\n");
      writeFileSync(join(ui, "Footer.tsx"), "export const F = () => null\n");

      const mgr = new JitContextManager();
      // README.md 不匹配 *.tsx → 跳过
      const miss = await mgr.discoverContext(join(ui, "README.md"), base);
      expect(miss).toBeNull();

      // 关键：目录不得因上一次未命中而被记为"已扫描"，否则命中的文件永远拿不到规则
      const hit = await mgr.discoverContext(join(ui, "Footer.tsx"), base);
      expect(hit).not.toBeNull();
      expect(hit!).toContain("SCOPED_MARKER");
      // 注入的是剥离 frontmatter 后的正文，不应把 paths 元数据喂给模型
      expect(hit!).not.toContain("paths:");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
