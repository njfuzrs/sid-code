/**
 * PR-2（B3）：工作区内 `cd` + 只读主体的复合命令判定
 *
 * 修的是「`cd <会话 cwd> && git log` 在所有模式下都弹窗」：本会话 51 条 bash 普通确认里
 * 22 条是这个形态，合计等了 327.8s。
 *
 * 两组用例：
 * - **变化**：工作区内 `cd` + 只读主体放行（`&&` / `;` / 换行都算）；
 * - **必须不变**：越界、非字面量、`||` / 后台 `&` / 子 shell、写主体、cd 后相对路径读重定向
 *   一律不放行。这些修前的结果只是碰巧对，没有专门的检查在守它们。
 *
 * 纯逻辑用例注入假的 `isWithinWorkingDirectories` / `resolveRealPath`（快）；
 * 含 git 段的用例要真实仓库（`judgeReadOnlyGitInOwnRepo` 会 stat + 跑 git），
 * 在 `describe` 里用 tmpdir 建一份。落盘全部重定向到 tmpdir（CONTRIBUTING 测试约定）。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeReadOnlyCompoundBash } from "@sid-code/core/permission/readonly-compound.ts";

const WS = "/repo";
const SUB = "/repo/packages/core";

/** 假的工作区判定：前缀匹配 + 精确相等 */
function within(ws: string) {
  return (p: string) => p === ws || p.startsWith(`${ws}/`);
}

function judgeWith(command: string, startCwd = WS) {
  return judgeReadOnlyCompoundBash({
    command,
    startCwd,
    ownCommonDir: null,
    isWithinWorkingDirectories: within(WS),
  });
}

describe("工作区内 cd + 只读主体：放行", () => {
  test("&& 连接", () => {
    for (const cmd of [
      `cd ${WS} && ls`,
      `cd ${WS} && ls -la`,
      `cd ${WS} && cat README.md`,
      `cd ${SUB} && grep -n foo README.md`,
      // 组合：一次 cd 之后多条只读
      `cd ${WS} && ls && pwd`,
      // cd 到父目录（仍在工作区内）
      `cd .. && ls`,
    ]) {
      const r = judgeWith(cmd, SUB);
      expect(r.applicable, cmd).toBe(true);
      expect(r.readOnly, `${cmd} → ${r.reason ?? ""}`).toBe(true);
    }
  });

  test("; 与换行连接", () => {
    for (const cmd of [
      `cd ${WS}; ls`,
      `cd ${WS}\nls`,
      `cd ${WS} && ls; pwd`,
      // cd 目标不存在：&& 后续不执行，静态上仍是安全形态
      `cd ${WS}/does-not-exist && ls`,
    ]) {
      const r = judgeWith(cmd);
      expect(r.applicable, cmd).toBe(true);
      expect(r.readOnly, `${cmd} → ${r.reason ?? ""}`).toBe(true);
    }
  });

  test("cd 之后的绝对路径读重定向不受影响", () => {
    const r = judgeWith(`cd ${WS} && cat < /etc/hosts`);
    expect(r.applicable).toBe(true);
    expect(r.readOnly).toBe(true);
  });
});

describe("工作区内 cd + 只读主体：不放行", () => {
  test("cd 目标越界 / 非字面量", () => {
    for (const cmd of [
      `cd /tmp && ls`,
      `cd ../../../etc && ls`,
      `cd ~ && ls`,
      `cd ~/x && ls`,
      `cd $HOME && ls`,
      `cd - && ls`,
      `cd && ls`,
      `cd ${WS} && cd; ls`,
    ]) {
      const r = judgeWith(cmd, SUB);
      expect(r.applicable, cmd).toBe(true);
      expect(r.readOnly, cmd).toBe(false);
    }
  });

  test("不支持的分隔符与子 shell", () => {
    for (const cmd of [`cd ${WS} || ls`, `cd ${WS} & ls`, `(cd ${WS} && ls)`]) {
      const r = judgeWith(cmd);
      expect(r.applicable, cmd).toBe(true);
      expect(r.readOnly, cmd).toBe(false);
    }
  });

  test("主体不是只读", () => {
    for (const cmd of [
      `cd ${WS} && rm -rf dist`,
      `cd ${WS} && echo x > out.txt`,
      `cd ${WS} && sed -i 's/a/b/' f`,
      `cd ${WS} && git checkout main`,
      `cd ${WS} && make`,
    ]) {
      const r = judgeWith(cmd);
      expect(r.applicable, cmd).toBe(true);
      expect(r.readOnly, `${cmd} → ${r.reason ?? ""}`).toBe(false);
    }
  });

  test("cd 之后的相对路径输入重定向", () => {
    const r = judgeWith(`cd ${SUB} && cat < in.txt`);
    expect(r.applicable).toBe(true);
    expect(r.readOnly).toBe(false);
  });

  test("cd 之前出现的相对路径读重定向不归本判据管（沿用原口径）", () => {
    const r = judgeWith(`cat < in.txt; cd ${WS} && ls`);
    expect(r.applicable).toBe(true);
    // 原口径已判只读，这里不该因为「链里有 cd」反过来拒它
    expect(r.readOnly).toBe(true);
  });

  test("pushd / popd 不算 cd 前进", () => {
    const r = judgeWith(`pushd ${WS} && ls`);
    expect(r.applicable).toBe(false);
    expect(r.readOnly).toBe(false);
  });
});

