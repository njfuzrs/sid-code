// 端到端按键延迟探针：在 PTY 里起真实 TUI（可 -r 恢复长会话），逐键发送，
// 测「按键写入 PTY → 终端收到包含该字符的输出」与「→ 输出静默（帧写完）」两个延迟。
//
// 用法：
//   SID_CONFIG_DIR=/tmp/kl-home bun scripts/perf-keystroke-latency.ts [选项] -- <命令> [参数...]
//   选项：--keys N（默认 60）--gap MS（键间隔，默认 120）--cols C --rows R（默认 120x40）
//         --settle MS（启动后等输出静默多久才开始，默认 3000）--paste N（额外测一次 N 字符粘贴）
//         --label 名称（结果写 /tmp/perf-kl-<label>.json）
//         --prefix STR（测量前先输入，如 "@packages/" 测 @ 补全模式）
//         --prompt STR --stream-wait MS（先提交一轮、等 MS 毫秒后在流式进行中测；配 scripts/perf-mock-sse.ts）
//   例：bun scripts/perf-keystroke-latency.ts --label long -- ./sid-code -r 20261020-110542-ce7ea52e
//
// 口径：
//   echo_ms  = 写入第 k 个字符 → 收到一个「含该字符的同步输出帧（以 ESC[?2026l 结束）」的时间。
//              增量 diff 每键可能只写 1 个字符，所以不能按「末 N 个字符」匹配。超时记 5000。
//   quiet_ms = 写入 → 最后一个输出字节的时间（流式模式下不等静默，只看 echo_ms）
//   分母 = 发送的按键数；报告 p50/p95/p99/max。
//
// 坑：
//   - 配置有启动警告时，Notifications.tsx 的「按任意键关闭」会吞掉第一个键，所以测量前先发空格 + Ctrl+U 预热。
//   - 仓库根有项目级 skill，会弹信任框挡住输入：SID_CONFIG_DIR 要带上 state/trusted-extensions.json。
//   - 函数开销要用 sid-code-dev 二进制或 NODE_ENV=production，否则测到的是 React development 构建。
export {};
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep >= 0 ? argv.slice(0, sep) : argv;
const cmd = sep >= 0 ? argv.slice(sep + 1) : ["./sid-code"];
const opt = (k: string, d: number) => {
  const i = opts.indexOf(`--${k}`);
  return i >= 0 ? Number(opts[i + 1]) : d;
};
const label = (() => {
  const i = opts.indexOf("--label");
  return i >= 0 ? opts[i + 1] : "run";
})();
const KEYS = opt("keys", 60);
const GAP = opt("gap", 120);
const COLS = opt("cols", 120);
const ROWS = opt("rows", 40);
const SETTLE = opt("settle", 3000);
const PASTE = opt("paste", 0);
const QUIET = 30;
const sopt = (k: string) => {
  const i = opts.indexOf(`--${k}`);
  return i >= 0 ? opts[i + 1] : undefined;
};
// --prefix STR：测量前先输入的内容（如 "@" 测 @ 补全模式）
const PREFIX = sopt("prefix") ?? "";
// --prompt STR：先提交一轮对话，等 --stream-wait 毫秒（流式进行中）再开始测按键
const PROMPT = sopt("prompt");
const STREAM_WAIT = opt("stream-wait", 1500);

let lastData = performance.now();
let totalBytes = 0;
let waiter: { needle: string; t0: number; echo?: number; buf: string } | null = null;
const dec = new TextDecoder();

