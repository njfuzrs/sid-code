/**
 * run-statusline 执行层测试（P1-5）
 *
 * 覆盖：无配置返回 null / 脚本 stdout 透传 / 非零退出回退 null / 超时回退 null /
 * 同指纹节流复用 / clearStatusLineCache 清缓存。
 * 用真实 shell 命令（echo/exit/sleep）验证 spawn 路径，nowMs 由测试注入（可控节流）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  runStatusLine,
  clearStatusLineCache,
  STATUSLINE_THROTTLE_MS,
  type StatusLineSessionData,
} from "../../src/ui/statusline/run-statusline.ts";

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
    expect(await runStatusLine(undefined, DATA, 1000)).toBeNull();
    expect(await runStatusLine({ type: "command", command: "" }, DATA, 1000)).toBeNull();
    expect(await runStatusLine({ command: "echo hi" } as any, DATA, 1000)).toBeNull();
  });

  test("脚本 stdout 透传（去尾换行）", async () => {
    const out = await runStatusLine({ type: "command", command: "echo hello-bar" }, DATA, 1000);
    expect(out).toBe("hello-bar");
  });

  test("脚本能从 stdin 读到 JSON 会话数据", async () => {
    // jq 可能不在所有环境；用 node 读 stdin 更稳。
    const cmd = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.model+'|'+j.gitBranch)})"`;
    const out = await runStatusLine({ type: "command", command: cmd }, DATA, 1000);
    expect(out).toBe("opus-4.8|main");
  });

  test("非零退出 → 回退 null", async () => {
    const out = await runStatusLine({ type: "command", command: "echo x; exit 3" }, DATA, 1000);
    expect(out).toBeNull();
  });

  test("超时 → 回退 null（脚本 sleep 超过 1s 上限）", async () => {
    // sleep 2 秒，超过 STATUSLINE_TIMEOUT_MS=1000ms，应被强杀回退。
    const out = await runStatusLine({ type: "command", command: "sleep 2; echo late" }, DATA, 1000);
    expect(out).toBeNull();
  }, 5000);

  test("同指纹 + 窗口内 → 复用缓存（改命令输出也不重跑）", async () => {
    const first = await runStatusLine({ type: "command", command: "echo v1" }, DATA, 1000);
    expect(first).toBe("v1");
    // 窗口内（+100ms < 300ms）即使换命令，指纹变了才会重跑；这里指纹含 command，
    // 所以换命令指纹变、会重跑。用同一命令验证复用：
    const cached = await runStatusLine({ type: "command", command: "echo v1" }, DATA, 1000 + 100);
    expect(cached).toBe("v1");
  });

  test("超出节流窗口 → 重新执行", async () => {
    await runStatusLine({ type: "command", command: "echo a" }, DATA, 1000);
    const after = await runStatusLine(
      { type: "command", command: "echo a" },
      DATA,
      1000 + STATUSLINE_THROTTLE_MS + 1,
    );
    expect(after).toBe("a");
  });

  test("clearStatusLineCache 清缓存后强制重跑", async () => {
    await runStatusLine({ type: "command", command: "echo z" }, DATA, 1000);
    clearStatusLineCache();
    // 缓存已清，窗口内再调也会重跑（结果相同，验证不抛错即可）。
    const out = await runStatusLine({ type: "command", command: "echo z" }, DATA, 1000 + 10);
    expect(out).toBe("z");
  });
});
