/**
 * 批量交付审计（scripts/workflow-delivery-audit.ts，B2）。
 *
 * 这个脚本存在的理由是两类**静默**损失：删 worktree 丢未提交改动、commit 没进任何分支。
 * 两者都不会报错，只会在事后发现。所以要测的是它真能把这两种状态区分开：
 *   ① 有提交 → committed；只改工作区 → uncommitted；都没有 → empty；
 *   ② exportPatch 对「已 add」「未 add」「untracked」三种改动都能导出 ——
 *      第三种是 2026-11-19 实际漏过的坑（只 diff 工作区会漏掉新建文件）。
 *
 * 全部在 tmpdir 里用真实 git 建 worktree（git worktree add），不碰 ~/.sid-code/。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditWorktree,
  exportPatch,
  listWorktrees,
  renderReport,
  worktreesDir,
} from "../../scripts/workflow-delivery-audit.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/workflow-delivery-audit.ts");

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr.toString()}`);
  return r.stdout.toString();
}

const commit = (cwd: string, msg: string) =>
  sh(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", msg);

const write = (root: string, rel: string, content: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
};

/** 主仓：1 个初始提交 + base 标签 */
function makeMainRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "wf-audit-"));
  sh(root, "init", "-q");
  commit(root, "base");
  sh(root, "tag", "base0");
  return root;
}

/** 造一个真 git worktree：<repo>/.sid-code/worktrees/<name> */
function addWorktree(repo: string, name: string): string {
  const base = join(repo, ".sid-code", "worktrees");
  mkdirSync(base, { recursive: true });
  const wt = join(base, name);
  sh(repo, "worktree", "add", "-q", "-b", `${name}-branch`, wt);
  return wt;
}

const BASE = "base0";

