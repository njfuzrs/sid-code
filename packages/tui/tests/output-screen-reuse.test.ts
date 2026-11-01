/**
 * 跨帧行复用（长会话按键延迟 PR3）。
 *
 * getScreen(reuse) 对「写到这一行的操作序列（对象身份 + 栈顶裁剪框）与上一帧逐项相同」的行，
 * 直接拷上一帧的单元，不再执行操作。这里锁三件事：
 * 1. 复用出来的屏幕与不复用时逐字节相同；
 * 2. 真复用了（统计里 reused > 0），不是退化成全量重写的恒绿；
 * 3. 一行里任何一个操作换了、平移了、裁剪框换了，这一行必须重写——判据写宽了这里会红。
 */
import { describe, expect, test } from "bun:test";
import Output, { type ScreenReuse, screenReuseStats } from "../src/output.ts";
import { serializeRow } from "../src/screen/index.ts";
import type { Screen } from "../src/screen/screen.ts";

type Op = Parameters<Output["replay"]>[0][number];

function rows(screen: Screen): string[] {
  return Array.from({ length: screen.height }, (_, y) => serializeRow(screen, y));
}

/** 用一组缓存好的操作（模拟 blit 缓存 replay，dy=0 推同一对象）出一帧 */
function frame(ops: readonly Op[], height: number, reuse?: ScreenReuse): Screen {
  const out = new Output({ width: 40, height });
  out.replay(ops, 0);
  return out.getScreen(reuse);
}

function record(build: (out: Output) => void, height: number): Op[] {
  const out = new Output({ width: 40, height });
  const mark = out.mark();
  build(out);
  return out.since(mark);
}

const history = record((out) => {
  out.write(0, 0, "\x1b[1m● read\x1b[22m a.ts\n第二行 宽字符\n", { transformers: [] });
  out.clip({ x1: 2, x2: 30, y1: undefined, y2: undefined });
  out.write(2, 2, "\x1b[38;2;1;2;3m标题行\x1b[39m 不裁", { transformers: [] });
  out.unclip();
  out.write(0, 3, "折行文本的第一段\n第二段", { transformers: [], softWraps: [true, false] });
}, 6);

describe("Output.getScreen 跨帧行复用", () => {
  test("同一组操作连出两帧：第二帧整屏复用，且与不复用时逐字节相同", () => {
    const reuse: ScreenReuse = {};
    frame(history, 6, reuse);
    const second = frame(history, 6, reuse);
    expect(screenReuseStats.reused).toBe(5);
    expect(screenReuseStats.written).toBe(0);
    expect(rows(second)).toEqual(rows(frame(history, 6)));
    // 软换行记录跟着行一起拷（选区复制依赖它）
    expect(second.wrapEnd[3]).toBeGreaterThanOrEqual(0);
    expect(Array.from(second.wrapEnd)).toEqual(Array.from(frame(history, 6).wrapEnd));
  });

  test("只改输入框那一行：其余行复用，被改的行重写成新内容", () => {
    const reuse: ScreenReuse = {};
    const input1 = record((out) => out.write(0, 5, "> ab", { transformers: [] }), 6);
    const input2 = record((out) => out.write(0, 5, "> abc", { transformers: [] }), 6);
    frame([...history, ...input1], 6, reuse);
    const next = frame([...history, ...input2], 6, reuse);
    expect(screenReuseStats.reused).toBe(5);
    expect(screenReuseStats.written).toBe(1);
    expect(rows(next)).toEqual(rows(frame([...history, ...input2], 6)));
    expect(serializeRow(next, 5)).toContain("abc");
  });

  test("同一行叠写的操作换了一个：整行重写，不残留上一帧被覆盖的字", () => {
    const reuse: ScreenReuse = {};
    const base = record((out) => out.write(0, 0, "AAAAAAAAAA", { transformers: [] }), 1);
    const top1 = record((out) => out.write(2, 0, "宽", { transformers: [] }), 1);
    const top2 = record((out) => out.write(3, 0, "x", { transformers: [] }), 1);
    frame([...base, ...top1], 1, reuse);
    const next = frame([...base, ...top2], 1, reuse);
    expect(screenReuseStats.reused).toBe(0);
    expect(rows(next)).toEqual(rows(frame([...base, ...top2], 1)));
  });

  test("操作纵向平移（replay dy≠0 产生新对象）：不按旧位置复用", () => {
    const reuse: ScreenReuse = {};
    frame(history, 7, reuse);
    const out = new Output({ width: 40, height: 7 });
    out.replay(history, 1);
    const shifted = out.getScreen(reuse);
    expect(screenReuseStats.reused).toBe(0);
    const fresh = new Output({ width: 40, height: 7 });
    fresh.replay(history, 1);
    expect(rows(shifted)).toEqual(rows(fresh.getScreen()));
  });

  test("同一写操作换了裁剪框：重写", () => {
    const reuse: ScreenReuse = {};
    const write = record((out) => out.write(0, 0, "abcdefghij", { transformers: [] }), 1)[0]!;
    const wide = { type: "clip", clip: { x1: 0, x2: 20, y1: undefined, y2: undefined } } as Op;
    const narrow = { type: "clip", clip: { x1: 0, x2: 4, y1: undefined, y2: undefined } } as Op;
    const unclip = { type: "unclip" } as Op;
    frame([wide, write, unclip], 1, reuse);
    const next = frame([narrow, write, unclip], 1, reuse);
    expect(screenReuseStats.reused).toBe(0);
    expect(serializeRow(next, 0)).not.toContain("e");
  });

  test("宽度变了：不复用", () => {
    const reuse: ScreenReuse = {};
    frame(history, 6, reuse);
    const out = new Output({ width: 30, height: 6 });
    out.replay(history, 0);
    out.getScreen(reuse);
    expect(screenReuseStats.reused).toBe(0);
  });
});
