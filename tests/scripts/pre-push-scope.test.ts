/**
 * pre-push 的推送区间判定（X3-02）—— 行为测试，不是源码文本断言。
 *
 * ## 这道门禁存在的理由
 *
 * 站点构建是死链检测的**唯一**落点（`ci.yml:355` 注释明写只在 pre-push）。
 * 原先它用 `git diff HEAD~1 HEAD -- 'website/'` 判断「这次推的东西里有没有
 * website/ 改动」——只看最后一个提交。分支上第 2 个提交改 `website/`、
 * 第 3、4 个只改 `packages/` 时，构建不会跑，终端上也没有任何一行「跳过」：
 * 死链就这样推上去了，而所有本地门禁都是绿的。
 *
 * 判定逻辑抽在 `scripts/git-hooks/push-scope.sh` 里，因此可以在 tmpdir 仓库里
 * 对真实 git 历史求值。**变异自证**：把 push-scope.sh 改成只看 `HEAD~1`，
 * 第一条用例（第 2 个提交改 website/、第 3 个只改 packages/）必红。
 *
 * ## 为什么每条用例都自己建仓库
 *
 * 「推送区间」是 git 的输入，不是被测函数的一个普通参数。用本仓库的提交历史
 * 测它既不可控（历史会变），也测不到「新分支」「远端被更新过」这些分支。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SCOPE_SH = join(ROOT, "scripts/git-hooks/push-scope.sh");
const PRE_PUSH_SH = join(ROOT, "scripts/git-hooks/pre-push.sh");
const ZERO = "0".repeat(40);

const created: string[] = [];

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface TestRepo {
  dir: string;
  git: (...args: string[]) => string;
  write: (rel: string, body: string) => void;
  commit: (msg: string) => string;
}

function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "push-scope-"));
  created.push(dir);

  const git = (...args: string[]): string => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        // 环境里可能有全局 excludesFile / hooksPath，会让 tmpdir 仓库行为不可控
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
    return (r.stdout ?? "").trim();
  };

  git("init", "-q", "-b", "main");
  const write = (rel: string, body: string): void => {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  const commit = (msg: string): string => {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };

  return { dir, git, write, commit };
}

/** 跑 push-scope.sh，喂一段 pre-push 的 stdin。 */
function runScope(dir: string, stdin: string, baseRef = "main"): string {
  const r = spawnSync("sh", [SCOPE_SH], {
    cwd: dir,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, PUSH_SCOPE_BASE_REF: baseRef },
  });
  if (r.status !== 0) throw new Error(`push-scope.sh 退出码 ${r.status}：${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/** 拼一行 pre-push stdin。 */
function refLine(localRef: string, localSha: string, remoteRef: string, remoteSha: string): string {
  return `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;
}

describe("推送区间：多提交 push 不能只看最后一个提交（X3-02）", () => {
  test("第 2 个提交改 website/、第 3 个只改 packages/ → 仍判出 website/", () => {
    const { dir, commit, write } = makeRepo();
    write("a.txt", "base\n");
    const c1 = commit("c1 初始");
    write("website/a.md", "# 新页面\n");
    commit("c2 改 website/");
    write("packages/a.txt", "pkg\n");
    commit("c3 只改 packages/");

    // 一次 push 推 c2 + c3 两个提交（远端还停在 c1）。
    // 最朴素的 `HEAD~1..HEAD` 只会看到 c3 —— 正好是漏判的那个形态。
    const out = runScope(dir, refLine("refs/heads/main", ref_HEAD(dir), "refs/heads/main", c1));
    expect(out.split("\n")).toContain("website/a.md");
    expect(out.split("\n")).toContain("packages/a.txt");
  });

  test("推送区间不含 website/ 时不误报", () => {
    const { dir, commit, write } = makeRepo();
    write("a.txt", "base\n");
    const c1 = commit("c1 初始");
    write("packages/a.txt", "pkg\n");
    commit("c2 只改 packages/");

    const out = runScope(dir, refLine("refs/heads/main", ref_HEAD(dir), "refs/heads/main", c1));
    expect(out).not.toContain("website/");
    expect(out.split("\n")).toContain("packages/a.txt");
  });

  test("重命名要同时看到旧路径（website/ 下的文件被移走也是改动）", () => {
    const { dir, commit, write, git } = makeRepo();
    write("website/old.md", "# 旧页\n");
    const c1 = commit("c1 初始");
    // 目标写成文件路径（不是目录）：git mv 不会自动创建目标目录
    git("mv", "website/old.md", "moved-old.md");
    commit("c2 移出 website/");

    const out = runScope(dir, refLine("refs/heads/main", ref_HEAD(dir), "refs/heads/main", c1));
    expect(out.split("\n")).toContain("website/old.md");
    expect(out.split("\n")).toContain("moved-old.md");
  });
});