describe("auditWorktree", () => {
  test("有 1 个提交 → committed，并带出提交清单", () => {
    const repo = makeMainRepo();
    try {
      const wt = addWorktree(repo, "wf_a");
      write(wt, "a.txt", "a\n");
      sh(wt, "add", "-A");
      commit(wt, "feat: 单元产出");
      const a = auditWorktree(wt, BASE);
      expect(a.verdict).toBe("committed");
      expect(a.commits).toBe(1);
      expect(a.dirty).toBe(0);
      expect(a.unit).toBe("wf_a");
      expect(a.log[0]).toContain("feat: 单元产出");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("只改工作区文件（不 add）→ uncommitted", () => {
    const repo = makeMainRepo();
    try {
      const wt = addWorktree(repo, "wf_b");
      write(wt, "b.txt", "b\n");
      const a = auditWorktree(wt, BASE);
      expect(a.verdict).toBe("uncommitted");
      expect(a.commits).toBe(0);
      expect(a.dirty).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("空 worktree → empty", () => {
    const repo = makeMainRepo();
    try {
      const wt = addWorktree(repo, "wf_c");
      const a = auditWorktree(wt, BASE);
      expect(a.verdict).toBe("empty");
      expect(a.commits).toBe(0);
      expect(a.dirty).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("既提交又有未提交改动 → committed（提交数优先），dirty 仍如实报出", () => {
    const repo = makeMainRepo();
    try {
      const wt = addWorktree(repo, "wf_d");
      write(wt, "d.txt", "d\n");
      sh(wt, "add", "-A");
      commit(wt, "feat: d");
      write(wt, "d.txt", "d2\n");
      const a = auditWorktree(wt, BASE);
      expect(a.verdict).toBe("committed");
      expect(a.dirty).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("不是 git 目录 / base 解析不到 → unknown（不会误判成 empty）", () => {
    // 普通目录必须建在**仓库之外**：建在 worktree 目录内部时，git 会向上找到外层仓库，
    // 两个命令都成功、结果变成 empty/committed —— 那就测不到「git 命令失败」这条路了。
    const plainRoot = mkdtempSync(join(tmpdir(), "wf-audit-plain-"));
    try {
      write(plainRoot, "wf_plain/x.txt", "x\n");
      const a = auditWorktree(join(plainRoot, "wf_plain"), BASE);
      expect(a.verdict).toBe("unknown");
      expect(a.commits).toBeNull();
      expect(a.dirty).toBeNull();
      expect(a.error).toBeTruthy();
    } finally {
      rmSync(plainRoot, { recursive: true, force: true });
    }

    const repo = makeMainRepo();
    try {
      const wt = addWorktree(repo, "wf_e");
      write(wt, "e.txt", "e\n");
      expect(auditWorktree(wt, "no-such-rev").verdict).toBe("unknown");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("exportPatch", () => {
  /** 三种改动各造一个用例：已 add / 未 add / untracked 新建文件 */
  function setup(): { repo: string; wt: string } {
    const repo = makeMainRepo();
    const wt = addWorktree(repo, "wf_x");
    write(wt, "tracked.txt", "old\n");
    sh(wt, "add", "-A");
    commit(wt, "feat: 初始文件");
    return { repo, wt };
  }

  test("改动已 git add → patch 非空且含改动内容", () => {
    const { repo, wt } = setup();
    try {
      write(wt, "tracked.txt", "new\n");
      sh(wt, "add", "-A");
      const out = join(repo, "p1.patch");
      const bytes = exportPatch(wt, out);
      expect(bytes).toBeGreaterThan(0);
      const patch = readFileSync(out, "utf8");
      expect(patch).toContain("+new");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("改动只在工作区（未 add）→ patch 也非空", () => {
    const { repo, wt } = setup();
    try {
      write(wt, "tracked.txt", "unstaged\n");
      const out = join(repo, "p2.patch");
      expect(exportPatch(wt, out)).toBeGreaterThan(0);
      expect(readFileSync(out, "utf8")).toContain("+unstaged");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("untracked 新文件也进 patch（去掉 git add -A 时这条会红）", () => {
    const { repo, wt } = setup();
    try {
      write(wt, "brand-new.ts", "export const x = 1;\n");
      const out = join(repo, "p3.patch");
      const bytes = exportPatch(wt, out);
      expect(bytes).toBeGreaterThan(0);
      const patch = readFileSync(out, "utf8");
      expect(patch).toContain("brand-new.ts");
      expect(patch).toContain("+export const x = 1;");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("导出目录不存在时自动建", () => {
    const { repo, wt } = setup();
    try {
      write(wt, "tracked.txt", "x\n");
      const out = join(repo, "nested", "deep", "wf_x.patch");
      expect(exportPatch(wt, out)).toBeGreaterThan(0);
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("listWorktrees / renderReport", () => {
  test("只收 wf_* 目录；目录不存在返回 null", () => {
    const repo = makeMainRepo();
    try {
      expect(listWorktrees(repo)).toBeNull();
      const wt = addWorktree(repo, "wf_a");
      mkdirSync(join(worktreesDir(repo), "not-a-wf"), { recursive: true });
      expect(listWorktrees(repo)).toEqual([wt]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("表格含五个列头，并对每种 verdict 给对应补救命令", () => {
    const repo = makeMainRepo();
    try {
      const uncommitted = addWorktree(repo, "wf_u");
      write(uncommitted, "u.txt", "u\n");
      const committed = addWorktree(repo, "wf_c");
      write(committed, "c.txt", "c\n");
      sh(committed, "add", "-A");
      commit(committed, "feat: c");
      const empty = addWorktree(repo, "wf_e");

      const audits = [uncommitted, committed, empty].map((p) => auditWorktree(p, BASE));
      const md = renderReport(audits, { worktreesDir: worktreesDir(repo) });
      const head = md.split("\n")[0]!;
      for (const col of ["unit", "verdict", "commits", "dirty", "path"])
        expect(head).toContain(col);
      expect(md).toContain("git -C ");
      expect(md).toContain("diff --binary HEAD");
      expect(md).toContain("format-patch --stdout");
      expect(md).toContain("该单元没有产出，需要人工检查 agent 报告");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("脚本端到端：退出码与 --export-dir", () => {
  const run = (args: string[], cwd: string) => {
    const r = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("--help 退 0；未知参数退 2", () => {
    const repo = makeMainRepo();
    try {
      const h = run(["--help"], repo);
      expect(h.code).toBe(0);
      expect(h.out).toContain("退出码：0 = 全部 committed 或没有 wf_*");
      expect(run(["--nope"], repo).code).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("没有 .sid-code/worktrees → 退 0 并提示", () => {
    const repo = makeMainRepo();
    try {
      const r = run(["--base", BASE, "--repo", repo], repo);
      expect(r.code).toBe(0);
      expect(r.out).toContain("无需审计");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("有未提交改动 → 退 1，--export-dir 导出 patch 并提示已 add -A", () => {
    const repo = makeMainRepo();
    try {
      const wt = addWorktree(repo, "wf_u");
      write(wt, "u.txt", "hello\n");
      write(wt, "new-file.txt", "brand new\n");
      const outDir = join(repo, "patches");
      const r = run(["--base", BASE, "--repo", repo, "--export-dir", outDir], repo);
      expect(r.code).toBe(1);
      expect(r.out).toContain("已对 wf_u 执行 git add -A");
      const patch = readFileSync(join(outDir, "wf_u.patch"), "utf8");
      expect(patch).toContain("u.txt");
      expect(patch).toContain("new-file.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("全部已提交 → 退 0", () => {
    const repo = makeMainRepo();
    try {
      const wt = addWorktree(repo, "wf_a");
      write(wt, "a.txt", "a\n");
      sh(wt, "add", "-A");
      commit(wt, "feat: a");
      const r = run(["--base", BASE, "--repo", repo], repo);
      expect(r.code).toBe(0);
      expect(r.out).toContain("committed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
