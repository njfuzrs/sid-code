/**
 * run-statusline 执行层测试（P1-5）
 *
 * 覆盖：无配置返回 null / 脚本 stdout 透传 / 非零退出回退 null / 超时回退 null /
 * 同指纹节流复用 / clearStatusLineCache 清缓存。
 * 用真实 shell 命令（echo/exit/sleep）验证 spawn 路径，nowMs 由测试注入（可控节流）。
 *
 * ── ⚠ 超时口径：验证「别的行为」的用例给宽超时，验证「超时本身」的那条用生产默认值 ──
 *   本文件曾是全仓最不稳的测试，**同一个根因撞线三次**：
 *     · 2026-08-13 ubuntu：`node -e` 读 stdin 那条，耗时 **1002.91ms** 精确撞线
 *     · 2026-08-21 ubuntu：`同指纹 + 窗口内 → 复用缓存`
 *     · 2026-08-21 macOS：`脚本 stdout 透传（去尾换行）`
 *   三次都重跑即绿、本地连跑 5 次 40/40 全过。
 *
 *   头两次的修法都只换了**那一条**用例的命令（`node -e` → `cat`），没动根因，
 *   于是换个用例、换个平台又复发。真正的根因是：这些用例**验证的不是超时**
 *   （而是 stdout 透传 / 退出码 / 节流缓存），却全都吃着 `STATUSLINE_TIMEOUT_MS = 1000`
 *   这个**生产常量** —— 而 1s 对交互式 UI 是对的，对满载 CI runner 上 spawn
 *   一个子进程则余量极小。它们的成败取决于 runner 当时的负载，与被测行为无关。
 *
 *   所以：`TEST_TIMEOUT_MS`（宽超时）用于那 7 条，**唯独** `超时 → 回退 null`
 *   那条继续走默认值。这条刻意不放宽 —— 它是「坏脚本不卡死 UI」这道保护的
 *   **唯一**覆盖，放宽等于把保护测没了。这也是当初没选「统一放宽断言」的原因。
 *
 * ── ⚠ 第四种变体：EPIPE 逃到顶层，**与超时无关，别再动超时值** ──
 *     · 2026-08-22 ubuntu（PR #96 的 main run）：`同指纹 + 窗口内 → 复用缓存`
 *     · 2026-08-24 macOS（PR #100）：`超出节流窗口 → 重新执行`
 *   两次栈里都是 `EPIPE: broken pipe, send`，形态
 *   `finish → finishMaybe → destroy → _destroy → end`（全在 `internal:streams/writable` 里）
 *   —— 是 `stdin.end()` 之后流在收尾阶段**异步**抛的，不是断言失败。
 *
 *   根因是 `child.stdin` 一个 `'error'` 监听器都没有，而无监听器的 `'error'`
 *   会升级成 `uncaughtException`；在 `bun test` 进程里那等于整个 job exit 1。
 *   **报红的用例不一定是出问题的那个** —— 异常来自上一个用例遗留的子进程收尾，
 *   恰好落在下一个用例执行期间，这就是两次报红是不同用例的原因。
 *
 *   ⚠ **不要把它当「再放宽一次超时」**：报红那条已经拿着 15s 宽超时，实际耗时 10.39ms，
 *   差三个数量级。动 `TEST_TIMEOUT_MS` 一点效果都没有，只会让下一个人误以为已修。
 *   修法与覆盖见本文件末尾三条用例 + `run-statusline.ts` 的 `attachPipeErrorHandlers`。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  runStatusLine,
  attachPipeErrorHandlers,
  clearStatusLineCache,
  STATUSLINE_THROTTLE_MS,
  STATUSLINE_TIMEOUT_MS,
  type StatusLineSessionData,
} from "@sid-code/cli/ui/statusline/run-statusline.ts";

/**
 * 测试用的宽超时（ms）。给到 15s —— 目标是「大到与 runner 负载无关」，
 * 不是「刚好够用」：调到 2s、3s 这种量级只是把撞线概率降低，没有消除它，
 * 而下一次复发依然是一次误导性的红（看着像功能坏了，其实是环境慢）。
 * 真的卡住 15s 由 bun test 自己的用例超时兜住。
 */
const TEST_TIMEOUT_MS = 15_000;

