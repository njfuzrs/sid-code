/**
 * 差分测试台：跑一个场景 → 字节流 → xterm 无头终端 → 每步快照 + 指标（B9 / T0.4）。
 *
 * 设计文档 §3 L3。比的不是字节（两套底座的光标策略、SGR 合并必然不同），而是
 * 终端最终呈现：可视区网格（字符 + 颜色 + 属性）、scrollback、光标、终端模式。
 *
 * 子进程跑场景（理由见 runner.tsx 文件头），字节写进临时文件，跑完后按 OSC 7777
 * 步骤标记切段喂 xterm。xterm 对查询序列（DA1 等）的回复不回灌给子进程 ——
 * 首批场景不依赖回复；I2/I3 的分片回复由场景自己注入 stdin。
 */
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";

const { Terminal } = xterm as unknown as { Terminal: typeof import("@xterm/headless").Terminal };

const RUNNER = join(import.meta.dir, "runner.tsx");

export interface CellRun {
  /** 连续同样式单元的文本 */
  text: string;
  /** 样式签名：fg/bg/粗/斜/下划/反色/暗/删除线；默认样式为空串 */
  style: string;
}

export interface Snapshot {
  label: string;
  /** 可视区每行：同样式单元合并成 run（便于人读，也便于逐格比较） */
  grid: CellRun[][];
  /** 可视区纯文本（去尾空格） */
  screen: string[];
  /** 当前 buffer（normal / alternate）里可视区之上的行 */
  scrollback: string[];
  buffer: "normal" | "alternate";
  cursor: { x: number; y: number; hidden: boolean };
  modes: {
    bracketedPaste: boolean;
    mouseTracking: string;
    sendFocus: boolean;
    wraparound: boolean;
  };
  /** 本步内的字节指标 */
  metrics: StepMetrics;
}

export interface StepMetrics {
  bytes: number;
  /** `ESC[2J`（擦整屏）次数 —— full reset 的指纹 */
  eraseScreen: number;
  /** `ESC[3J`（清 scrollback）次数 */
  eraseScrollback: number;
  syncBegin: number;
  syncEnd: number;
  /** 进 / 出 alt-screen（`?1049h` / `?1049l`） */
  altEnter: number;
  altExit: number;
  /** OSC 序列按编号计数（0/2 标题、8 链接、9 进度、52 剪贴板、21337 tab 状态…），不含测试台自己的 7777 */
  osc: Record<string, number>;
}

export interface BenchResult {
  scenario: string;
  steps: Snapshot[];
  notes: Record<string, string>;
  /** 整个场景（含卸载）的字节指标 */
  total: StepMetrics;
  /** 原始字节（调试用，不进快照） */
  raw: string;
  exitCode: number;
  error?: string;
  /** 帧耗时（ms），来自 onFrame。不确定量，不进 summarize / 基线快照 */
  perf: { frames: number[] };
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

export function metricsOf(bytes: string): StepMetrics {
  return {
    bytes: Buffer.byteLength(bytes),
    eraseScreen: count(bytes, "\x1b[2J"),
    eraseScrollback: count(bytes, "\x1b[3J"),
    syncBegin: count(bytes, "\x1b[?2026h"),
    syncEnd: count(bytes, "\x1b[?2026l"),
    altEnter: count(bytes, "\x1b[?1049h"),
    altExit: count(bytes, "\x1b[?1049l"),
    osc: oscCounts(bytes),
  };
}

function oscCounts(bytes: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of bytes.matchAll(/\x1b\](\d+);/g)) {
    if (m[1] === "7777") continue;
    out[m[1]!] = (out[m[1]!] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => Number(a) - Number(b)));
}

type Term = InstanceType<typeof Terminal>;
type Cell = NonNullable<
  ReturnType<NonNullable<ReturnType<Term["buffer"]["active"]["getLine"]>>["getCell"]>
>;

function cellStyle(c: Cell): string {
  const color = (mode: "Fg" | "Bg") => {
    const isDefault = mode === "Fg" ? c.isFgDefault() : c.isBgDefault();
    if (isDefault) return "";
    const v = mode === "Fg" ? c.getFgColor() : c.getBgColor();
    const rgb = mode === "Fg" ? c.isFgRGB() : c.isBgRGB();
    return `${mode.toLowerCase()}=${rgb ? "#" + v.toString(16).padStart(6, "0") : v}`;
  };
  const flags = [
    c.isBold() ? "b" : "",
    c.isItalic() ? "i" : "",
    c.isUnderline() ? "u" : "",
    c.isInverse() ? "r" : "",
    c.isDim() ? "d" : "",
    c.isStrikethrough() ? "s" : "",
  ].join("");
  return [color("Fg"), color("Bg"), flags].filter(Boolean).join(" ");
}

