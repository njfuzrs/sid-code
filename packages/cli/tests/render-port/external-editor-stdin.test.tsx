/**
 * Ctrl+G 外部编辑器「终端卡死、什么都输不进去」的回归测试。
 *
 * 根因：handoff 只靠 isHandoffRef 让 Ink 自己的 readable 监听不读，但 CLI 的 KeypressContext /
 * MouseContext / TerminalContext 直接挂了 `stdin.on('data')`，流一直是 flowing，父进程持续读 tty fd，
 * 把按键从 vi 手里抢走（真 pty 实测：6 个字节编辑器只收到 1 个）。修复是让渡时 `stdin.pause()`、收回时 `resume()`。
 *
 * 断言三件事：让渡期间流是 paused；期间写入的字节不被 data 监听读走；收回后流恢复且字节照常交出（X5 不丢输入）。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const APP = join(import.meta.dir, "fixtures/external-editor-stdin-app.tsx");

describe("外部编辑器 handoff：stdin 流让渡", () => {
  test("让渡期间 pause stdin，父进程不再抢读；收回后 resume，期间输入照常交出", () => {
    const r = Bun.spawnSync(["bun", APP], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        NODE_ENV: "test",
        TERM: "xterm-256color",
      },
    });
    const stdout = r.stdout.toString();
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const m = stdout.match(/@@RESULT@@(.*)\n/);
    expect(m, stdout).not.toBeNull();
    const res = JSON.parse(m![1]!);
    // 让渡时 pause 一次（重复让渡不叠加），收回时 resume 一次（重复收回不再调）
    expect(res.callsAfterEnter).toBe("pause");
    expect(res.callsAfterExit).toBe("pause,resume");
    expect(res.callsAfterExit2).toBe("pause,resume");
    // 编辑器占着终端时，父进程的 data 监听一个字节都不能读到
    expect(res.seenDuring).toBe("");
    // 收回后期间的输入照常交出（X5 不丢输入）
    expect(res.seenAfter).toBe("q");
    expect(res.inputsAfter).toBe("q");
  });
});
