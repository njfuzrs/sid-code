/**
 * CG-2（台账 H3）：worktree 路径语义提示的**接线**测试
 *
 * 纯函数测试（`tests/worktree/path-semantics.test.ts`）只能证明文案本身对；
 * 它证明不了「工具真的调了那个函数」。这类漏接线在仓库里出现过多次，且形态是静默：
 * 函数写好、测试全绿、用户侧一点变化没有。所以这里**真跑 edit / write 工具**，
 * 断言最终回给模型的 output 里带着提示与替换路径。
 *
 * enter / exit worktree 要真建 git 仓库和 worktree 才能跑到成功分支，成本高于收益；
 * 那两处用源码接线断言锁（与 `clear-rotates-session-wiring.test.ts` 同一种静态门禁），
 * 文案本身由纯函数测试覆盖。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WriteTool } from "@sid-code/core/tool/write.ts";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import {
  setCurrentWorktreeSession,
  clearWorktreeSession,
} from "@sid-code/core/worktree/manager.ts";
import type { WorktreeSession } from "@sid-code/core/worktree/types.ts";

let sidHome: string;
let prevSidHome: string | undefined;
let repo: string;
let mainRoot: string;
let worktreePath: string;

function enterWorktree(): void {
  const session: WorktreeSession = {
    originalCwd: mainRoot,
    worktreePath,
    worktreeName: "feat+x",
    sessionId: "test-session",
    worktreeBranch: "worktree-feat+x",
    originalHeadCommit: "0".repeat(40),
  };
  setCurrentWorktreeSession(session);
}

beforeEach(() => {
  prevSidHome = process.env.SID_CONFIG_DIR;
  sidHome = realpathSync(mkdtempSync(join(tmpdir(), "sid-cg2-home-")));
  process.env.SID_CONFIG_DIR = sidHome;

  repo = realpathSync(mkdtempSync(join(tmpdir(), "sid-cg2-repo-")));
  mainRoot = join(repo, "main-repo");
  worktreePath = join(mainRoot, ".sid-code", "worktrees", "feat+x");
});

afterEach(() => {
  clearWorktreeSession();
  if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevSidHome;
  rmSync(repo, { recursive: true, force: true });
});

describe("write 工具在 worktree 会话里写主仓路径", () => {
  test("output 带「在主仓」与可执行的替换路径，且文件确实落在主仓", async () => {
    enterWorktree();
    const target = join(mainRoot, "src", "a.ts");
    const result = await new WriteTool().execute({
      file_path: target,
      content: "export const a=1;\n",
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("在主仓");
    expect(result.output).toContain(join(worktreePath, "src", "a.ts"));
    // 提示不改变行为：写入照样发生在模型指定的路径上（不拦截）
    expect(existsSync(target)).toBe(true);
  });

  test("写当前 worktree 内的路径：output 不带提示", async () => {
    enterWorktree();
    const target = join(worktreePath, "src", "a.ts");
    const result = await new WriteTool().execute({
      file_path: target,
      content: "export const a=1;\n",
    });

    expect(result.output).not.toContain("在主仓");
  });

  test("不在 worktree 会话里：主仓路径本来就是对的，output 不带提示", async () => {
    clearWorktreeSession();
    const target = join(mainRoot, "src", "b.ts");
    const result = await new WriteTool().execute({
      file_path: target,
      content: "export const b=1;\n",
    });

    expect(result.output).not.toContain("在主仓");
  });
});

describe("edit 工具在 worktree 会话里写主仓路径", () => {
  test("old_string='' 创建分支也带提示（两条成功出口都要接）", async () => {
    enterWorktree();
    const target = join(mainRoot, "src", "c.ts");
    const result = await new EditTool().execute({
      file_path: target,
      old_string: "",
      new_string: "export const c=1;\n",
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("在主仓");
    expect(result.output).toContain(join(worktreePath, "src", "c.ts"));
  });
});

describe("enter / exit worktree 的接线（源码断言）", () => {
  const enterSrc = readFileSync(
    join(import.meta.dir, "..", "..", "src", "tool", "enter-worktree.ts"),
    "utf-8",
  );
  const exitSrc = readFileSync(
    join(import.meta.dir, "..", "..", "src", "tool", "exit-worktree.ts"),
    "utf-8",
  );

  test("enter_worktree 的两条成功出口都调用了进入说明", () => {
    // 新建 + 进入已存在，两条出口各自 return，漏掉任一条都会让该场景继续用旧路径
    expect(enterSrc.split("enterWorktreePathsNotice(").length - 1).toBe(2);
  });

  test("exit_worktree 的 keep / remove 两条出口都调用了退出说明", () => {
    expect(exitSrc.split("exitWorktreePathsNotice(").length - 1).toBe(2);
  });
});
