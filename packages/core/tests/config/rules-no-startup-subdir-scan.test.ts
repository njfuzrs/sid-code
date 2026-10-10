/**
 * 回归：启动期不扫描子目录 CLAUDE.md（2026-10-10 家目录超窗事故）。
 *
 * 事故：在 `~`（非 git、父链无 CLAUDE.md）启动 → projectRoot 退回 startDir=家目录 →
 * 旧 `findProjectCLAUDEmdFiles` 往下 BFS 3 层，扫进 `~/Code/person/*` 下 65 个兄弟项目 /
 * worktree 的 CLAUDE.md，系统提示词 236 万字符（~89 万 token）。用户说一句「你好」就
 * 400 超窗，压缩又只动消息历史 → 连续 3 次失败熔断。VS Code 里在仓库内启动正常，
 * 被误认成「iTerm 终端兼容性问题」。
 *
 * 根治：对齐 CC —— 启动期只走 cwd → 根的父链，子目录规则全部由 JIT 在工具触达时加载。
 * 本文件锁三件事：
 * 1. 家目录形态（startDir 下多个兄弟项目各带 CLAUDE.md）启动期一份都不加载；
 * 2. 仓库内启动同样不预加载子目录（不是只给家目录开特例——特例会在别的形态复发）；
 * 3. 子目录规则没丢：JIT 触达时照常加载，且不越出 projectRoot。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { loadAllCLAUDEmd } from "@sid-code/core/config/rules.ts";
import { JitContextManager } from "@sid-code/core/config/jit-context.ts";

describe("启动期不扫描子目录 CLAUDE.md", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "no-subdir-scan-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("家目录形态：非 git、父链无规则，兄弟项目的 CLAUDE.md 一份都不进系统提示词", async () => {
    // 模拟 ~/Code/person/<proj>/CLAUDE.md × N（深度 2，正落在旧 BFS 3 层范围内）
    const big = "规则正文 ".repeat(2000);
    for (let i = 0; i < 20; i++) {
      const dir = join(root, "Code", "person", `proj-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), `# Instructions\nSIBLING_${i}\n${big}`);
    }

    const merged = await loadAllCLAUDEmd(root);
    const raw = merged?.rawContent ?? "";
    expect(raw).not.toContain("SIBLING_");
    // loadedPaths 也不得出现任何兄弟项目文件（否则 JIT 预标记会把它们当已注入）
    expect((merged?.loadedPaths ?? []).some((p) => p.includes(join("Code", "person")))).toBe(false);
  });

  test("仓库内启动：子目录规则同样不预加载（无特例），但 JIT 触达时照常加载", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
    writeFileSync(join(root, "CLAUDE.md"), "# Instructions\nROOT_RULE");
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    writeFileSync(join(root, "packages", "a", "CLAUDE.md"), "# Instructions\nNESTED_RULE");

    const merged = await loadAllCLAUDEmd(root);
    expect(merged!.rawContent).toContain("ROOT_RULE");
    expect(merged!.rawContent).not.toContain("NESTED_RULE");

    const mgr = new JitContextManager();
    mgr.markLoaded(merged!.loadedPaths ?? []);
    const ctx = await mgr.discoverContext(join(root, "packages", "a", "x.ts"), root);
    expect(ctx).toContain("NESTED_RULE");
    // 父链根规则已在系统提示词里，JIT 不得二次注入
    expect(ctx).not.toContain("ROOT_RULE");
  });

  test("在子目录启动：父链（含仓库根）照常加载——删掉的只是向下扫描", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
    writeFileSync(join(root, "CLAUDE.md"), "# Instructions\nROOT_RULE");
    const sub = join(root, "packages", "a");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "CLAUDE.md"), "# Instructions\nCWD_RULE");

    const merged = await loadAllCLAUDEmd(sub);
    expect(merged!.rawContent).toContain("ROOT_RULE");
    expect(merged!.rawContent).toContain("CWD_RULE");
  });
});