describe("推送区间：三种判不出范围的情形都返回 __UNKNOWN__（宁可多跑一次）", () => {
  test("remote_sha 在本地对象库里不存在（远端被别人更新过）", () => {
    const { dir, commit, write } = makeRepo();
    write("a.txt", "base\n");
    commit("c1");
    const out = runScope(
      dir,
      refLine("refs/heads/main", ref_HEAD(dir), "refs/heads/main", "deadbeef".repeat(5)),
    );
    expect(out).toBe("__UNKNOWN__");
  });

  test("新分支且没有基线 ref（没有 origin/main）", () => {
    const { dir, commit, write } = makeRepo();
    write("a.txt", "base\n");
    commit("c1");
    const out = runScope(
      dir,
      refLine("refs/heads/feature", ref_HEAD(dir), "refs/heads/feature", ZERO),
      "origin/main",
    );
    expect(out).toBe("__UNKNOWN__");
  });

  test("新分支：与基线求差，而不是退化成空集", () => {
    const { dir, commit, write, git } = makeRepo();
    write("a.txt", "base\n");
    commit("c1 在 main 上");
    git("checkout", "-q", "-b", "feature");
    write("website/b.md", "# 分支新页\n");
    commit("c2 分支上改 website/");

    // 新分支推送到远端：remote_sha 是 ZERO，只能与基线求 merge-base
    const out = runScope(
      dir,
      refLine("refs/heads/feature", ref_HEAD(dir), "refs/heads/feature", ZERO),
      "main",
    );
    expect(out.split("\n")).toContain("website/b.md");
    expect(out).not.toContain("__UNKNOWN__");
  });
});

describe("推送区间：不产生内容的 ref 行不应判成 __UNKNOWN__", () => {
  test("删除远端分支（local_sha 全零）→ 空输出，不报 __UNKNOWN__", () => {
    const { dir } = makeRepo();
    const out = runScope(dir, refLine("refs/heads/gone", ZERO, "refs/heads/gone", ZERO));
    expect(out).toBe("");
  });

  test("空 stdin → 空输出（不是 __UNKNOWN__，调用方按「没有 website/ 改动」处理）", () => {
    const { dir } = makeRepo();
    expect(runScope(dir, "")).toBe("");
  });
});

describe("pre-push.sh 的接线（反漂移）", () => {
  const HOOK = readFileSync(PRE_PUSH_SH, "utf8");

  test("站点构建的触发条件走 push-scope.sh，而不是 HEAD~1", () => {
    expect(HOOK).toContain("push-scope.sh");
    expect(HOOK).not.toMatch(/git diff --quiet HEAD~1/);
  });

  test("跳过时打印一行（静默跳过看起来和「检查通过」一样）", () => {
    expect(HOOK).toContain("跳过站点构建");
  });

  test("北极星陈旧检测只扫已追踪文件（git grep），不扫工作区未追踪 md", () => {
    expect(HOOK).toContain('git grep -l "NORTHSTAR:BEGIN"');
    expect(HOOK).not.toContain('grep -rl "NORTHSTAR:BEGIN" --include="*.md" .');
  });
});

/** 当前 HEAD 的 sha（tmpdir 仓库里用）。 */
function ref_HEAD(dir: string): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error("rev-parse HEAD 失败");
  return (r.stdout ?? "").trim();
}
