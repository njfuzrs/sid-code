/**
 * T8.1b 夹具（契约 P1）：假 TTY 里只经端口挂一个带 useInput 的最小 App，数静置窗口内定时器回调触发了几次，
 * 按创建处的首个非本文件调用帧归因，打印 `IDLE {"<kind> <归因>": 次数}`。
 *
 * 为什么自己包定时器：bun 1.4.2 的 `process.getActiveResourcesInfo()` 有活跃 setInterval 时也返回 `[]`（实测），
 * 拿它判「没有空转定时器」是瞎的仪器。包装必须在加载端口之前装上。
 * `IDLE_ALT=1` 包一层 AlternateScreen；`IDLE_RO=1` 用 ResizeObserver 观察根盒（P1 的已知例外）。
 */
const counts = new Map<string, number>();
let counting = false;

function origin(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(3);
  const frame = frames.find((l) => !l.includes("idle-timers-app.tsx")) ?? "?";
  // 只留文件名：两套底座的路径前缀不同，测试按文件名断言
  return /([\w.-]+\.tsx?):\d+/.exec(frame)?.[1] ?? "?";
}

function wrap<T>(kind: string, real: T): T {
  return ((cb: (...a: unknown[]) => void, ...rest: unknown[]) => {
    const key = `${kind} ${origin()}`;
    return (real as (...a: unknown[]) => unknown)(
      (...args: unknown[]) => {
        if (counting) counts.set(key, (counts.get(key) ?? 0) + 1);
        cb(...args);
      },
      ...rest,
    );
  }) as T;
}

// 夹具自己的计时用包装前的原函数，不进统计
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = wrap("timeout", globalThis.setTimeout);
globalThis.setInterval = wrap("interval", globalThis.setInterval);
globalThis.setImmediate = wrap("immediate", globalThis.setImmediate);

const React = (await import("react")).default;
const { Box, Text, AlternateScreen } = await import("@sid-code/cli/ui/render-port/components.ts");
const { useInput } = await import("@sid-code/cli/ui/render-port/hooks.ts");
const { ResizeObserver } = await import("@sid-code/cli/ui/render-port/measure.ts");
const { mountTTY, ttyStreams } = await import("../tty-streams.ts");

function App() {
  useInput(() => {});
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (process.env.IDLE_RO !== "1" || !ref.current) return;
    const ro = new ResizeObserver(() => {});
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return (
    <Box ref={ref} borderStyle="round">
      <Text>idle</Text>
    </Box>
  );
}

const sleep = (ms: number) => new Promise((r) => realTimeout(r, ms));
const s = ttyStreams({ columns: 40, rows: 10 });
const m = mountTTY(
  process.env.IDLE_ALT === "1" ? (
    <AlternateScreen>
      <App />
    </AlternateScreen>
  ) : (
    <App />
  ),
  s,
);
// 挂载后的探查（setImmediate）、首帧、ESC 冲刷都在这 500ms 里结束
await sleep(500);
counting = true;
await sleep(1000);
counting = false;
console.log(`IDLE ${JSON.stringify(Object.fromEntries(counts))}`);
m.teardown();
process.exit(0);
