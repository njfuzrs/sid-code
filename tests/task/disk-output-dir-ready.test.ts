/**
 * 回归测试：initTaskOutput() 返回的 filePath 必须**立即**可被同步打开。
 *
 * 背景（2026-08-10 实测）：`DiskTaskOutput` 只在异步 `#drain()` 里 `mkdir` 输出目录，
 * 而 `shell-task.ts:145` 拿到 `filePath` 的下一句就是 `openSync(filePath, "w")`
 * —— openSync 不创建父目录。于是「目录存在」纯靠**别的任务恰好先跑过一次 drain**：
 *
 *   · 全量 `bun test` 时目录早被前面的测试建好 → 全绿，看不出问题
 *   · 单跑 `tests/tool/bash-stability.test.ts` → 稳定 3 个用例 ENOENT
 *
 * 这是**顺序依赖**，不是偶发 flaky。修复是在构造函数里同步 `mkdirSync`。
 *
 * 为什么这个测试有意义：它不依赖任何执行顺序 —— 每个用例都把 SID_CONFIG_DIR 指向
 * 一个**全新的、tasks/ 尚不存在的**临时目录，等于把生产里那个「谁都还没建过目录」
 * 的初始状态固定下来。缺了这道门禁，同类回归只会在别人单跑某个文件时才炸。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openSync, closeSync, existsSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initTaskOutput, flushTaskOutput, appendTaskOutput } from "../../src/task/disk-output.ts";
import { sidPaths } from "../../src/config/paths.ts";

let tmpHome: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  // 必须存原值再改：bun test 同批多文件跑在同一进程里，无条件 delete 会把
  // bunfig.toml preload 的全局隔离兜底一起抹掉（见 CONTRIBUTING.md 的测试约定）。
  originalConfigDir = process.env.SID_CONFIG_DIR;
  tmpHome = mkdtempSync(join(tmpdir(), "sid-disk-output-dir-"));
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = originalConfigDir;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("DiskTaskOutput 输出目录就绪性", () => {
  test("tasks/ 目录一开始不存在（前提自检）", () => {
    // 这条断言看着多余，实则是上面三条测试的**前提**：若隔离没生效、
    // 目录已被别处建好，后面几条就退化成永远通过的空测试。
    expect(existsSync(sidPaths.tasks())).toBe(false);
  });

  test("initTaskOutput 后目录立即存在（同步，不等 drain）", () => {
    const output = initTaskOutput("local_shell_dirtest1");
    // 关键：这里**没有 await 任何东西**。目录必须已经在了。
    expect(existsSync(sidPaths.tasks())).toBe(true);
    expect(output.filePath.startsWith(sidPaths.tasks())).toBe(true);
  });

  test("filePath 可被 openSync 立即打开（复现原 ENOENT 的确切调用序列）", () => {
    const output = initTaskOutput("local_shell_dirtest2");
    // 这两句就是 src/task/shell-task.ts:140→145 的原样序列。
    // 修复前这里抛 ENOENT: no such file or directory。
    let fd: number | undefined;
    expect(() => {
      fd = openSync(output.filePath, "w");
    }).not.toThrow();
    if (fd !== undefined) closeSync(fd);
    expect(existsSync(output.filePath)).toBe(true);
  });

  test("目录被外部删除后，写入仍能自愈（drain 里的 mkdir 兜底）", async () => {
    const taskId = "local_shell_dirtest3";
    const output = initTaskOutput(taskId);
    // 模拟长时间后台任务运行期间用户清理了 ~/.sid-code/tasks/
    rmSync(sidPaths.tasks(), { recursive: true, force: true });
    expect(existsSync(sidPaths.tasks())).toBe(false);

    appendTaskOutput(taskId, "自愈内容\n");
    await flushTaskOutput(taskId);

    expect(existsSync(output.filePath)).toBe(true);
  });
});
