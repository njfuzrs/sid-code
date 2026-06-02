/**
 * 快捷键和弦（Chord）状态机 — P1-2
 *
 * 支持 Ctrl+K → Ctrl+C 等两键序列快捷键。
 *
 * 设计要点:
 * - 纯逻辑,不直接依赖 React / setTimeout —— 超时由调用方通过 tick() 或外部计时器驱动,
 *   使其完全可单测(不引入时间依赖)。
 * - 对齐 KeypressContext 的真实 `Key` 接口(name/ctrl/shift/alt/cmd)。
 * - 状态转换:
 *     idle → 收到和弦前缀 → pending(等待第二个键)
 *     pending → 收到匹配键 → match,回到 idle
 *     pending → 收到不匹配键 → cancel(并 replay 该键),回到 idle
 *     pending → 超时(expire) → cancel,回到 idle
 */

import type { Key } from "../contexts/KeypressContext.ts";

/** 单个按键的匹配描述(只关心修饰键 + 名称) */
export interface Keystroke {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  cmd?: boolean;
}

/** 和弦绑定:一个按键序列对应一个动作 */
export interface ChordBinding {
  keys: Keystroke[];
  action: string;
  /** 可选上下文限制(由调用方解释) */
  context?: string;
}

export type ChordResult =
  | { type: "match"; action: string }
  | { type: "chord_started"; prefix: Keystroke }
  | { type: "cancel"; replayKey: Key }
  | { type: "none" };

/** 判断一次真实按键是否匹配某个 Keystroke 描述 */
export function keystrokeMatches(spec: Keystroke, key: Key): boolean {
  if (spec.name !== key.name) return false;
  // 修饰键:spec 未指定视为 false(必须精确匹配,避免 Ctrl+K 误匹配裸 K)
  if (!!spec.ctrl !== !!key.ctrl) return false;
  if (!!spec.shift !== !!key.shift) return false;
  if (!!spec.alt !== !!key.alt) return false;
  if (!!spec.cmd !== !!key.cmd) return false;
  return true;
}

/** 两个 Keystroke 描述是否等价(用于序列比较) */
export function keystrokeEquals(a: Keystroke, b: Keystroke): boolean {
  return (
    a.name === b.name &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt &&
    !!a.cmd === !!b.cmd
  );
}

/** 将真实 Key 归一化为 Keystroke(丢弃 sequence 等无关字段) */
export function toKeystroke(key: Key): Keystroke {
  return {
    name: key.name,
    ctrl: key.ctrl,
    shift: key.shift,
    alt: key.alt,
    cmd: key.cmd,
  };
}

export class ChordMachine {
  private bindings: ChordBinding[];
  private pending: { keys: Keystroke[]; pendingKey: Key } | null = null;

  constructor(bindings: ChordBinding[] = []) {
    this.bindings = bindings;
  }

  /** 当前是否处于等待第二个键的状态 */
  isPending(): boolean {
    return this.pending !== null;
  }

  setBindings(bindings: ChordBinding[]): void {
    this.bindings = bindings;
    this.pending = null;
  }

  /**
   * 处理一次按键,返回结果。
   * 调用方根据 result.type 决定是否消费事件:
   * - chord_started / match → 消费(return true)
   * - cancel → 不消费,replayKey 重新走正常分发
   * - none → 不消费
   */
  process(key: Key): ChordResult {
    const stroke = toKeystroke(key);

    if (this.pending) {
      const sequence = [...this.pending.keys, stroke];
      const match = this.findExactMatch(sequence);
      this.pending = null;

      if (match) {
        return { type: "match", action: match.action };
      }
      // 第二个键不匹配:取消和弦。该键需要被重新处理(replay)。
      return { type: "cancel", replayKey: key };
    }

    // 是否是某个长度 > 1 的和弦前缀
    const isPrefix = this.bindings.some(
      (b) => b.keys.length > 1 && keystrokeEquals(b.keys[0], stroke),
    );
    if (isPrefix) {
      this.pending = { keys: [stroke], pendingKey: key };
      return { type: "chord_started", prefix: stroke };
    }

    // 单键和弦直接命中
    const single = this.findExactMatch([stroke]);
    if (single) {
      return { type: "match", action: single.action };
    }

    return { type: "none" };
  }

  /**
   * 超时/外部取消。返回被挂起的原始按键(若有),
   * 供调用方决定是否 replay(通常超时后不 replay,直接丢弃前缀)。
   */
  expire(): { replayKey: Key } | null {
    if (!this.pending) return null;
    const replayKey = this.pending.pendingKey;
    this.pending = null;
    return { replayKey };
  }

  /** 强制重置到 idle(不返回任何键) */
  reset(): void {
    this.pending = null;
  }

  private findExactMatch(sequence: Keystroke[]): ChordBinding | undefined {
    return this.bindings.find(
      (b) =>
        b.keys.length === sequence.length &&
        b.keys.every((k, i) => keystrokeEquals(k, sequence[i])),
    );
  }
}

/** 默认和弦绑定示例(可扩展) */
export const defaultChordBindings: ChordBinding[] = [
  {
    keys: [
      { ctrl: true, name: "k" },
      { ctrl: true, name: "c" },
    ],
    action: "editor:copyLine",
  },
  {
    keys: [
      { ctrl: true, name: "k" },
      { ctrl: true, name: "u" },
    ],
    action: "editor:uppercase",
  },
];
