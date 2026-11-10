/**
 * G4 PTY 驱动（lib/tui.ts）自身的时序契约。
 *
 * smoke-lib.test.ts 只测纯函数、不起子进程；这里要起 PTY，所以单独一个文件。被驱动的不是
 * sid-code，而是下面几十行的假 TUI：它按 TUI 的「快速回车」判据（`bufferFastReturn`）判回车是
 * 提交还是换行，并且故意把「处理文字」拖慢——2026-11-09 macOS CI 上 A1-dialog 红的就是这种时序。
 * 用假 TUI 而不是真二进制：真二进制里这段时序取决于 runner 快慢，复现不稳定；这里是确定的。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TYPE_SETTLE_MS, driveTui } from "./lib/tui.ts";

const KEYPRESS_SRC = join(
  import.meta.dir,
  "../../packages/cli/src/ui/contexts/KeypressContext.tsx",
);

/** 读 TUI 源码里的快速回车窗口。读不到就抛错：常量改名后这里要跟着改，不能静默按 0 算 */
function fastReturnTimeout(): number {
  const m = readFileSync(KEYPRESS_SRC, "utf8").match(/export const FAST_RETURN_TIMEOUT = (\d+);/);
  if (!m) throw new Error("KeypressContext.tsx 里找不到 FAST_RETURN_TIMEOUT，常量改名了？");
  return Number(m[1]);
}

/**
 * 假 TUI：raw 模式读键。文字到达后先忙等 TEXT_DELAY_MS 再记时间、回显（事件循环被拖慢）；
 * 回车距上次处理文字不超过 FAST_RETURN_TIMEOUT 记 NEWLINE，否则记 SUBMIT；
 * Ctrl+C 两次退出，配合运行器统一的退出协议。
 */
const FAKE_TUI = String.raw`
const fast = Number(process.env.FAST_RETURN_TIMEOUT);
const delay = Number(process.env.TEXT_DELAY_MS);
let last = 0;
let ctrlC = 0;
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  if (d === "\x03") {
    if (++ctrlC === 1) process.stdout.write("再按一次 Ctrl+C 退出\r\n");
    else process.exit(0);
    return;
  }
  if (d === "\r") {
    const gap = Date.now() - last;
    process.stdout.write((gap > fast ? "SUBMIT" : "NEWLINE") + " gap=" + gap + "\r\n");
    return;
  }
  const t = Date.now();
  while (Date.now() - t < delay) {}
  last = Date.now();
  process.stdout.write(d + "\r\n");
});
process.stdout.write("READY\r\n");
`;

describe("driveTui：type 之后的回车不落进 TUI 的快速回车窗口", () => {
  test("TYPE_SETTLE_MS 至少是 FAST_RETURN_TIMEOUT 的两倍", () => {
    const fast = fastReturnTimeout();
    expect(fast).toBeGreaterThan(0);
    expect(TYPE_SETTLE_MS).toBeGreaterThanOrEqual(2 * fast);
  });

  // TUI 处理文字晚了 40ms：回显出现时离运行器下一次 50ms 轮询只剩约 10ms。看到回显立刻发回车的话，
  // 两次处理的间隔约 10ms，落进 30ms 窗口，回车被当成换行，这一轮不提交。
  test("TUI 处理文字被拖慢时，回车仍按提交处理", async () => {
    const r = await driveTui([process.execPath, "-e", FAKE_TUI], {
      cwd: tmpdir(),
      env: {
        ...(process.env as Record<string, string>),
        FAST_RETURN_TIMEOUT: String(fastReturnTimeout()),
        TEXT_DELAY_MS: "40",
      },
      steps: [
        { kind: "wait", screen: "READY" },
        { kind: "type", text: "hello" },
        { kind: "key", key: "enter" },
        { kind: "wait", screen: /SUBMIT|NEWLINE/, timeoutMs: 5_000 },
      ],
      timeoutMs: 20_000,
    });
    expect(r.screen).toMatch(/SUBMIT gap=\d+/);
    expect(r.failure).toBeNull();
  }, 30_000);
});
