/**
 * CG-1 / R5：enter_worktree 与 /worktree 的「不在 Git 仓库」报错必须带检查过的路径。
 *
 * 为什么这条值得一个测试：原实现只说「当前目录不在 Git 仓库中」，模型无法区分
 * 「bash cd 漂了 / 路径写错了 / 这目录确实不是仓库」这三种需要不同下一步的情况。
 * 01 §5.2 的基线是**单会话连续 27 次**撞同一句话。
 *
 * 判据是「报错文本里有它检查过的那个目录」+「有可执行的下一步」，
 * 而不是「文案更好看」——后者没法机械断言，前者可以。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EnterWorktreeTool } from "@sid-code/core/tool/enter-worktree.ts";
import { getCwd, setCwd } from "@sid-code/core/bootstrap/state.ts";
import { WorktreeCommand } from "@sid-code/cli/command/commands/worktree/worktree.ts";

let tmpRoot: string;
let originalGlobalCwd: string;

beforeEach(() => {
  originalGlobalCwd = getCwd();
  // mkdtemp 在 macOS 上是 /var/folders/...（符号链接），getCwd() 存的是逻辑路径，
  // 断言用同一个值即可
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-nogit-"));
});

afterEach(() => {
  setCwd(originalGlobalCwd);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

describe("enter_worktree 报错带路径（CG-1 R5）", () => {
  it("不在 Git 仓库时，报错含检查过的目录 + 下一步", async () => {
    setCwd(tmpRoot);
    const tool = new EnterWorktreeTool();

    const r = await tool.execute({ name: "demo" });

    expect(r.isError).toBe(true);
    // 判据 ①：说清楚检查的是哪个目录
    expect(String(r.output)).toContain(tmpRoot);
    // 判据 ②：给出可执行的下一步（不能只说"不在仓库里"）
    expect(String(r.output)).toContain("下一步");
    // 判据 ③：给出「用已有 worktree 可以绕过」这条出口 —— 这是模型最容易漏的一条
    expect(String(r.output)).toContain("path");
  });
});

describe("/worktree 报错带路径（CG-1 R5）", () => {
  it("不在 Git 仓库时，报错含检查过的目录", async () => {
    // 这个命令读的是 process.cwd()（W17 哨兵按源码字面量守它，不能改成变量），
    // 所以要用 process.chdir 摆场景，不是 setCwd。
    // macOS 上 chdir 之后 cwd() 给物理路径（/var → /private/var），断言用 realpath。
    const origProcessCwd = process.cwd();
    const real = realpathSync(tmpRoot);
    process.chdir(tmpRoot);
    try {
      const cmd = new WorktreeCommand();

      // call 的第二个参数（CommandContext）在该分支里不被使用
      const r = await cmd.call("", {} as never);

      expect(r.type).toBe("text");
      const value = String((r as { value: string }).value);
      expect(value).toContain(real);
      expect(value).toContain("下一步");
    } finally {
      // 绝不能漏恢复：同批多文件跑在同一进程里
      process.chdir(origProcessCwd);
    }
  });
});
