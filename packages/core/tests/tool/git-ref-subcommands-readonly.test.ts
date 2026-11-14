/**
 * B1：git 引用类子命令的写形态曾被判只读，default 模式下不经确认直接执行。
 *
 * 背景：`READ_ONLY_GIT_SUBCOMMANDS` 只按**子命令名**判只读，而 `stash` / `branch` /
 * `tag` / `remote` / `reflog` 五个子命令都同时有读形态和写形态：
 * 裸 `git stash` 等于 push、`git branch <name>` 是新建分支、`git tag <name>` 是新建 tag、
 * `git remote add` 配远端、`git reflog expire` 删 reflog。
 * 判定为只读后 `BashTool.checkPermissions` 直接返回 allow（checker Step 5.5），
 * 而 prompt 红线 RL-001 明写「`git stash` 同样禁止」——代码比 prompt 松。
 *
 * 修法：五个子命令移出 READ_ONLY_GIT_SUBCOMMANDS，各写一个**读形态白名单**判定
 * （isReadOnlyGitStash / Branch / Tag / Remote / Reflog），判不准时落确认。
 *
 * ⚠️ 权限端到端必须把工具对象传给 `check()` 的**第二个参数**。放进 `req.tool` 不生效，
 * Step 5.5 会被整个跳过，连 `git status` 都显示需确认，看起来像「没问题」而实际什么都没测到。
 *
 * ⚠️ 落盘隔离：PermissionChecker 构造 AuditLogger（mkdirSync 日志目录），BashTool 构造期
 * 会建 shell 快照（sidPaths.shellSnapshots()），两者都在 SID_CONFIG_DIR 下。
 * 恢复时存/恢复原值而非无条件 delete（同批测试同进程，直接删会抹掉 preload 兜底）。
 *
 * ⚠️ 工作区用真实 tmpdir，不用仓库路径：worktree 路径含 `.claude/`，
 * safetyCheck 会在规则判定之前命中，测到的就不是本文件的判定路径了。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReadOnlyCommand,
  isReadOnlyGitStash,
  isReadOnlyGitBranch,
  isReadOnlyGitTag,
  isReadOnlyGitRemote,
  isReadOnlyGitReflog,
} from "@sid-code/core/tool/bash/read-only-validation.ts";
import { BashTool } from "@sid-code/core/tool/bash.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import type { Tool, ToolUseContext } from "@sid-code/core/tool/types.ts";

/** 断言整批命令都判只读；失败时直接列出被判成写的命令，比逐条 toBe 好定位。 */
function expectAllReadOnly(commands: string[]) {
  expect(commands.filter((c) => !isReadOnlyCommand(c))).toEqual([]);
}

/** 断言整批命令都判非只读；失败时直接列出被误放行的命令。 */
function expectAllNotReadOnly(commands: string[]) {
  expect(commands.filter((c) => isReadOnlyCommand(c))).toEqual([]);
}

describe("B1 git stash 读写形态", () => {
  test("list / show 是读", () => {
    expectAllReadOnly([
      "git stash list",
      "git stash show",
      "git stash show -p",
      "git stash show --patch",
      "git stash show --stat",
      "git stash show stash@{0}",
      "git stash show -p stash@{0}",
      "git stash list --oneline",
      "git stash list --format='%gd %s'",
      "git stash list --format '%gd %s'",
      "git stash list 2>/dev/null",
    ]);
  });

  test("裸命令与其余动词是写", () => {
    // 裸 `git stash` 等于 `git stash push`，会改工作区（RL-001 明确禁止）
    expectAllNotReadOnly([
      "git stash",
      "git stash push",
      "git stash push -m wip",
      "git stash pop",
      "git stash apply",
      "git stash save",
      "git stash drop",
      "git stash clear",
      "git stash branch feat/x",
    ]);
  });

  test("无动词却带 flag 仍是写（-u 会 stash 未跟踪文件）", () => {
    expectAllNotReadOnly(["git stash -u", "git stash --include-untracked", "git stash -k"]);
  });

  test("白名单外的 flag 判写（保守方向）", () => {
    expectAllNotReadOnly(["git stash list -q", "git stash show --unknown-flag"]);
  });

  test("isReadOnlyGitStash 直接单测", () => {
    expect(isReadOnlyGitStash(["list"])).toBe(true);
    expect(isReadOnlyGitStash(["show", "-p"])).toBe(true);
    expect(isReadOnlyGitStash([])).toBe(false);
    expect(isReadOnlyGitStash(["push"])).toBe(false);
    expect(isReadOnlyGitStash(["-u"])).toBe(false);
  });
});