describe("不接管的情形", () => {
  test("整体已只读 → 交回工具自身判定", () => {
    for (const cmd of [`ls -la`, `git log --oneline`, `cat a.md | head`]) {
      const r = judgeWith(cmd);
      expect(r.applicable, cmd).toBe(false);
    }
  });

  test("没有 cd 段的非只读命令 → 交回后续确认", () => {
    const r = judgeWith(`rm -rf dist`);
    expect(r.applicable).toBe(false);
  });
});

describe("含 git 段：仓库归属（复用 PR-1 的边界判定）", () => {
  let configRoot: string;
  let root: string;
  /** 本仓根 */
  let ws: string;
  /** ws 内的嵌套独立仓库 */
  let nestedRepo: string;
  let prevConfigDir: string | undefined;

  function git(args: string[], cwd: string): void {
    execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...args], {
      cwd,
      stdio: "pipe",
    });
  }

  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(["init", "-q"], dir);
    git(["commit", "-q", "--allow-empty", "-m", "init"], dir);
  }

  const FIXTURE_TIMEOUT = 60_000;

  beforeAll(() => {
    prevConfigDir = process.env.SID_CONFIG_DIR;
    configRoot = mkdtempSync(join(tmpdir(), "sid-pr2-cfg-"));
    process.env.SID_CONFIG_DIR = configRoot;
    root = realpathSync(mkdtempSync(join(tmpdir(), "sid-pr2-")));
    ws = join(root, "repo");
    initRepo(ws);
    nestedRepo = join(ws, "vendor", "evil");
    initRepo(nestedRepo);
  }, FIXTURE_TIMEOUT);

  afterAll(() => {
    if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevConfigDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  test(
    "本仓内 cd + 只读 git 放行；cd 进嵌套异仓不放行",
    () => {
      const ownCommonDir = join(ws, ".git");
      const opts = {
        ownCommonDir,
        isWithinWorkingDirectories: within(ws),
        resolveRealPath: (p: string) => p,
      };
      const ok = judgeReadOnlyCompoundBash({
        command: `cd ${ws} && git log --oneline`,
        startCwd: ws,
        ...opts,
      });
      expect(ok.applicable).toBe(true);
      expect(ok.readOnly, ok.reason).toBe(true);

      const nested = judgeReadOnlyCompoundBash({
        command: `cd ${nestedRepo} && git log --oneline`,
        startCwd: ws,
        ...opts,
      });
      expect(nested.applicable).toBe(true);
      expect(nested.readOnly, nested.reason).toBe(false);

      const otherCwd = judgeReadOnlyCompoundBash({
        command: `cd ${ws} && git -C ${nestedRepo} log`,
        startCwd: ws,
        ...opts,
      });
      expect(otherCwd.readOnly, otherCwd.reason).toBe(false);
    },
    FIXTURE_TIMEOUT,
  );

  test(
    "`;` 连接时 cd 失败的原目录也要判本仓",
    () => {
      const ownCommonDir = join(ws, ".git");
      const r = judgeReadOnlyCompoundBash({
        command: `cd ${ws}/does-not-exist; git -C ${nestedRepo} log`,
        startCwd: ws,
        ownCommonDir,
        isWithinWorkingDirectories: within(ws),
        resolveRealPath: (p: string) => p,
      });
      expect(r.applicable).toBe(true);
      expect(r.readOnly, r.reason).toBe(false);
    },
    FIXTURE_TIMEOUT,
  );
});