const DATA: StatusLineSessionData = {
  cwd: "/tmp/proj",
  gitBranch: "main",
  worktree: "",
  permissionMode: "default",
  model: "opus-4.8",
  inputTokens: 100,
  outputTokens: 50,
  contextPercent: 20,
  costUSD: 0.12,
  cacheHitRate: 80,
  effort: "high",
  thinking: true,
};

describe("runStatusLine", () => {
  beforeEach(() => clearStatusLineCache());

  test("无配置 / 非 command 类型 / 空命令 → null", async () => {
    // 这三条根本不 spawn（配置就被挡掉），超时值无关紧要，但仍显式传以保持一致
    expect(await runStatusLine(undefined, DATA, 1000, TEST_TIMEOUT_MS)).toBeNull();
    expect(
      await runStatusLine({ type: "command", command: "" }, DATA, 1000, TEST_TIMEOUT_MS),
    ).toBeNull();
    expect(
      await runStatusLine({ command: "echo hi" } as any, DATA, 1000, TEST_TIMEOUT_MS),
    ).toBeNull();
  });

  test("脚本 stdout 透传（去尾换行）", async () => {
    const out = await runStatusLine(
      { type: "command", command: "echo hello-bar" },
      DATA,
      1000,
      TEST_TIMEOUT_MS,
    );
    expect(out).toBe("hello-bar");
  });

  test("脚本能从 stdin 读到 JSON 会话数据", async () => {
    // 用 `cat` 原样回吐 stdin，解析放在测试侧做。
    //
    // 之前这里 spawn 了 `node -e "...JSON.parse..."`，注释写着「jq 可能不在所有环境；
    // 用 node 读 stdin 更稳」—— 比 jq 稳，但引入了更大的变量：node 冷启动。
    // 2026-08-13 实测在 ubuntu CI 上 fail，耗时 1002.91ms —— 精确撞线
    // （本机 macOS node 冷启动仅 20~30ms，不复现）。
    //
    // `cat` 是 coreutils，无运行时冷启动（实测 0ms），且断言比原来更强：
    // 验证的是整份 JSON 结构，不只是两个字段。**不要改回 spawn 运行时的写法。**
    // 注：换 `cat` 只治了这一条，根因（吃生产超时常量）由文件头那段 + 宽超时参数解决。
    const out = await runStatusLine(
      { type: "command", command: "cat" },
      DATA,
      1000,
      TEST_TIMEOUT_MS,
    );
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toEqual(DATA);
  });

  test("非零退出 → 回退 null", async () => {
    const out = await runStatusLine(
      { type: "command", command: "echo x; exit 3" },
      DATA,
      1000,
      TEST_TIMEOUT_MS,
    );
    expect(out).toBeNull();
  });

  test("超时 → 回退 null（用生产默认超时，刻意不放宽）", async () => {
    // ⚠ 这条**必须**走生产默认值 STATUSLINE_TIMEOUT_MS，不传 timeoutMs：
    // 它是「坏脚本不卡死 UI」这道保护的唯一覆盖，放宽就等于把保护测没了。
    // sleep 5 远超默认 1s（余量给足 4s，避免慢 runner 上 sleep 自身启动抖动
    // 让它变成另一个 flake），应被强杀回退 null。
    const out = await runStatusLine({ type: "command", command: "sleep 5; echo late" }, DATA, 1000);
    expect(out).toBeNull();
  }, 15_000);

  test("超时用的就是生产常量（防止有人给这条也塞宽超时）", () => {
    // 反向断言：上面那条的保护价值全靠「用默认值」。若默认值被调大到 UI 会卡顿的量级，
    // 或有人把它改成可配后顺手调宽，这里当场报红。
    expect(STATUSLINE_TIMEOUT_MS).toBe(1000);
    expect(STATUSLINE_TIMEOUT_MS).toBeLessThan(TEST_TIMEOUT_MS);
  });

  test("同指纹 + 窗口内 → 复用缓存（改命令输出也不重跑）", async () => {
    const first = await runStatusLine(
      { type: "command", command: "echo v1" },
      DATA,
      1000,
      TEST_TIMEOUT_MS,
    );
    expect(first).toBe("v1");
    // 窗口内（+100ms < 300ms）即使换命令，指纹变了才会重跑；这里指纹含 command，
    // 所以换命令指纹变、会重跑。用同一命令验证复用：
    const cached = await runStatusLine(
      { type: "command", command: "echo v1" },
      DATA,
      1000 + 100,
      TEST_TIMEOUT_MS,
    );
    expect(cached).toBe("v1");
  });

  test("超出节流窗口 → 重新执行", async () => {
    await runStatusLine({ type: "command", command: "echo a" }, DATA, 1000, TEST_TIMEOUT_MS);
    const after = await runStatusLine(
      { type: "command", command: "echo a" },
      DATA,
      1000 + STATUSLINE_THROTTLE_MS + 1,
      TEST_TIMEOUT_MS,
    );
    expect(after).toBe("a");
  });

  // ── stdin/stdout/stderr 的 'error' 监听：防 EPIPE 逃到顶层（2026-08-24，flake 第四种变体）──
  //
  // ⚠ 这三条与超时**无关**，别把它们当"再放宽一次超时"来处理（前三次 flake 是超时撞线，
  // 这次不是）。根因：`'error'` 事件没有监听器时会升级成 `uncaughtException`，
  // 在 bun test 进程里等于整个 job exit 1，且**报红的用例往往不是出问题的那个**
  // （异常来自上一个用例遗留的子进程收尾）。详见 run-statusline.ts 写 stdin 处的注释。

  test("attachPipeErrorHandlers 给三个管道都挂上 'error' 监听", () => {
    // 锁形态：监听器数量为 0 就是那个 flake 的成立条件。
    // 用真的 EventEmitter 计数，不是断言源码文本 —— 后者改个写法就骗过去了。
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    attachPipeErrorHandlers({ stdin, stdout, stderr }, () => {});
    expect(stdin.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(stdout.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(stderr.listenerCount("error")).toBeGreaterThanOrEqual(1);
  });

  test("写端 error 只丢弃、读端 error 才上报（两者刻意不同，别统一）", () => {
    // 这条锁的是「写端不 finish(null)」这个决定本身。若有人图省事把 stdin 也接到
    // onReadError 上，`echo a` 这类不读 stdin 的合法脚本就会无谓回退内置状态栏 —— 行为回退。
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const reported: string[] = [];
    attachPipeErrorHandlers({ stdin, stdout, stderr }, (which) => reported.push(which));

    const epipe = Object.assign(new Error("EPIPE: broken pipe, send"), { code: "EPIPE" });
    // 三次 emit 都不许抛：EventEmitter 在无监听器时会把 'error' 抛出来，
    // 所以「emit 不抛」本身就等价于「监听器确实挂上了」。
    expect(() => stdin.emit("error", epipe)).not.toThrow();
    expect(reported).toEqual([]); // 写端：静默丢弃
    expect(() => stdout.emit("error", epipe)).not.toThrow();
    expect(() => stderr.emit("error", epipe)).not.toThrow();
    expect(reported).toEqual(["stdout", "stderr"]); // 读端：上报，调用方回退内置
  });

  test("payload 大于管道缓冲 + 脚本不读 stdin → 既不逃逸，也仍然返回 stdout", async () => {
    // §5 验收判据 2 的后半句，防的是"把写端 EPIPE 当失败处理"这个行为回退：
    // `echo a` 不读 stdin 就退出是**完全合法**的用法，stdout 已经拿到了，
    // 结果必须是 "a" 而不是 null（null = 状态栏无谓回退内置）。
    //
    // 2MB 撑爆管道缓冲（64KB 量级）→ 断管必然发生，不靠 runner 负载的时序运气。
    // 实测：去掉 stdin 的 error 监听后，同样的 30 轮 30 次逃到顶层。
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const bigData: StatusLineSessionData = {
        ...DATA,
        cwd: "/tmp/" + "x".repeat(2 * 1024 * 1024),
      };
      const out = await runStatusLine(
        { type: "command", command: "echo a" },
        bigData,
        1000,
        TEST_TIMEOUT_MS,
      );
      expect(out).toBe("a");
      // 让流的 finish/destroy 收尾跑完（异步 error 就发生在这一段）。
      await new Promise((r) => setTimeout(r, 300));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  }, 20_000);

  test("clearStatusLineCache 清缓存后强制重跑", async () => {
    await runStatusLine({ type: "command", command: "echo z" }, DATA, 1000, TEST_TIMEOUT_MS);
    clearStatusLineCache();
    // 缓存已清，窗口内再调也会重跑（结果相同，验证不抛错即可）。
    const out = await runStatusLine(
      { type: "command", command: "echo z" },
      DATA,
      1000 + 10,
      TEST_TIMEOUT_MS,
    );
    expect(out).toBe("z");
  });
});
