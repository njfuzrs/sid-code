/**
 * JIT 新鲜度：只改 mtime、不改内容时不得重新注入（内容 hash 判据）。
 *
 * 缺陷形态：git checkout / switch / merge / pull / worktree 会改写工作区文件的 mtime，
 * 内容不变。旧实现只比 mtime+size，于是首轮已在 system `# claudeMd` 段的根 CLAUDE.md
 * 被 JIT 以 nested_traversal 再注入一遍 → system 尾部前缀断裂 + 同份规则出现两次。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { setCwd, getCwd } from "@sid-code/core/bootstrap/state.ts";
import { JitContextManager } from "@sid-code/core/config/jit-context.ts";

let base: string;
let proj: string;
let originalCwd: string;
let originalStateCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  originalStateCwd = getCwd();
  base = mkdtempSync(join(tmpdir(), "jit-hash-"));
  proj = realpathSync(base);
  proj = join(proj, "proj");
  mkdirSync(join(proj, "src", "ui"), { recursive: true });
  writeFileSync(join(proj, "src", "ui", "Footer.tsx"), "export const F = 1\n");
  writeFileSync(join(proj, "src", "ui", "Other.tsx"), "y\n");
  process.chdir(proj);
  setCwd(proj);
});

afterEach(() => {
  process.chdir(originalCwd);
  setCwd(originalStateCwd);
  rmSync(base, { recursive: true, force: true });
});

function bumpMtime(path: string, deltaMs = 5000): void {
  const t = new Date(Date.now() + deltaMs);
  utimesSync(path, t, t);
}

describe("markLoaded 预标记的根 CLAUDE.md", () => {
  test("只改 mtime → discoverDetailed 不返回任何块", async () => {
    const root = join(proj, "CLAUDE.md");
    writeFileSync(root, "# root\nROOT_MARKER\n");
    const mgr = new JitContextManager();
    mgr.markLoaded([root]);

    expect(
      (await mgr.discoverDetailed(join(proj, "src", "ui", "Footer.tsx"), proj)).loaded,
    ).toEqual([]);

    bumpMtime(root);
    const r = await mgr.discoverDetailed(join(proj, "src", "ui", "Other.tsx"), proj);
    expect(r.text).toBeNull();
    expect(r.loaded).toEqual([]);
  });

  test("内容改了（同长度）→ 仍重新注入新内容", async () => {
    const root = join(proj, "CLAUDE.md");
    writeFileSync(root, "# root\nMARKER_AAA\n");
    const mgr = new JitContextManager();
    mgr.markLoaded([root]);
    await mgr.discoverDetailed(join(proj, "src", "ui", "Footer.tsx"), proj);

    // 同长度：size 判据失效，只能靠 hash 认出变化
    writeFileSync(root, "# root\nMARKER_BBB\n");
    bumpMtime(root);
    const r = await mgr.discoverDetailed(join(proj, "src", "ui", "Other.tsx"), proj);
    expect(r.text).toContain("MARKER_BBB");
    expect(r.loaded.map((l) => l.relPath)).toEqual(["CLAUDE.md"]);
  });

  test("真实 git checkout 改写 mtime（内容不变）→ 不重新注入", async () => {
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: proj,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
    const root = join(proj, "CLAUDE.md");
    writeFileSync(root, "# root\nROOT_MARKER\n");
    expect(git("init", "-q", "-b", "main").status).toBe(0);
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    expect(git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init").status).toBe(
      0,
    );

    const mgr = new JitContextManager();
    mgr.markLoaded([root]);
    await mgr.discoverDetailed(join(proj, "src", "ui", "Footer.tsx"), proj);

    // 删掉再 checkout 回来：git 重写文件 → 新 mtime，内容逐字节相同
    rmSync(root);
    await Bun.sleep(20);
    expect(git("checkout", "--", "CLAUDE.md").status).toBe(0);

    const r = await mgr.discoverDetailed(join(proj, "src", "ui", "Other.tsx"), proj);
    expect(r.loaded).toEqual([]);
  });
});

describe("JIT 自己加载的条目", () => {
  test("只改 mtime → 不重复注入；内容随后真改 → 注入新版", async () => {
    const ui = join(proj, "src", "ui", "CLAUDE.md");
    writeFileSync(ui, "# ui\nUI_V1\n");
    const mgr = new JitContextManager();
    expect(await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj)).toContain(
      "UI_V1",
    );

    bumpMtime(ui, 5000);
    expect((await mgr.discoverDetailed(join(proj, "src", "ui", "Other.tsx"), proj)).loaded).toEqual(
      [],
    );

    // hash 命中后 stamp 已刷新，再改内容仍能识别
    writeFileSync(ui, "# ui\nUI_V2\n");
    bumpMtime(ui, 10000);
    expect(await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj)).toContain(
      "UI_V2",
    );
  });

  test("pruneStale 不剔除只改了 mtime 的条目（压缩后照常回灌）", async () => {
    const ui = join(proj, "src", "ui", "CLAUDE.md");
    writeFileSync(ui, "# ui\nUI_MARKER\n");
    const mgr = new JitContextManager();
    await mgr.discoverContext(join(proj, "src", "ui", "Footer.tsx"), proj);

    bumpMtime(ui);
    expect(mgr.pruneStale()).toBe(0);
    expect(mgr.getLoadedContexts()).toContain("UI_MARKER");
  });
});
