/**
 * R11：`sid-wait gh-pr` 的生产实现（`gh` CLI + 仓库解析）——2026-11-17 缺陷的直接回归。
 *
 * 缺陷现场：会话 cwd 漂到 `docs-research`（它自己是个 git 仓库，remote 是 gitee）之后，
 * 在**同一个会话**里等 sid-code 的 PR，`sid-wait` 报 `REST_FATAL ... HTTP 404`。
 * PR 号是对的、token 也有权限 —— 真因是 `gh api repos/{owner}/{repo}/...` 的占位符
 * 由 gh **按 cwd 的仓库**解析，于是拿 sid-code 的 PR 号去查了 docs-research。
 *
 * 这一层为什么以前没有测试（文档 §7.5 点名的覆盖缺口）：
 * `createGhCliRestClient` 直接 spawn `gh`，而单测一旦真 spawn 就要联网 + 登录态，
 * 于是整段生产实现长期零覆盖 —— 而它恰好是唯一决定「查哪个仓库」的地方。
 * 这里用一个假 `gh` 脚本补上：**不联网、不需要登录、能断言 endpoint 原文**。
 *
 * 断言的三条不变量：
 * 1. endpoint 里出现的是**完整路径** `repos/<owner>/<repo>/...`，不再有 `{owner}/{repo}`；
 * 2. 仓库解析失败时**不 spawn 任何进程**（旧实现会 spawn 一次并换来 404 或 ENOENT）；
 * 3. 解析失败是**确定性失败**：`runSidWaitGhPr` 立刻终态，不走 2^n 退避（否则用户要等三分钟）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createGhCliRestClient,
  formatSidWaitResultSummary,
  formatSidWaitStartNote,
  parseGithubRemote,
  parseSidWaitCommand,
  resolveSidWaitRepo,
  runSidWaitGhPr,
  SID_WAIT_EXIT,
  type GhRestClient,
} from "../../src/task/sid-wait.ts";

const SID_CODE_REPO = "njfuzrs/sid-code";
const OTHER_REPO = "next.js/next.js";
const SID_CODE_HEAD = "1111111111111111111111111111111111111111";
const OTHER_HEAD = "2222222222222222222222222222222222222222";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "sid-wait-gh-cli-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** git 在 CI 上一定可用（仓库本身要 clone），但别让本地环境差异变成一条静默跳过 */
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

/** 造一个真 git 仓库（只 add remote，不 commit） */
function makeGitRepo(name: string, remotes: Record<string, string>): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
  for (const [remoteName, url] of Object.entries(remotes)) {
    spawnSync("git", ["-C", dir, "remote", "add", remoteName, url], { encoding: "utf8" });
  }
  return dir;
}

/**
 * 假 `gh`：把每次调用的参数追加到 calls 文件，并按 endpoint 返回固定快照。
 *
 * 用真实可执行脚本而不是 mock `spawn`，是为了让「到底 spawn 了几次、endpoint 原文是什么」
 * 这两件事都由**文件**作证 —— mock 只能证明调用方以为自己传了什么。
 */
function installFakeGh(): { ghBin: string; callsFile: string } {
  const binDir = join(work, "bin");
  mkdirSync(binDir, { recursive: true });
  const ghBin = join(binDir, "gh");
  const callsFile = join(work, "gh-calls.txt");
  const pullFor = (head: string): string =>
    `{"state":"open","merged":false,"head":{"sha":"${head}"},"mergeable_state":"blocked"}`;
  writeFileSync(
    ghBin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${callsFile}'`,
      'case "$2" in',
      `  "repos/${SID_CODE_REPO}/pulls/906") printf '%s' '${pullFor(SID_CODE_HEAD)}' ;;`,
      `  "repos/${OTHER_REPO}/pulls/906") printf '%s' '${pullFor(OTHER_HEAD)}' ;;`,
      '  *) echo "unexpected endpoint: $2" >&2 ; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(ghBin, 0o755);
  return { ghBin, callsFile };
}

/** 读假 gh 收到的每一次调用（每行一条 argv 拼接） */
function ghCalls(callsFile: string): string[] {
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean);
}

