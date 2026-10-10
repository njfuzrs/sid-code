/**
 * 选区向量的驱动（B9 / T6.2a）：在旧底座上跑 `selection-corpus.tsx` 的每条用例，
 * 记下 `copySelectionNoClear()` 与 xterm 无头终端里的高亮单元。不 import 任何底座，
 * 由 `scripts/tui-selection-vectors.ts` 把端口的 legacy 实现注入进来（同 input-drive.tsx）。
 */
import type React from "react";
import type { SelectionCase } from "./selection-corpus.tsx";

/** 高亮色：只有被选中的单元是这个背景，xterm 里按它认出高亮 */
const SELECTION_BG = 0xff0000;

/**
 * `blindRows`：量不了高亮的行。@xterm/headless 只带 Unicode 6 宽度表，把 emoji 当 1 列，
 * 同一行里之后的高亮位置全错；这些行的高亮段不进 `cells`，测试比对时同样跳过这些行。
 */
export type SelectionVector = { text: string; cells: string[]; blindRows?: number[] };

/** Unicode 6 与终端实际宽度不一致的字符（emoji 及其修饰 / 连接符） */
const XTERM_WIDTH_BLIND = /\p{Extended_Pictographic}/u;

type Deps = {
  React: typeof React;
  useInput: (handler: () => void) => void;
  ttyStreams: (opts: { columns: number; rows: number }) => any;
  mountTTY: (node: React.ReactNode, streams: any) => any;
  tick: (ms?: number) => Promise<unknown>;
  Terminal: new (opts: object) => any;
  rows: number;
};

/** xterm 最终屏幕上红底的连续段，形如 `y:x0-x1:文字` */
async function highlightCells(
  deps: Deps,
  out: string,
  cols: number,
): Promise<{ cells: string[]; blindRows: number[] }> {
  const term = new deps.Terminal({ cols, rows: deps.rows, allowProposedApi: true });
  await new Promise<void>((r) => term.write(out, r));
  const buffer = term.buffer.active;
  const spans: string[] = [];
  const blindRows: number[] = [];
  for (let y = 0; y < deps.rows; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (XTERM_WIDTH_BLIND.test(line.translateToString())) {
      blindRows.push(y);
      continue;
    }

    let text = "";
    let start = -1;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      const on = cell.isBgRGB() && cell.getBgColor() === SELECTION_BG;
      if (on) {
        if (start < 0) start = x;
        text += cell.getChars() || (cell.getWidth() === 0 ? "" : " ");
      } else if (start >= 0) {
        spans.push(`${y}:${start}-${x - 1}:${text}`);
        text = "";
        start = -1;
      }
    }

    if (start >= 0) spans.push(`${y}:${start}-${cols - 1}:${text}`);
  }

  term.dispose();
  return { cells: spans, blindRows };
}

export async function driveSelection(
  deps: Deps,
  cases: SelectionCase[],
): Promise<Record<string, SelectionVector>> {
  const { React: R, useInput } = deps;
  // 挂一个 useInput：没人读 stdin 时旧底座不开 raw mode，鼠标字节也就不进选区
  function Keys({ children }: { children: React.ReactNode }) {
    useInput(() => {});
    return R.createElement(R.Fragment, null, children);
  }

  const out: Record<string, SelectionVector> = {};
  for (const c of cases) {
    const streams = deps.ttyStreams({ columns: c.cols, rows: deps.rows });
    const mounted = deps.mountTTY(R.createElement(Keys, null, c.node), streams);
    await deps.tick();
    mounted.ink.setAltScreenActive(true, false);
    mounted.ink.setSelectionBgColor("#ff0000");
    // 连击计数在进程里跨挂载保留：空过 MULTI_CLICK_MS，上一条的点击才不会连到这一条
    await deps.tick(700);
    for (const step of c.seq) {
      if (typeof step === "number") await deps.tick(step);
      else streams.stdin.write(step);
    }

    await deps.tick();
    const text = mounted.ink.copySelectionNoClear();
    const { cells, blindRows } = await highlightCells(deps, streams.out(), c.cols);
    mounted.teardown();
    out[c.name] = blindRows.length > 0 ? { text, cells, blindRows } : { text, cells };
  }

  return out;
}
