import { describe, expect, test } from "bun:test";
import {
  ChordMachine,
  keystrokeMatches,
  keystrokeEquals,
  toKeystroke,
  defaultChordBindings,
  type ChordBinding,
} from "../../src/ui/keybindings/chord.ts";
import type { Key } from "../../src/ui/contexts/KeypressContext.ts";

/** 构造真实 Key 的测试工具 */
function key(partial: Partial<Key> & { name: string }): Key {
  return {
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: false,
    sequence: "",
    ...partial,
  };
}

const ctrlK = key({ name: "k", ctrl: true });
const ctrlC = key({ name: "c", ctrl: true });
const ctrlU = key({ name: "u", ctrl: true });
const plainA = key({ name: "a", insertable: true });

describe("keystrokeMatches", () => {
  test("名称与修饰键完全一致才匹配", () => {
    expect(keystrokeMatches({ ctrl: true, name: "k" }, ctrlK)).toBe(true);
  });

  test("修饰键不一致不匹配:Ctrl+K 的 spec 不匹配裸 K", () => {
    expect(keystrokeMatches({ ctrl: true, name: "k" }, key({ name: "k" }))).toBe(
      false,
    );
  });

  test("名称不一致不匹配", () => {
    expect(keystrokeMatches({ ctrl: true, name: "k" }, ctrlC)).toBe(false);
  });

  test("spec 未指定的修饰键视为 false", () => {
    // spec 只要 name=a,但传入带 ctrl 的 a → 不匹配
    expect(keystrokeMatches({ name: "a" }, key({ name: "a", ctrl: true }))).toBe(
      false,
    );
    expect(keystrokeMatches({ name: "a" }, plainA)).toBe(true);
  });
});

describe("keystrokeEquals / toKeystroke", () => {
  test("toKeystroke 丢弃 sequence/insertable", () => {
    expect(toKeystroke(ctrlK)).toEqual({
      name: "k",
      ctrl: true,
      shift: false,
      alt: false,
      cmd: false,
    });
  });

  test("keystrokeEquals 比较归一化", () => {
    expect(
      keystrokeEquals({ ctrl: true, name: "k" }, { ctrl: true, name: "k" }),
    ).toBe(true);
    expect(
      keystrokeEquals({ ctrl: true, name: "k" }, { name: "k" }),
    ).toBe(false);
  });
});

describe("ChordMachine 两键和弦", () => {
  test("完整 Ctrl+K → Ctrl+C 触发动作", () => {
    const m = new ChordMachine(defaultChordBindings);

    const r1 = m.process(ctrlK);
    expect(r1.type).toBe("chord_started");
    expect(m.isPending()).toBe(true);

    const r2 = m.process(ctrlC);
    expect(r2).toEqual({ type: "match", action: "editor:copyLine" });
    expect(m.isPending()).toBe(false);
  });

  test("第二个键不匹配 → cancel 并 replay 该键", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(ctrlK);
    const r = m.process(plainA);
    expect(r.type).toBe("cancel");
    if (r.type === "cancel") {
      expect(r.replayKey).toBe(plainA);
    }
    expect(m.isPending()).toBe(false);
  });

  test("同一前缀的不同后缀走不同动作", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(ctrlK);
    expect(m.process(ctrlU)).toEqual({
      type: "match",
      action: "editor:uppercase",
    });
  });

  test("非前缀、非单键 → none", () => {
    const m = new ChordMachine(defaultChordBindings);
    const r = m.process(plainA);
    expect(r.type).toBe("none");
    expect(m.isPending()).toBe(false);
  });
});

describe("ChordMachine 单键和弦", () => {
  test("单键绑定直接命中,不进入 pending", () => {
    const bindings: ChordBinding[] = [
      { keys: [{ ctrl: true, name: "p" }], action: "palette:open" },
    ];
    const m = new ChordMachine(bindings);
    const r = m.process(key({ name: "p", ctrl: true }));
    expect(r).toEqual({ type: "match", action: "palette:open" });
    expect(m.isPending()).toBe(false);
  });

  test("前缀键同时也是某单键绑定时,优先作为前缀进入 pending", () => {
    // Ctrl+K 既是 [Ctrl+K, Ctrl+C] 的前缀,也单独绑定了动作
    const bindings: ChordBinding[] = [
      { keys: [{ ctrl: true, name: "k" }], action: "single:k" },
      {
        keys: [
          { ctrl: true, name: "k" },
          { ctrl: true, name: "c" },
        ],
        action: "chord:kc",
      },
    ];
    const m = new ChordMachine(bindings);
    const r1 = m.process(ctrlK);
    expect(r1.type).toBe("chord_started");
    // 后续不匹配 → cancel,调用方可按需触发 single
    expect(m.process(plainA).type).toBe("cancel");
  });
});

describe("ChordMachine 超时与重置", () => {
  test("expire 返回挂起的原始键并回到 idle", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(ctrlK);
    expect(m.isPending()).toBe(true);
    const expired = m.expire();
    expect(expired?.replayKey).toBe(ctrlK);
    expect(m.isPending()).toBe(false);
  });

  test("无 pending 时 expire 返回 null", () => {
    const m = new ChordMachine(defaultChordBindings);
    expect(m.expire()).toBeNull();
  });

  test("reset 清空 pending", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(ctrlK);
    m.reset();
    expect(m.isPending()).toBe(false);
  });

  test("setBindings 会重置 pending 状态", () => {
    const m = new ChordMachine(defaultChordBindings);
    m.process(ctrlK);
    m.setBindings([]);
    expect(m.isPending()).toBe(false);
  });
});