describe("B1 git branch 读写形态", () => {
  test("列表 / 显示形态是读", () => {
    expectAllReadOnly([
      "git branch",
      "git branch -a",
      "git branch --all",
      "git branch -r",
      "git branch -v",
      "git branch -vv",
      "git branch --show-current",
      "git branch -l",
      "git branch --list",
      "git branch --list 'feat/*'",
      "git branch -l 'feat/*'",
      "git branch --contains abc123",
      "git branch --no-contains abc123",
      "git branch --merged",
      "git branch --no-merged",
      "git branch --points-at HEAD",
      "git branch --sort=-committerdate",
      "git branch --format='%(refname:short)'",
      "git branch -a --no-color",
      // fd 复制记号不是位置参数（原型回放里这一条造成 6 次误判）
      "git branch -a 2>&1",
    ]);
  });

  test("新建 / 改名 / 删除 / 设上游是写", () => {
    expectAllNotReadOnly([
      "git branch feat/x", // 没有 --list 的位置参数 = 新建分支
      "git branch feat/x abc123",
      "git branch -m old new",
      "git branch -M new",
      "git branch -c a b",
      "git branch -C a b",
      "git branch -d feat/x",
      "git branch -D feat/x",
      "git branch -f feat/x HEAD",
      "git branch -u origin/main",
      "git branch --set-upstream-to=origin/main",
      "git branch -t origin/main",
      "git branch --edit-description",
    ]);
  });

  test("--contains 的值可省略：下一个 token 不以 - 开头才吞", () => {
    // 吞对了：feat/x 是值，不是「新建分支」
    expectAllReadOnly(["git branch --contains feat/x", "git branch --merged main"]);
    // 不吞：`-a` 是 flag 不是值，所以整条仍是读
    expectAllReadOnly(["git branch --contains -a", "git branch --points-at -r"]);
  });

  test("isReadOnlyGitBranch 直接单测", () => {
    expect(isReadOnlyGitBranch(["--show-current"])).toBe(true);
    expect(isReadOnlyGitBranch([])).toBe(true);
    expect(isReadOnlyGitBranch(["feat/x"])).toBe(false);
    expect(isReadOnlyGitBranch(["-m", "old", "new"])).toBe(false);
    expect(isReadOnlyGitBranch(["--contains", "feat/x"])).toBe(true);
  });
});

describe("B1 git tag 读写形态", () => {
  test("列表 / 查询 / 校验签名是读", () => {
    expectAllReadOnly([
      "git tag",
      "git tag -l",
      "git tag --list",
      "git tag --list 'v1*'",
      "git tag -l 'v1*'",
      "git tag -n",
      "git tag -n5",
      "git tag --contains abc123",
      "git tag --no-contains abc123",
      "git tag --merged",
      "git tag --points-at HEAD",
      "git tag --sort=-version:refname",
      "git tag --format='%(refname:short)'",
      "git tag -v v1.0.0",
      "git tag --verify v1.0.0",
      // fd 复制记号不是位置参数
      "git tag 2>&1",
    ]);
  });

  test("新建 / 删除 / 强制是写", () => {
    expectAllNotReadOnly([
      "git tag v1.0.0", // 没有 -l/-v 的位置参数 = 新建 tag
      "git tag -a v1.0.0 -m release",
      "git tag -s v1.0.0 -m release",
      "git tag -u KEY v1.0.0",
      "git tag -m msg v1.0.0",
      "git tag -F .git/TAG_EDITMSG v1.0.0",
      "git tag -d v1.0.0",
      "git tag --delete v1.0.0",
      "git tag -f v1.0.0",
      "git tag -e v1.0.0",
    ]);
  });

  test("isReadOnlyGitTag 直接单测", () => {
    expect(isReadOnlyGitTag([])).toBe(true);
    expect(isReadOnlyGitTag(["-l", "v1*"])).toBe(true);
    expect(isReadOnlyGitTag(["-v", "v1.0.0"])).toBe(true);
    expect(isReadOnlyGitTag(["v1.0.0"])).toBe(false);
    expect(isReadOnlyGitTag(["-d", "v1.0.0"])).toBe(false);
  });
});