function snapshot(term: Term, label: string, metrics: StepMetrics): Snapshot {
  const buf = term.buffer.active;
  const grid: CellRun[][] = [];
  const screen: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const runs: CellRun[] = [];
    if (line) {
      for (let x = 0; x < term.cols; x++) {
        const c = line.getCell(x);
        if (!c || c.getWidth() === 0) continue; // 宽字符的第二格（spacer）
        const ch = c.getChars() || " ";
        const style = cellStyle(c);
        const last = runs[runs.length - 1];
        if (last && last.style === style) last.text += ch;
        else runs.push({ text: ch, style });
      }
    }
    // 去掉行尾默认样式的空白 run，让快照稳定
    while (
      runs.length &&
      runs[runs.length - 1]!.style === "" &&
      runs[runs.length - 1]!.text.trim() === ""
    ) {
      runs.pop();
    }
    const tail = runs[runs.length - 1];
    if (tail && tail.style === "") tail.text = tail.text.replace(/\s+$/, "");
    grid.push(runs);
    screen.push(line ? line.translateToString(true) : "");
  }
  const scrollback: string[] = [];
  for (let y = 0; y < buf.baseY; y++)
    scrollback.push(buf.getLine(y)?.translateToString(true) ?? "");

  const core = (term as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core;
  const m = term.modes;
  return {
    label,
    grid,
    screen,
    scrollback,
    buffer: buf.type,
    cursor: { x: buf.cursorX, y: buf.cursorY, hidden: core.coreService.isCursorHidden },
    modes: {
      bracketedPaste: m.bracketedPasteMode,
      mouseTracking: m.mouseTrackingMode,
      sendFocus: m.sendFocusMode,
      wraparound: m.wraparoundMode,
    },
    metrics,
  };
}

const MARKER = /\x1b\]7777;([^\x07]*)\x07/g;
/** 最后一张快照：最后一个标记之后（含进程退出）的终端状态 */
export const EXIT_LABEL = "(退出后)";

export interface RunOptions {
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export async function runScenario(name: string, opts: RunOptions = {}): Promise<BenchResult> {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const dir = mkdtempSync(join(tmpdir(), "term-bench-"));
  const outPath = join(dir, "out.bin");
  const fd = openSync(outPath, "w");
  let exitCode: number;
  try {
    const proc = Bun.spawn(["bun", RUNNER, name], {
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        // 终端识别类变量清零，避免宿主终端（iTerm2 / tmux / VS Code）改变底座行为
        TERM: "xterm-256color",
        TERM_PROGRAM: "",
        TMUX: "",
        KITTY_WINDOW_ID: "",
        WT_SESSION: "",
        VTE_VERSION: "",
        LC_TERMINAL: "",
        SSH_CONNECTION: "",
        NODE_ENV: "test",
        ...opts.env,
        BENCH_COLS: String(cols),
        BENCH_ROWS: String(rows),
      },
    });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 20_000);
    exitCode = await proc.exited;
    clearTimeout(timer);
  } finally {
    closeSync(fd);
  }
  const raw = readFileSync(outPath, "utf8");
  rmSync(dir, { recursive: true, force: true });

  const term = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
  const write = (s: string) => new Promise<void>((r) => term.write(s, r));

  const steps: Snapshot[] = [];
  const notes: Record<string, string> = {};
  let perf: BenchResult["perf"] = { frames: [] };
  let error: string | undefined;
  let segStart = 0;
  // 自上一个 step 标记以来的字节（本步的指标口径）
  let stepBytes = "";

  // 场景约定：先把状态推到位、settle，再调 step(label) —— 所以在标记处立即拍快照，
  // 快照内容 = 该标记之前的全部字节写进终端后的样子，指标 = 上一标记到此的字节。
  for (const m of raw.matchAll(MARKER)) {
    const seg = raw.slice(segStart, m.index!);
    await write(seg);
    stepBytes += seg;
    segStart = m.index! + m[0].length;
    const body = m[1]!;
    if (body.startsWith("step=")) {
      steps.push(snapshot(term, body.slice(5), metricsOf(stepBytes)));
      stepBytes = "";
    } else if (body.startsWith("resize=")) {
      // 子进程改尺寸之前的字节已写完，此刻同步调整假终端，与真实终端的时序一致
      const [c, r] = body.slice(7).split("x").map(Number) as [number, number];
      term.resize(c, r);
    } else if (body.startsWith("note=")) {
      const [k, ...v] = body.slice(5).split("=");
      notes[k!] = decodeURIComponent(v.join("="));
    } else if (body.startsWith("perf=")) {
      perf = JSON.parse(decodeURIComponent(body.slice(5)));
    } else if (body.startsWith("error=")) {
      error = decodeURIComponent(body.slice(6));
    }
  }
  // 最后一个标记之后：卸载 / 退出时的 writeSync（契约 X3）都在这里
  const tail = raw.slice(segStart);
  await write(tail);
  steps.push(snapshot(term, EXIT_LABEL, metricsOf(stepBytes + tail)));

  // 底座错误面板（组件抛错时渲染的 ERROR 框）出现 = 场景没在测它以为在测的东西
  if (!error) {
    const crashed = steps.find((st) => st.screen.some((l) => /^\s*ERROR\s/.test(l)));
    if (crashed)
      error = `场景渲染出底座错误面板（步骤「${crashed.label}」）：\n${crashed.screen.filter(Boolean).slice(0, 4).join("\n")}`;
  }

  return {
    scenario: name,
    steps,
    notes,
    total: metricsOf(raw.replace(MARKER, "")),
    raw,
    exitCode,
    error,
    perf,
  };
}