const proc = Bun.spawn(cmd, {
  env: { ...process.env, TERM: "xterm-256color", NODE_ENV: "production" },
  terminal: {
    cols: COLS,
    rows: ROWS,
    data(_t, d) {
      const now = performance.now();
      lastData = now;
      totalBytes += d.length;
      if (waiter && waiter.echo === undefined) {
        // 去掉 ANSI 序列再找字符，避免误命中转义序列内的字母
        // 增量 diff 每键可能只写一个字符，所以判据是「含该字符的同步输出帧结束（?2026l）」
        waiter.buf += dec.decode(d, { stream: true });
        const end = waiter.buf.lastIndexOf("\x1b[?2026l");
        if (end >= 0) {
          const plain = waiter.buf
            .slice(0, end)
            .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b./g, "");
          if (plain.includes(waiter.needle)) waiter.echo = now - waiter.t0;
        }
      }
    },
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitQuiet(ms: number, max = 60000) {
  const start = performance.now();
  while (performance.now() - lastData < ms && performance.now() - start < max) await sleep(5);
}

const tStart = performance.now();
await sleep(500);
await waitQuiet(SETTLE, 120000);
const startupMs = performance.now() - tStart - SETTLE;
// 预热键：启动警告「按任意键关闭」（Notifications.tsx）会吃掉第一个键；空格 + Ctrl+U 清掉它，
// 没有警告时空格进输入框也会被 Ctrl+U 清掉
proc.terminal!.write(" ");
await sleep(300);
proc.terminal!.write("\x15");
await sleep(300);
await waitQuiet(200);
const bytesAtReady = totalBytes;

if (PROMPT) {
  proc.terminal!.write(PROMPT);
  await sleep(300);
  proc.terminal!.write("\r");
  await sleep(STREAM_WAIT);
}
if (PREFIX) {
  proc.terminal!.write(PREFIX);
  await sleep(500);
  await waitQuiet(100);
}
// 用不常见的字符做探针，避免与已有画面内容撞车：轮流发 z/q/x 并在一个唯一前缀后累积
const echo: number[] = [];
const quiet: number[] = [];
const seq = "zqxjkvw";
let typed = "";
for (let k = 0; k < KEYS; k++) {
  const ch = seq[k % seq.length];
  typed += ch;
  const needle = ch;
  waiter = { needle, t0: performance.now(), buf: "" };
  proc.terminal!.write(ch);
  const t0 = waiter.t0;
  while (waiter.echo === undefined && performance.now() - t0 < 5000) await sleep(1);
  if (!PROMPT) await waitQuiet(QUIET);
  echo.push(waiter.echo ?? 5000);
  quiet.push(Math.max(0, lastData - t0));
  waiter = null;
  await sleep(GAP);
}

let pasteRes: any = null;
if (PASTE > 0) {
  // 先清空输入框（Ctrl+U），再发 bracketed paste（低于占位阈值 800 字符时整段进输入框）
  proc.terminal!.write("\x15");
  await sleep(300);
  await waitQuiet(QUIET);
  const body = Array.from({ length: PASTE }, (_, i) => "abcdefghij"[i % 10]).join("");
  const tail = "PQZEND";
  waiter = { needle: "", t0: performance.now(), buf: "" };
  proc.terminal!.write(`\x1b[200~${body}${tail}\x1b[201~`);
  const t0 = waiter.t0;
  while (waiter.echo === undefined && performance.now() - t0 < 10000) await sleep(1);
  await waitQuiet(QUIET);
  pasteRes = { chars: PASTE + tail.length, echo_ms: waiter.echo ?? null, quiet_ms: lastData - t0 };
  waiter = null;
  // 粘贴后再打 20 个键，看每键是否变成 O(全文)
  const after: number[] = [];
  for (let k = 0; k < 20; k++) {
    const ch = "y";
    waiter = { needle: "y", t0: performance.now(), buf: "" };
    proc.terminal!.write(ch);
    const t1 = waiter.t0;
    while (waiter.echo === undefined && performance.now() - t1 < 5000) await sleep(1);
    await waitQuiet(QUIET);
    after.push(waiter.echo ?? 5000);
    waiter = null;
    await sleep(GAP);
  }
  pasteRes.after_paste_echo = summary(after);
}

function pct(a: number[], p: number) {
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
}
function summary(a: number[]) {
  return { n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: pct(a, 1) };
}
const res = {
  label,
  cmd: cmd.join(" "),
  cols: COLS,
  rows: ROWS,
  startupMs: Math.round(startupMs),
  bytesAtReady,
  echo_ms: summary(echo),
  quiet_ms: summary(quiet),
  paste: pasteRes,
};
console.log(JSON.stringify(res, null, 2));
await Bun.write(
  `/tmp/perf-kl-${label}.json`,
  JSON.stringify({ ...res, raw: { echo, quiet } }, null, 2),
);
proc.terminal!.write("\x03");
await sleep(200);
proc.terminal!.write("\x03");
await sleep(500);
proc.kill();
process.exit(0);