describe("B1 git remote 读写形态", () => {
  test("无参数 / -v / show / get-url 是读", () => {
    expectAllReadOnly([
      "git remote",
      "git remote -v",
      "git remote --verbose",
      "git remote show origin",
      "git remote show",
      "git remote get-url origin",
    ]);
  });

  test("增删改远端是写", () => {
    expectAllNotReadOnly([
      "git remote add origin git@example.com:x.git",
      "git remote remove origin",
      "git remote rm origin",
      "git remote rename a b",
      "git remote set-url origin git@example.com:y.git",
      "git remote set-head origin main",
      "git remote set-branches origin main",
      "git remote prune origin",
      "git remote update",
    ]);
  });

  test("isReadOnlyGitRemote 直接单测", () => {
    expect(isReadOnlyGitRemote([])).toBe(true);
    expect(isReadOnlyGitRemote(["-v"])).toBe(true);
    expect(isReadOnlyGitRemote(["show", "origin"])).toBe(true);
    expect(isReadOnlyGitRemote(["add", "origin", "url"])).toBe(false);
    expect(isReadOnlyGitRemote(["prune"])).toBe(false);
  });
});

describe("B1 git reflog 读写形态", () => {
  test("无参数 / 纯 flag / show 是读", () => {
    expectAllReadOnly([
      "git reflog",
      "git reflog -12",
      "git reflog -n 5",
      "git reflog --all",
      "git reflog show",
      "git reflog show main",
      "git reflog --format='%h %gs'",
    ]);
  });

  test("expire / delete 是写", () => {
    expectAllNotReadOnly([
      "git reflog expire --expire=now --all",
      "git reflog expire --expire-unreachable=now --all",
      "git reflog delete HEAD@{1}",
      "git reflog drop HEAD@{1}",
    ]);
  });

  test("isReadOnlyGitReflog 直接单测", () => {
    expect(isReadOnlyGitReflog([])).toBe(true);
    expect(isReadOnlyGitReflog(["-n", "5"])).toBe(true);
    expect(isReadOnlyGitReflog(["show"])).toBe(true);
    expect(isReadOnlyGitReflog(["expire"])).toBe(false);
    expect(isReadOnlyGitReflog(["delete", "HEAD@{1}"])).toBe(false);
  });
});

describe("B1 全局选项前缀 / 复合命令 / 真实读形态原文", () => {
  test("--no-pager 前缀不改变读写语义；-C 换仓库不再被剥离（B2）", () => {
    // `--no-pager` 不影响「用哪个仓库」，剥离后读/写语义不变
    expectAllReadOnly([
      "git --no-pager branch -vv",
      "git --no-pager tag -l",
      "git --no-pager reflog -12",
    ]);
    expectAllNotReadOnly(["git --no-pager stash", "git --no-pager branch -m old new"]);

    // B2：`-C` 改变「用哪个仓库」，与 `cd <dir>` 同等对待，纯文本层一律判非只读。
    // `git -C <本仓内目录>` 的放行由权限层补回（见 tests/permission/git-readonly-boundary.test.ts），
    // 不在 isReadOnlyCommand 这一层。
    expectAllNotReadOnly([
      "git -C /tmp stash list",
      "git -C /tmp branch --show-current",
      "git -C /tmp stash",
      "git -C /tmp branch -m old new",
      "git -C /tmp tag v1.0.0",
    ]);
  });

  test("复合命令里任一写形态即整条判写", () => {
    expectAllNotReadOnly([
      "git stash && git status",
      "git status && git stash",
      "git branch --show-current && git branch -m old new",
      "git stash list; git stash pop",
    ]);
    expectAllReadOnly(["git status && git branch --show-current", "git stash list | head -3"]);
  });

  test("▎§2.4 轨迹里出现过的真实读形态原文（311 / 329 次，权限结论不变）", () => {
    expectAllReadOnly([
      "git branch --show-current",
      "git branch -a",
      "git branch -vv",
      "git branch -r",
      "git branch --contains abc1234",
      "git branch --list",
      "git branch --merged",
      "git branch",
      "git remote -v",
      "git tag",
      "git tag -l",
      "git tag --list",
      "git tag --sort=-creatordate",
      "git stash list",
      "git reflog -12",
    ]);
  });

  test("▎§2.4 轨迹里出现过的真实写形态（18 次，修后转确认）", () => {
    expectAllNotReadOnly([
      "git branch -m old-name new-name",
      "git branch -d feat/x",
      "git branch -f feat/x HEAD",
      "git stash push",
    ]);
  });

  test("命令替换的内层命令只读判定看不见：这条会判写，权限层由 Step 2 兜住", () => {
    // 方案 §6.3 允许的 2 次例外：`git branch --contains $(…)` 修后判写。
    // 它们在 Step 2 已因「命令替换注入」需确认，权限结论不变。
    expectAllNotReadOnly(["git branch --contains $(git rev-parse HEAD)"]);
  });

  test("其余只读 git 子命令不受影响（对照，别修回归）", () => {
    expectAllReadOnly([
      "git status",
      "git log --oneline",
      "git diff",
      "git describe --tags",
      "git rev-parse HEAD",
      "git config --get user.name",
    ]);
  });
});

