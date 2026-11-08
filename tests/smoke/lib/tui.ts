/**
 * G4 TUI e2e 的 PTY 驱动：在真 TTY 里起 sid-code 交互模式，按剧本送按键、等屏幕。
 *
 * 设计取舍（专项总纲 §3.5，2026-11-08 构建产物探针跑通后定稿）：
 * - 驱动用 `Bun.spawn({ terminal })`（Bun 1.4.2 原生 PTY），不引 node-pty；屏幕用 `@xterm/headless`
 *   把字节流还原成网格，断言「人看到的文字」而不是字节——字节级基线归 term-bench，两层不重叠。
 * - **禁止固定 sleep 同步**：每一步都是「等屏幕出现某文本，超时报错」。唯一的例外是 `pause`，
 *   只用于时间本身就是被测对象的场景（Esc 双击的两击间隔要像人手，见 use-rewind-escape.ts）。
 * - 屏幕匹配只看**视口**（不含 scrollback），并去掉全部空白：主屏按列宽硬折行，
 *   一段中文可能被拆在两行，按原文匹配会因为折行位置假失败。
 * - 出现「按任意键关闭」立即判失败：启动警告会吞掉下一个按键（Notifications.tsx 的按键语义），
 *   表现是剧本卡在下一步等到超时。提前报出真实原因，而不是 20s 后报「等不到 xxx」
 *   （main-screen-shrink-e2e.test.ts 在 macOS CI 上 8 次失败全是这个形态）。
 */
import xterm from "@xterm/headless";
import type { TuiStep } from "./types.ts";

const { Terminal } = xterm as unknown as { Terminal: typeof import("@xterm/headless").Terminal };

export const TUI_COLS = 100;
export const TUI_ROWS = 30;
const DEFAULT_WAIT_MS = 20_000;
const STARTUP_WARNING = "按任意键关闭";

/** 按键名 → 写进 PTY 的字节。回车是 `\r`：TUI 进 raw 模式后收到的就是 0x0d */
export const KEYS = {
  enter: "\r",
  esc: "\x1b",
  "ctrl-c": "\x03",
  up: "\x1b[A",
  down: "\x1b[B",
  tab: "\t",
} as const;

export type KeyName = keyof typeof KEYS;

/** 去掉全部空白：屏幕折行、行尾填充、全角字符后的占位都不影响匹配 */
export function compact(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * 屏幕是否「出现」了目标。字符串按去空白后的子串比；正则按原文比（调用方自己处理折行）。
 */
export function screenHas(screen: string, target: string | RegExp): boolean {
  return typeof target === "string"
    ? compact(screen).includes(compact(target))
    : target.test(screen);
}

export function describeTarget(t: string | RegExp): string {
  return typeof t === "string" ? JSON.stringify(t) : String(t);
}

export interface TuiRunResult {
  exitCode: number;
  /** 最后一帧视口文本（失败信息与 `expect.output` 用） */
  screen: string;
  /** 剧本失败原因；null = 剧本走完且进程按时退出 */
  failure: string | null;
}

/**
 * 起进程、走剧本、退出。剧本走完后统一用「Ctrl+C → 等二次确认提示 → Ctrl+C」退出，
 * 退出本身也是被守的行为（L4-B：Ctrl+C 退出不挂），10s 内不退判失败。
 */
export async function driveTui(
  argv: string[],
  opts: { cwd: string; env: Record<string, string>; steps: TuiStep[]; timeoutMs: number },
): Promise<TuiRunResult> {
  const term = new Terminal({ cols: TUI_COLS, rows: TUI_ROWS, allowProposedApi: true });
  const viewport = () => {
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < TUI_ROWS; i++) {
      lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  };
  // xterm 的 write 是异步解析的：等它把已收字节吃完再读屏，否则读到的是上一帧
  let pending = Promise.resolve();
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    terminal: {
      cols: TUI_COLS,
      rows: TUI_ROWS,
      data(_t, d) {
        const chunk = new Uint8Array(d);
        pending = pending.then(() => new Promise<void>((r) => term.write(chunk, r)));
      },
    },
  });
  let exited = false;
  let exitCode = -1;
  void proc.exited.then((c) => {
    exited = true;
    exitCode = c;
  });
  const hardKill = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
  const send = (s: string) => proc.terminal!.write(s);
  const settledScreen = async () => {
    await pending;
    return viewport();
  };

  /** 等屏幕出现 target；返回失败描述或 null */
  const waitFor = async (target: string | RegExp, ms: number, label: string) => {
    const t0 = Date.now();
    for (;;) {
      const s = await settledScreen();
      if (s.includes(STARTUP_WARNING)) {
        return `「${label}」时出现启动警告「${STARTUP_WARNING}」：它会吞掉下一个按键。检查用例 settings 是否引用了不存在的模型`;
      }
      if (screenHas(s, target)) return null;
      if (exited)
        return `「${label}」时进程已退出（exit=${exitCode}），屏幕上没有 ${describeTarget(target)}`;
      if (Date.now() - t0 > ms)
        return `「${label}」${ms}ms 内屏幕没有出现 ${describeTarget(target)}`;
      await Bun.sleep(50);
    }
  };

  let failure: string | null = null;
  try {
    for (const [i, step] of opts.steps.entries()) {
      const label = `第 ${i + 1} 步 ${step.kind}`;
      if (step.kind === "type") {
        send(step.text);
        // 打完字先确认输入框收到了，再交给下一步（通常是回车）：否则回车可能早于最后几个字符
        failure = await waitFor(step.text, DEFAULT_WAIT_MS, `${label}（回显）`);
      } else if (step.kind === "key") {
        send(KEYS[step.key]);
      } else if (step.kind === "pause") {
        await Bun.sleep(step.ms);
      } else {
        failure = await waitFor(
          step.screen,
          step.timeoutMs ?? DEFAULT_WAIT_MS,
          step.label ?? label,
        );
      }
      if (failure) break;
    }
    if (!failure && !exited) {
      send(KEYS["ctrl-c"]);
      const hint = await waitFor("再按一次 Ctrl+C 退出", 5_000, "退出（第一次 Ctrl+C）");
      if (hint) failure = hint;
      else {
        send(KEYS["ctrl-c"]);
        const t0 = Date.now();
        while (!exited && Date.now() - t0 < 10_000) await Bun.sleep(50);
        if (!exited) failure = "两次 Ctrl+C 后 10s 内进程没有退出（退出挂起）";
      }
    }
  } finally {
    clearTimeout(hardKill);
    if (!exited) proc.kill("SIGKILL");
    await proc.exited;
  }
  const screen = await settledScreen();
  term.dispose();
  return {
    exitCode,
    screen,
    failure: failure
      ? `${failure}\n---- 最后一帧 ----\n${screen.trimEnd()}\n------------------`
      : null,
  };
}