/** 快照的人读形态：去掉 grid（太长），保留文本、模式、光标与指标。基线文件用它。 */
export function summarize(r: BenchResult) {
  return {
    scenario: r.scenario,
    exitCode: r.exitCode,
    total: r.total,
    notes: r.notes,
    steps: r.steps.map((s) => ({
      label: s.label,
      buffer: s.buffer,
      cursor: s.cursor,
      modes: s.modes,
      metrics: s.metrics,
      screen: trimTrailingEmpty(s.screen),
      scrollback: s.scrollback,
      styled: s.grid
        .map((runs, y) => ({ y, runs: runs.filter((r) => r.style !== "") }))
        .filter((l) => l.runs.length > 0),
    })),
  };
}

function trimTrailingEmpty(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** 帧耗时分位数（基线报告用，不做门禁：机器负载会让它抖） */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/**
 * 差分判定（设计文档 §3 L3 第 6 条）：`actual` 对 `baseline`。
 * - 网格（含样式）/ scrollback / 光标 / 终端模式 / buffer 类型 / 步骤序列 / notes：逐项一致；
 * - full reset（`2J`）次数与写入字节数：不得高于基线的 1.1 倍（向上取整，至少允许相等）；
 * - 同步输出：开始与结束必须成对。
 * 返回差异描述列表，空 = 通过。`allow` 是白名单（契约 ID → 理由），T0.4 时为空。
 */
export function compareToBaseline(
  actual: ReturnType<typeof summarize>,
  baseline: ReturnType<typeof summarize>,
): string[] {
  const diffs: string[] = [];
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const cap = (n: number) => Math.max(n, Math.ceil(n * 1.1));
  if (actual.exitCode !== baseline.exitCode)
    diffs.push(`退出码 ${actual.exitCode} ≠ 基线 ${baseline.exitCode}`);
  if (!eq(actual.notes, baseline.notes))
    diffs.push(`notes ${JSON.stringify(actual.notes)} ≠ 基线 ${JSON.stringify(baseline.notes)}`);
  const labels = actual.steps.map((s) => s.label);
  if (
    !eq(
      labels,
      baseline.steps.map((s) => s.label),
    )
  ) {
    diffs.push(`步骤序列不同：${JSON.stringify(labels)}`);
    return diffs;
  }
  actual.steps.forEach((a, i) => {
    const b = baseline.steps[i]!;
    const at = `「${a.label}」`;
    for (const k of ["buffer", "cursor", "modes", "screen", "scrollback", "styled"] as const) {
      if (!eq(a[k], b[k]))
        diffs.push(
          `${at} ${k} 不同\n  实际：${JSON.stringify(a[k])}\n  基线：${JSON.stringify(b[k])}`,
        );
    }
    if (a.metrics.eraseScreen > cap(b.metrics.eraseScreen)) {
      diffs.push(
        `${at} full reset（2J）${a.metrics.eraseScreen} 次 > 基线 ${b.metrics.eraseScreen} 的 1.1 倍`,
      );
    }
    if (a.metrics.bytes > cap(b.metrics.bytes)) {
      diffs.push(`${at} 写入 ${a.metrics.bytes} 字节 > 基线 ${b.metrics.bytes} 的 1.1 倍`);
    }
    if (a.metrics.syncBegin !== a.metrics.syncEnd) {
      diffs.push(
        `${at} 同步输出不成对（?2026h ${a.metrics.syncBegin} / ?2026l ${a.metrics.syncEnd}）`,
      );
    }
    if (!eq(a.metrics.osc, b.metrics.osc)) {
      diffs.push(
        `${at} OSC 序列计数 ${JSON.stringify(a.metrics.osc)} ≠ 基线 ${JSON.stringify(b.metrics.osc)}`,
      );
    }
  });
  return diffs;
}