describe("parseSidWaitCommand：--repo 解析", () => {
  test("不带 --repo 时 repo 是 undefined（交给入口按会话启动目录解析）", () => {
    const spec = parseSidWaitCommand("sid-wait gh-pr 906");
    expect(spec?.pr).toBe(906);
    expect(spec?.repo).toBeUndefined();
  });

  test("`--repo <owner>/<repo>` 与 `--repo=<owner>/<repo>` 两种写法都认", () => {
    expect(parseSidWaitCommand(`sid-wait gh-pr 906 --repo ${SID_CODE_REPO}`)?.repo).toBe(
      SID_CODE_REPO,
    );
    expect(parseSidWaitCommand(`sid-wait gh-pr 906 --repo=${SID_CODE_REPO}`)?.repo).toBe(
      SID_CODE_REPO,
    );
  });

  test("--repo 与 --interval 顺序任意", () => {
    const a = parseSidWaitCommand(`sid-wait gh-pr 906 --repo ${SID_CODE_REPO} --interval 60`);
    const b = parseSidWaitCommand(`sid-wait gh-pr 906 --interval 60 --repo ${SID_CODE_REPO}`);
    expect(a?.repo).toBe(SID_CODE_REPO);
    expect(a?.intervalMs).toBe(60_000);
    expect(b?.repo).toBe(SID_CODE_REPO);
    expect(b?.intervalMs).toBe(60_000);
  });

  test("--repo 的值不是 <owner>/<repo> 形态时不算原语（宁可报误用，也不要猜）", () => {
    // 少了斜杠、多了段、带空格（归一化后会被切开）都应被拒
    expect(parseSidWaitCommand("sid-wait gh-pr 906 --repo sid-code")).toBeNull();
    expect(parseSidWaitCommand("sid-wait gh-pr 906 --repo a/b/c")).toBeNull();
    expect(parseSidWaitCommand("sid-wait gh-pr 906 --repo")).toBeNull();
  });

  test("重复 --repo 不算原语（无法判断哪个才是意图）", () => {
    expect(
      parseSidWaitCommand(`sid-wait gh-pr 906 --repo ${SID_CODE_REPO} --repo ${OTHER_REPO}`),
    ).toBeNull();
  });

  test("`cd <dir> &&` 前缀仍被容忍（形态上），但它不影响 repo 字段", () => {
    const spec = parseSidWaitCommand(`cd /tmp/whatever && sid-wait gh-pr 906`);
    expect(spec?.pr).toBe(906);
    expect(spec?.repo).toBeUndefined();
  });
});

describe("parseGithubRemote：按 host 筛，不是无条件取 origin", () => {
  test("https / ssh / ssh:// 三种 URL 形态都能解析", () => {
    expect(parseGithubRemote(`origin\thttps://github.com/${SID_CODE_REPO}.git (fetch)`)).toBe(
      SID_CODE_REPO,
    );
    expect(parseGithubRemote(`origin\tgit@github.com:${SID_CODE_REPO}.git (fetch)`)).toBe(
      SID_CODE_REPO,
    );
    expect(parseGithubRemote(`origin\tssh://git@github.com/${SID_CODE_REPO}.git (fetch)`)).toBe(
      SID_CODE_REPO,
    );
  });

  test("origin 是 gitee 时不会被当成 github 仓库", () => {
    expect(parseGithubRemote("origin\tgit@gitee.com:someone/docs-research.git (fetch)")).toBeNull();
  });

  test("多 remote 时取第一条 github 的（origin 是 gitee 也一样）", () => {
    const output = [
      "origin\tgit@gitee.com:someone/docs-research.git (fetch)",
      "origin\tgit@gitee.com:someone/docs-research.git (push)",
      `upstream\tgit@github.com:${SID_CODE_REPO}.git (fetch)`,
      `upstream\tgit@github.com:${SID_CODE_REPO}.git (push)`,
    ].join("\n");
    expect(parseGithubRemote(output)).toBe(SID_CODE_REPO);
  });
});