// ─────────────────────────── 权限端到端 ───────────────────────────

let configRoot: string;
let workspace: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "sid-b1-perm-cfg-"));
  workspace = mkdtempSync(join(tmpdir(), "sid-b1-perm-ws-"));
  mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
  prevConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * BashTool 实现的是旧工具接口，而 checker 的第二个参数要新 `Tool` 接口。
 * 这里只桥接 Step 5.5 真正会调的那一个方法（`checker.ts` 里 `tool?.checkPermissions`），
 * 运行期仍是真实 `BashTool.checkPermissions` —— 生产路径（`query/tool-executor.ts`）
 * 传给 checker 的也是同一个工具对象。
 *
 * ⚠️ 工具对象必须作为 `check()` 的**第二个参数**传入。放进 `req.tool` 不生效，
 * Step 5.5 被整个跳过，于是读形态也会显示需确认 —— 下面的「读形态直接允许」断言
 * 就是这条陷阱的探针：它绿说明 Step 5.5 确实生效了。
 */
function bashToolForChecker(bash: BashTool): Tool {
  return {
    name: "bash",
    checkPermissions: (input: unknown, ctx: ToolUseContext) => bash.checkPermissions(input, ctx),
  } as unknown as Tool;
}

async function checkCommand(mode: "default" | "acceptEdits", bash: BashTool, command: string) {
  const checker = new PermissionChecker(
    { ...defaultConfig(), permissionMode: mode },
    undefined,
    workspace,
  );
  // `cwd` 必须显式给 workspace：B4 按命令的**实际起始目录**判仓库归属，不给就退回
  // 进程真实 cwd（= sid-code 源码目录），与 workspace 的 `.git` 对不上 → 只读 git 全落确认。
  return checker.check(
    { toolName: "bash", input: { command, cwd: workspace } },
    bashToolForChecker(bash),
  );
}

describe("B1 权限端到端：写形态不再被工具级只读早退放行", () => {
  for (const mode of ["default", "acceptEdits"] as const) {
    test(`${mode}：写形态需确认`, async () => {
      const bash = new BashTool();
      for (const command of [
        "git stash",
        "git stash push -m wip",
        "git tag -d v1.0.0",
        "git tag v1.0.0",
        "git branch -m old new",
        "git branch feat/x",
        "git remote add origin git@example.com:x.git",
        "git reflog expire --expire=now --all",
      ]) {
        const r = await checkCommand(mode, bash, command);
        expect({ command, allowed: r.allowed }).toEqual({ command, allowed: false });
        expect({ command, needsConfirmation: r.needsConfirmation }).toEqual({
          command,
          needsConfirmation: true,
        });
      }
    });

    test(`${mode}：读形态直接允许`, async () => {
      const bash = new BashTool();
      for (const command of [
        "git stash list",
        "git branch --show-current",
        "git branch -a",
        "git tag -l",
        "git remote -v",
        "git reflog -12",
      ]) {
        const r = await checkCommand(mode, bash, command);
        expect({ command, allowed: r.allowed }).toEqual({ command, allowed: true });
      }
    });
  }

  test("对照：`git restore a.ts` 修前修后都需确认（本缺陷不碰它）", async () => {
    const bash = new BashTool();
    const r = await checkCommand("default", bash, "git restore a.ts");
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });
});