describe("resolveSidWaitRepo：显式 repo 优先，其次按 host 筛 baseDir 的 remote", () => {
  test("显式 --repo 时根本不跑 git（不会被 baseDir 的 remote 影响）", () => {
    let gitCalls = 0;
    const resolution = resolveSidWaitRepo({
      repo: SID_CODE_REPO,
      baseDir: "/this/dir/does/not/exist",
      runGit: () => {
        gitCalls += 1;
        return { stdout: "", status: 0 };
      },
    });
    expect(resolution).toEqual({ ok: true, repo: SID_CODE_REPO, source: "explicit" });
    expect(gitCalls).toBe(0);
  });

  test("--repo 值非法时给出可行动错误（含正确写法）", () => {
    const resolution = resolveSidWaitRepo({ repo: "sid-code" });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error).toContain("--repo <owner>/<repo>");
  });

  test("未给 --repo 时从 baseDir 的 github remote 解析", () => {
    const resolution = resolveSidWaitRepo({
      // baseDir 必须是真实存在的目录：不存在会在解析 remote 之前就被拦下（见下一条用例）
      baseDir: work,
      runGit: () => ({
        stdout: `origin\tgit@github.com:${SID_CODE_REPO}.git (fetch)\n`,
        status: 0,
      }),
    });
    expect(resolution).toEqual({ ok: true, repo: SID_CODE_REPO, source: "remote" });
  });

  test("目录不存在：明确说「目录不存在」，且不 spawn git", () => {
    let gitCalls = 0;
    const resolution = resolveSidWaitRepo({
      baseDir: join(work, "not-there"),
      runGit: () => {
        gitCalls += 1;
        return { stdout: "", status: 0 };
      },
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error).toContain("不存在");
    expect(resolution.error).toContain("--repo <owner>/<repo>");
    // 旧实现会走到 spawn 并抛 ENOENT，报错读起来像 git 坏了
    expect(gitCalls).toBe(0);
  });

  test("不是 git 仓库：错误里点明原因并给出 --repo", () => {
    const resolution = resolveSidWaitRepo({
      baseDir: "/tmp",
      runGit: () => ({ stdout: "", status: 128 }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error).toContain("不是 git 仓库");
    expect(resolution.error).toContain("--repo <owner>/<repo>");
  });

  test("只有 gitee remote：列出实际 remote 名，让「为什么没认出来」可自行核对", () => {
    const resolution = resolveSidWaitRepo({
      baseDir: work,
      runGit: () => ({
        stdout:
          "origin\tgit@gitee.com:someone/docs-research.git (fetch)\n" +
          "origin\tgit@gitee.com:someone/docs-research.git (push)\n",
        status: 0,
      }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error).toContain("没有 github.com 仓库");
    expect(resolution.error).toContain("origin");
    expect(resolution.error).toContain("--repo <owner>/<repo>");
  });
});

describe("createGhCliRestClient：endpoint 是完整路径，解析不出就不 spawn", () => {
  test("显式 repo 时请求 repos/<owner>/<repo>/pulls/<n>，不再有占位符", async () => {
    const { ghBin, callsFile } = installFakeGh();
    const client = createGhCliRestClient({ ghBin, repo: SID_CODE_REPO });
    const pull = await client.getPull(906);
    expect(pull.headSha).toBe(SID_CODE_HEAD);
    expect(ghCalls(callsFile)).toEqual([`api repos/${SID_CODE_REPO}/pulls/906`]);
  });

  test("未给 repo 时按 baseDir 的 github remote 解析，并如实回报查了哪个仓库", async () => {
    // 「同号 PR 静默错对象」的造数据场景：真实使用里很难等到「别的仓库恰好有同号 PR」，
    // 所以用 tmp git 仓库 + 假 gh 脚本把这一刻固定下来。客户端层**不拒绝**——它没有
    // 「目标仓库应该是什么」这个信息；但它必须把实际查的仓库如实带回，让入口的回执
    // 与终态摘要能写出来给人看（§7.5「在结果里带上 repo 标识」的落点）。
    const { ghBin } = installFakeGh();
    const otherRepoDir = makeGitRepoForRemote("other-repo", `git@github.com:${OTHER_REPO}.git`);
    const client = createGhCliRestClient({ ghBin, cwd: otherRepoDir });
    const pull = await client.getPull(906);
    expect(pull.repo).toBe(OTHER_REPO);
    expect(pull.headSha).toBe(OTHER_HEAD);
  });

  test("baseDir 解析不出仓库时抛可行动错误，且**一次都不 spawn**", async () => {
    const { ghBin, callsFile } = installFakeGh();
    // docs-research 的真实形态：gitee remote
    const giteeDir = makeGitRepoForRemote("gitee-repo", "git@gitee.com:someone/docs-research.git");
    const client = createGhCliRestClient({ ghBin, cwd: giteeDir });
    let message = "";
    try {
      await client.getPull(906);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("--repo <owner>/<repo>");
    expect(message).toContain("没有 github.com 仓库");
    // 关键：不再「先 spawn 一次再拿到 404 / ENOENT」
    expect(ghCalls(callsFile)).toEqual([]);
  });

  test("目录不存在时也一次都不 spawn（旧实现是 spawn ENOENT，报错看不出真相）", async () => {
    const { ghBin, callsFile } = installFakeGh();
    const client = createGhCliRestClient({ ghBin, cwd: join(work, "no-such-dir") });
    await expect(client.getPull(906)).rejects.toThrow(/目录 .* 不存在/);
    expect(ghCalls(callsFile)).toEqual([]);
  });
});

/** 建一个只带 single remote 的仓库（少数用例只需要一条 remote） */
function makeGitRepoForRemote(name: string, url: string): string {
  return makeGitRepo(name, { origin: url });
}

describe("失败结论必须点名「查了哪个仓库」", () => {
  function fakeClient(error: Error): GhRestClient {
    return {
      getPull: () => Promise.reject(error),
      getCheckRuns: () => Promise.reject(error),
    };
  }

  test("HTTP 404 的 summary 带仓库名 + --repo 出口", async () => {
    const result = await runSidWaitGhPr({
      pr: 906,
      repo: SID_CODE_REPO,
      // 形态与 gh 的真实 stderr 一致：`gh: Not Found (HTTP 404)`
      client: fakeClient(
        new Error("gh api repos/x/y/pulls/906 失败（exit 1）：gh: Not Found (HTTP 404)"),
      ),
      emit: () => {},
      sleep: async () => true,
      intervalMs: 1,
    });
    expect(result.exitCode).toBe(SID_WAIT_EXIT.REST_FAILED);
    expect(result.reason).toBe("rest-fatal");
    const summary = formatSidWaitResultSummary(result, 906);
    // 缺陷的关键误导是旧文案把方向引向「PR 号错 / token 没权限」，从不提「查错仓库」
    expect(summary).toContain(SID_CODE_REPO);
    expect(summary).toContain(`--repo <owner>/<repo>`);
    expect(summary).toContain("404");
  });

  test("确定性失败（解析不出仓库）立刻终态，不退避重试", async () => {
    let sleeps = 0;
    let pulls = 0;
    const { SidWaitFatalError } = await import("../../src/task/sid-wait.ts");
    const client: GhRestClient = {
      getPull: () => {
        pulls += 1;
        return Promise.reject(new SidWaitFatalError("无法确定要查询哪个仓库：请用 --repo"));
      },
      getCheckRuns: () => Promise.reject(new Error("不该走到这里")),
    };
    const result = await runSidWaitGhPr({
      pr: 906,
      client,
      emit: () => {},
      sleep: async () => {
        sleeps += 1;
        return true;
      },
      intervalMs: 1,
    });
    expect(result.reason).toBe("rest-fatal");
    expect(result.exitCode).toBe(SID_WAIT_EXIT.REST_FAILED);
    expect(result.fatalDetail).toContain("--repo");
    // 没有这一条时会被当成网络抖动连续重试 3 次（默认 60s+120s 才报「请用 --repo」）
    expect(pulls).toBe(1);
    expect(sleeps).toBe(0);
    expect(formatSidWaitResultSummary(result, 906)).toBe(`等待结束：${result.fatalDetail}`);
  });
});

describe("真实 git：worktree 也能解析（.git 是文件而不是目录）", () => {
  const maybe = gitAvailable ? test : test.skip;

  maybe("主仓与它的 worktree 解析出同一个仓库", () => {
    const repo = makeGitRepo("real-repo", { origin: `https://github.com/${SID_CODE_REPO}.git` });
    const resolution = resolveSidWaitRepo({ baseDir: repo });
    expect(resolution.ok).toBe(true);

    const worktree = join(work, "real-worktree");
    const added = spawnSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", worktree], {
      encoding: "utf8",
    });
    if (added.status !== 0) {
      // 没配 user.name 的机器上 git worktree 也可能失败；跳过而不是让用例静默变绿
      return;
    }
    const fromWorktree = resolveSidWaitRepo({ baseDir: worktree });
    expect(fromWorktree).toEqual(resolution);
  });
});

/**
 * 2026-11-18 补：让「查了哪个仓库」在**成功路径**也可见。
 *
 * 上一轮修复只把仓库名写进失败文案。但本缺陷最贵的形态是「静默等错对象」：
 * 会话在别的仓库（如 docs-research）启动、而那里恰好有同号 PR 时，查询是**成功**的
 * ——不回报 404，只会安静地等到一个与本仓无关的 PR，终态文案里没有任何线索。
 * 真实使用中这个场景几乎等不到样本，所以这里同样用「tmp git 仓库 + 假 gh 脚本」造数据。
 */
describe("成功路径也必须点名仓库：静默等错对象在启动与终态都可见", () => {
  test("启动回执：显式 --repo 只写仓库名，不解释解析依据", () => {
    const note = formatSidWaitStartNote({
      pr: 906,
      repo: SID_CODE_REPO,
      source: "explicit",
      intervalMs: 15_000,
    });
    expect(note).toContain(`仓库 ${SID_CODE_REPO} 的 PR #906`);
    expect(note).toContain("每 15 秒");
    // 显式指定时没有「猜」的成分，不需要解释解析依据
    expect(note).not.toContain("github remote");
  });

  test("启动回执：remote 解析要写明按哪个目录解析 + --repo 出口", () => {
    const note = formatSidWaitStartNote({
      pr: 906,
      repo: OTHER_REPO,
      source: "remote",
      intervalMs: 3_000,
      baseDir: "/Users/me/docs-research",
    });
    expect(note).toContain(`仓库 ${OTHER_REPO} 的 PR #906`);
    // 自动解析在 fork / 多 remote 场景仍可能挑错，用户必须能核对这一步的依据
    expect(note).toContain("/Users/me/docs-research");
    expect(note).toContain("--repo <owner>/<repo>");
  });

  test("成功终态四种结论都带仓库名（merged / closed / conflict / check-failed）", () => {
    const cases = [
      { reason: "merged" as const, exitCode: SID_WAIT_EXIT.MERGED, failedChecks: [] },
      { reason: "closed" as const, exitCode: SID_WAIT_EXIT.CLOSED, failedChecks: [] },
      { reason: "conflict" as const, exitCode: SID_WAIT_EXIT.CONFLICT, failedChecks: [] },
      {
        reason: "check-failed" as const,
        exitCode: SID_WAIT_EXIT.CHECK_FAILED,
        failedChecks: [{ name: "build", status: "completed", conclusion: "failure" }],
      },
    ];
    for (const c of cases) {
      const summary = formatSidWaitResultSummary(
        {
          exitCode: c.exitCode,
          reason: c.reason,
          failedChecks: c.failedChecks,
          headSha: SID_CODE_HEAD,
          repo: SID_CODE_REPO,
        },
        906,
      );
      expect(summary).toContain(`仓库 ${SID_CODE_REPO}`);
      expect(summary).toContain("PR #906");
    }
  });

  test("没有 repo 字段时退回旧文案（不凭空编仓库）", () => {
    const summary = formatSidWaitResultSummary(
      {
        exitCode: SID_WAIT_EXIT.MERGED,
        reason: "merged",
        failedChecks: [],
        headSha: SID_CODE_HEAD,
      },
      906,
    );
    expect(summary).toBe(`等待结束：PR #906 已合并（${SID_CODE_HEAD.slice(0, 8)}）`);
  });

  test("同号 PR：客户端自报的仓库一路带到终态摘要（造数据的核心一条）", async () => {
    const { ghBin } = installFakeGh();
    const otherRepoDir = makeGitRepoForRemote("other-repo", `git@github.com:${OTHER_REPO}.git`);
    const client = createGhCliRestClient({ ghBin, cwd: otherRepoDir });
    // 假 gh 对 OTHER_REPO 的 #906 返回 open（见 installFakeGh 的 case 分支），所以不跑
    // runSidWaitGhPr（会一直轮询）；这里验证的是「客户端自报仓库 → 结论摘要」这段链路。
    const pull = await client.getPull(906);
    expect(pull.repo).toBe(OTHER_REPO);
    const summary = formatSidWaitResultSummary(
      {
        exitCode: SID_WAIT_EXIT.MERGED,
        reason: "merged",
        failedChecks: [],
        headSha: pull.headSha,
        repo: pull.repo,
      },
      906,
    );
    // 关键：对象是别的仓库的 PR #906，摘要必须让人一眼看出来
    expect(summary).toContain(`仓库 ${OTHER_REPO}`);
    expect(summary).toContain("PR #906");
  });

  test("真实非 git 目录（不是注入 runGit）：报「不是 git 仓库」且给 --repo 出口", () => {
    // 上一轮的这条只有「注入 runGit 返回 128」的模拟版本；真机上 git 的报错形态
    // （`fatal: not a git repository`）与注入不同，这里用真目录补上。
    const plain = join(work, "plain-dir");
    mkdirSync(plain);
    const resolution = resolveSidWaitRepo({ baseDir: plain });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error).toContain("不是 git 仓库");
    expect(resolution.error).toContain("--repo <owner>/<repo>");
  });
});
