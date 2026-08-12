/**
 * Vim 引擎主分发（P2-2）
 *
 * reduceVimEngine(buffer, state, key) → { buffer, state, consumed }
 *
 * 职责：把一个按键在当前 {mode, pending} 下求值，可能：
 *   - 切模式（i/a/o/Esc/v/V）
 *   - 移动光标（motion）
 *   - 积攒 count / operator / g 前缀 / f 待收字符 / text-object 待决
 *   - 执行 operator+motion / operator+textobject 组合
 *   - 粘贴/缩进/join/大小写翻转等独立命令
 *
 * insert 模式基本透明（仅拦 Esc）；normal/visual 全面接管可打印键。
 */

import {
  type VimBuffer,
  type VimEngineState,
  type VimKey,
  type VimStepResult,
  resetPending,
} from "./types.ts";
import * as M from "./motions.ts";
import type { Pos } from "./motions.ts";
import * as Op from "./operators.ts";
import { resolveTextObject } from "./text-objects.ts";

/** 取键对应的可打印字符（含 shift 大写）。 */
function keyChar(key: VimKey): string {
  if (key.name && key.name.length === 1) {
    return key.shift && /[a-z]/.test(key.name) ? key.name.toUpperCase() : key.name;
  }
  if (key.sequence && key.sequence.length === 1) return key.sequence;
  return "";
}

/** normal 下方向键/退格也当移动，name → motion。 */
function namedMotion(name: string): "left" | "right" | "up" | "down" | null {
  if (name === "left" || name === "backspace") return "left";
  if (name === "right") return "right";
  if (name === "up") return "up";
  if (name === "down") return "down";
  return null;
}

/** motion 是否 inclusive（终点字符也纳入 operator 范围）。 */
const INCLUSIVE_MOTIONS = new Set(["e", "f", "t", "$"]);

/** 计算一个 motion 键的目标位置（不含 operator）。返回 null 表示该键不是 motion。 */
function evalMotion(buf: VimBuffer, char: string, count: number): Pos | null {
  switch (char) {
    case "h":
      return M.motionLeft(buf, count);
    case "l":
    case " ":
      return M.motionRight(buf, count);
    case "j":
      return M.motionDown(buf, count);
    case "k":
      return M.motionUp(buf, count);
    case "0":
      return M.motionLineStart(buf);
    case "$":
      return M.motionLineEnd(buf, count);
    case "^":
      return M.motionFirstNonBlank(buf);
    case "w":
    case "W":
      return M.motionWordForward(buf, count);
    case "b":
    case "B":
      return M.motionWordBackward(buf, count);
    case "e":
    case "E":
      return M.motionWordEnd(buf, count);
    case "G":
      return M.motionBufferEnd(buf, count > 1 ? count : null);
    default:
      return null;
  }
}

export function reduceVimEngine(
  buffer: VimBuffer,
  state: VimEngineState,
  key: VimKey,
): VimStepResult {
  const { mode, pending } = state;

  // ── insert 模式：仅拦 Esc 回 normal（并按 vim 语义把光标左移一格）。 ──
  if (mode === "insert") {
    if (key.name === "escape") {
      const line = buffer.lines[buffer.cursorRow] ?? "";
      const col = Math.max(0, Math.min(buffer.cursorCol - 1, Math.max(0, line.length - 1)));
      return {
        buffer: { ...buffer, cursorCol: col },
        state: { mode: "normal", pending: resetPending(pending), visualAnchor: null },
        consumed: true,
      };
    }
    return { buffer, state, consumed: false };
  }

  const char = keyChar(key);
  const stay = (buf: VimBuffer, extra?: Partial<VimEngineState>): VimStepResult => ({
    buffer: buf,
    state: { mode, pending: resetPending(pending), visualAnchor: state.visualAnchor, ...extra },
    consumed: true,
  });

  // ── 待决：f/F/t/T 等目标字符 ──
  if (pending.findPending) {
    if (!char) return stay(buffer); // 非字符键取消
    const count = pending.count ? parseInt(pending.count, 10) : 1;
    const kind = pending.findPending;
    const pos = M.motionFind(buffer, kind, char, count);
    const newPending = { ...resetPending(pending), lastFind: { kind, char } };
    // operator + find（如 dfx）：pending.operator 若存在则执行删除到该位置（inclusive）
    if (pending.operator) {
      return applyOperatorMotion(buffer, pending.operator, pos, true, newPending);
    }
    return {
      buffer: { ...buffer, cursorRow: pos.row, cursorCol: pos.col },
      state: { mode, pending: newPending, visualAnchor: state.visualAnchor },
      consumed: true,
    };
  }

  // ── 待决：text object（i/a 之后的对象键）──
  if (pending.textObjectPending) {
    if (!char) return stay(buffer);
    const span = resolveTextObject(buffer, pending.textObjectPending, char);
    if (!span || !pending.operator) return stay(buffer);
    const res = pending.operator === "y" ? Op.yankSpan(buffer, span) : Op.deleteSpan(buffer, span);
    const newPending = {
      ...resetPending(pending),
      register: res.yanked ?? "",
      registerLinewise: false,
    };
    // c = 删后进 insert
    const nextMode = pending.operator === "c" ? "insert" : "normal";
    return {
      buffer: res.buffer,
      state: { mode: nextMode, pending: newPending, visualAnchor: null },
      consumed: true,
    };
  }

  // ── 待决：g 前缀 ──
  if (pending.gPrefix) {
    if (char === "g") {
      const count = pending.count ? parseInt(pending.count, 10) : 0;
      const pos = M.motionBufferStart(buffer, count > 0 ? count : null);
      if (pending.operator)
        return applyOperatorMotion(buffer, pending.operator, pos, false, resetPending(pending));
      return {
        buffer: { ...buffer, cursorRow: pos.row, cursorCol: pos.col },
        state: { mode, pending: resetPending(pending), visualAnchor: state.visualAnchor },
        consumed: true,
      };
    }
    return stay(buffer);
  }

  // ── count 前缀累积（非首位 0）──
  if (/[0-9]/.test(char) && !(char === "0" && pending.count === "")) {
    return {
      buffer,
      state: {
        mode,
        pending: { ...pending, count: pending.count + char },
        visualAnchor: state.visualAnchor,
      },
      consumed: true,
    };
  }

  const count = pending.count ? Math.max(1, parseInt(pending.count, 10)) : 1;

  // ── 已有 operator 待决：第二键是 motion / 重复 operator / text-object 引子 ──
  if (pending.operator) {
    const opChar = pending.operator;
    // >> / <<：缩进/反缩进 count 行（在 linewise 判断之前处理，避免落到 dd 分支）。
    if ((opChar === ">" || opChar === "<") && (char === ">" || char === "<")) {
      const buf2 = Op.indentLines(buffer, count, opChar === ">");
      return {
        buffer: buf2,
        state: { mode: "normal", pending: resetPending(pending), visualAnchor: null },
        consumed: true,
      };
    }
    // 重复 operator（dd/yy/cc）→ 整行
    if (
      char === opChar ||
      (opChar === "d" && char === "d") ||
      (opChar === "y" && char === "y") ||
      (opChar === "c" && char === "c")
    ) {
      return applyLinewiseOperator(buffer, state, opChar, count);
    }
    // text object 引子
    if (char === "i" || char === "a") {
      return {
        buffer,
        state: {
          mode,
          pending: { ...pending, textObjectPending: char as "i" | "a" },
          visualAnchor: state.visualAnchor,
        },
        consumed: true,
      };
    }
    // 字符查找引子
    if (char === "f" || char === "F" || char === "t" || char === "T") {
      return {
        buffer,
        state: {
          mode,
          pending: { ...pending, findPending: char as "f" },
          visualAnchor: state.visualAnchor,
        },
        consumed: true,
      };
    }
    // g 引子
    if (char === "g") {
      return {
        buffer,
        state: { mode, pending: { ...pending, gPrefix: true }, visualAnchor: state.visualAnchor },
        consumed: true,
      };
    }
    // 普通 motion
    const pos = evalMotion(buffer, char, count);
    if (pos) {
      const inclusive = INCLUSIVE_MOTIONS.has(char);
      return applyOperatorMotion(buffer, opChar, pos, inclusive, resetPending(pending));
    }
    // 未识别：取消 operator
    return stay(buffer);
  }

  // ── visual / visual-line 模式 ──
  if (mode === "visual" || mode === "visual-line") {
    return reduceVisual(buffer, state, key, char, count);
  }

  // ── normal 模式首键 ──
  return reduceNormalFirst(buffer, state, key, char, count);
}

/** operator + motion 目标 → 执行（d/c/y）。 */
function applyOperatorMotion(
  buffer: VimBuffer,
  opChar: string,
  target: Pos,
  inclusive: boolean,
  newPending: VimEngineState["pending"],
): VimStepResult {
  let res: Op.OpResult;
  if (opChar === "y") res = Op.yankRange(buffer, target, inclusive);
  else res = Op.deleteRange(buffer, target, inclusive); // d 和 c 都先删
  const register = res.yanked ?? "";
  const nextMode = opChar === "c" ? "insert" : "normal";
  return {
    buffer: res.buffer,
    state: {
      mode: nextMode,
      pending: { ...newPending, register, registerLinewise: false },
      visualAnchor: null,
    },
    consumed: true,
  };
}

/** 整行 operator（dd/yy/cc）。 */
function applyLinewiseOperator(
  buffer: VimBuffer,
  state: VimEngineState,
  opChar: string,
  count: number,
): VimStepResult {
  const { pending } = state;
  if (opChar === "y") {
    const res = Op.yankLines(buffer, count);
    return {
      buffer: res.buffer,
      state: {
        mode: "normal",
        pending: { ...resetPending(pending), register: res.yanked ?? "", registerLinewise: true },
        visualAnchor: null,
      },
      consumed: true,
    };
  }
  if (opChar === "c") {
    // cc：清空当前行内容但保留行，进 insert
    const lines = [...buffer.lines];
    const captured = lines[buffer.cursorRow] ?? "";
    lines[buffer.cursorRow] = "";
    return {
      buffer: { lines, cursorRow: buffer.cursorRow, cursorCol: 0 },
      state: {
        mode: "insert",
        pending: { ...resetPending(pending), register: captured, registerLinewise: true },
        visualAnchor: null,
      },
      consumed: true,
    };
  }
  // dd
  const res = Op.deleteLines(buffer, count);
  return {
    buffer: res.buffer,
    state: {
      mode: "normal",
      pending: { ...resetPending(pending), register: res.yanked ?? "", registerLinewise: true },
      visualAnchor: null,
    },
    consumed: true,
  };
}

/** normal 模式首键分发。 */
function reduceNormalFirst(
  buffer: VimBuffer,
  state: VimEngineState,
  key: VimKey,
  char: string,
  count: number,
): VimStepResult {
  const { pending } = state;
  const toNormal = (buf: VimBuffer, extra?: Partial<VimEngineState["pending"]>): VimStepResult => ({
    buffer: buf,
    state: { mode: "normal", pending: { ...resetPending(pending), ...extra }, visualAnchor: null },
    consumed: true,
  });
  const toInsert = (buf: VimBuffer): VimStepResult => ({
    buffer: buf,
    state: { mode: "insert", pending: resetPending(pending), visualAnchor: null },
    consumed: true,
  });

  // 方向键
  const nm = namedMotion(key.name);
  if (nm) {
    const pos = evalMotion(
      buffer,
      nm === "left" ? "h" : nm === "right" ? "l" : nm === "up" ? "k" : "j",
      count,
    )!;
    return toNormal({ ...buffer, cursorRow: pos.row, cursorCol: pos.col });
  }

  // 进 insert 家族
  switch (char) {
    case "i":
      return toInsert(buffer);
    case "a": {
      const line = buffer.lines[buffer.cursorRow] ?? "";
      return toInsert({ ...buffer, cursorCol: Math.min(line.length, buffer.cursorCol + 1) });
    }
    case "I": {
      const pos = M.motionFirstNonBlank(buffer);
      return toInsert({ ...buffer, cursorCol: pos.col });
    }
    case "A": {
      const line = buffer.lines[buffer.cursorRow] ?? "";
      return toInsert({ ...buffer, cursorCol: line.length });
    }
    case "o": {
      const lines = [...buffer.lines];
      lines.splice(buffer.cursorRow + 1, 0, "");
      return toInsert({ lines, cursorRow: buffer.cursorRow + 1, cursorCol: 0 });
    }
    case "O": {
      const lines = [...buffer.lines];
      lines.splice(buffer.cursorRow, 0, "");
      return toInsert({ lines, cursorRow: buffer.cursorRow, cursorCol: 0 });
    }
  }

  // 进 visual
  if (char === "v")
    return {
      buffer,
      state: {
        mode: "visual",
        pending: resetPending(pending),
        visualAnchor: { row: buffer.cursorRow, col: buffer.cursorCol },
      },
      consumed: true,
    };
  if (char === "V")
    return {
      buffer,
      state: {
        mode: "visual-line",
        pending: resetPending(pending),
        visualAnchor: { row: buffer.cursorRow, col: buffer.cursorCol },
      },
      consumed: true,
    };

  // operator 引子
  if (char === "d" || char === "c" || char === "y" || char === ">" || char === "<") {
    // >> << 是双击同键（在 operator 待决里处理），这里先进待决
    return {
      buffer,
      state: {
        mode: "normal",
        pending: { ...resetPending(pending), operator: char, count: pending.count },
        visualAnchor: null,
      },
      consumed: true,
    };
  }

  // g 引子
  if (char === "g")
    return {
      buffer,
      state: {
        mode: "normal",
        pending: { ...resetPending(pending), gPrefix: true, count: pending.count },
        visualAnchor: null,
      },
      consumed: true,
    };

  // 字符查找引子
  if (char === "f" || char === "F" || char === "t" || char === "T") {
    return {
      buffer,
      state: {
        mode: "normal",
        pending: { ...resetPending(pending), findPending: char as "f", count: pending.count },
        visualAnchor: null,
      },
      consumed: true,
    };
  }
  // ; , 重复查找
  if ((char === ";" || char === ",") && pending.lastFind) {
    const lf = pending.lastFind;
    let kind = lf.kind;
    if (char === ",") {
      // 反向
      kind = kind === "f" ? "F" : kind === "F" ? "f" : kind === "t" ? "T" : "t";
    }
    const pos = M.motionFind(buffer, kind, lf.char, count);
    return toNormal({ ...buffer, cursorRow: pos.row, cursorCol: pos.col });
  }

  // 独立编辑命令
  switch (char) {
    case "x": {
      const res = Op.deleteChars(buffer, count);
      return toNormal(res.buffer, { register: res.yanked ?? "", registerLinewise: false });
    }
    case "D": {
      const res = Op.deleteToLineEnd(buffer);
      return toNormal(res.buffer, { register: res.yanked ?? "", registerLinewise: false });
    }
    case "C": {
      const res = Op.deleteToLineEnd(buffer);
      return {
        buffer: res.buffer,
        state: {
          mode: "insert",
          pending: { ...resetPending(pending), register: res.yanked ?? "" },
          visualAnchor: null,
        },
        consumed: true,
      };
    }
    case "Y": {
      const res = Op.yankLines(buffer, count);
      return toNormal(res.buffer, { register: res.yanked ?? "", registerLinewise: true });
    }
    case "s": {
      const res = Op.deleteChars(buffer, count);
      return {
        buffer: res.buffer,
        state: {
          mode: "insert",
          pending: { ...resetPending(pending), register: res.yanked ?? "" },
          visualAnchor: null,
        },
        consumed: true,
      };
    }
    case "p":
      return toNormal(Op.paste(buffer, pending.register, pending.registerLinewise, true));
    case "P":
      return toNormal(Op.paste(buffer, pending.register, pending.registerLinewise, false));
    case "J":
      return toNormal(Op.joinLines(buffer, count));
    case "~":
      return toNormal(Op.toggleCase(buffer, count));
    case "r":
      // r 替换：等下一个字符（用 findPending 复用一个待决槽不合适，这里简化为不支持多字符，直接吞）
      return {
        buffer,
        state: {
          mode: "normal",
          pending: { ...resetPending(pending), textObjectPending: null },
          visualAnchor: null,
        },
        consumed: true,
      };
  }

  // 普通 motion（h/l/j/k/w/b/e/0/$/^/G）
  const pos = evalMotion(buffer, char, count);
  if (pos) return toNormal({ ...buffer, cursorRow: pos.row, cursorCol: pos.col });

  // normal 下未识别可打印键：吞掉（不污染文本）。控制键放行给 InputArea。
  if (char) return toNormal(buffer);
  return {
    buffer,
    state: { mode: "normal", pending: resetPending(pending), visualAnchor: null },
    consumed: false,
  };
}

/** visual / visual-line 模式分发。 */
function reduceVisual(
  buffer: VimBuffer,
  state: VimEngineState,
  key: VimKey,
  char: string,
  count: number,
): VimStepResult {
  const { mode, pending } = state;
  const anchor = state.visualAnchor ?? { row: buffer.cursorRow, col: buffer.cursorCol };
  const lineMode = mode === "visual-line";

  // Esc 退出 visual
  if (key.name === "escape") {
    return {
      buffer,
      state: { mode: "normal", pending: resetPending(pending), visualAnchor: null },
      consumed: true,
    };
  }

  // 移动：更新光标（选择随光标扩展）
  const nm = namedMotion(key.name);
  const motionChar = nm
    ? nm === "left"
      ? "h"
      : nm === "right"
        ? "l"
        : nm === "up"
          ? "k"
          : "j"
    : char;
  const pos = evalMotion(buffer, motionChar, count);
  if (pos && "hjkl0$^wbeG".includes(motionChar)) {
    return { buffer: { ...buffer, cursorRow: pos.row, cursorCol: pos.col }, state, consumed: true };
  }

  // 计算选择区间
  const from = { row: anchor.row, col: anchor.col };
  const to = { row: buffer.cursorRow, col: buffer.cursorCol };
  const [a, b] =
    from.row < to.row || (from.row === to.row && from.col <= to.col) ? [from, to] : [to, from];

  const backToNormal = (
    buf: VimBuffer,
    reg: string,
    linewise: boolean,
    insert = false,
  ): VimStepResult => ({
    buffer: buf,
    state: {
      mode: insert ? "insert" : "normal",
      pending: { ...resetPending(pending), register: reg, registerLinewise: linewise },
      visualAnchor: null,
    },
    consumed: true,
  });

  // 对选区执行 d/y/c/x
  if (char === "d" || char === "x" || char === "y" || char === "c") {
    if (lineMode) {
      const lines = [...buffer.lines];
      const captured = lines.slice(a.row, b.row + 1).join("\n");
      if (char === "y")
        return backToNormal({ ...buffer, cursorRow: a.row, cursorCol: 0 }, captured, true);
      lines.splice(a.row, b.row - a.row + 1);
      const finalLines = lines.length ? lines : [""];
      if (char === "c") {
        finalLines.splice(a.row, 0, "");
        return backToNormal(
          { lines: finalLines, cursorRow: a.row, cursorCol: 0 },
          captured,
          true,
          true,
        );
      }
      const row = Math.min(a.row, finalLines.length - 1);
      return backToNormal({ lines: finalLines, cursorRow: row, cursorCol: 0 }, captured, true);
    }
    // 字符级选区（inclusive）
    const target: Pos = { row: b.row, col: b.col };
    const src: VimBuffer = { ...buffer, cursorRow: a.row, cursorCol: a.col };
    if (char === "y") {
      const res = Op.yankRange(src, target, true);
      return backToNormal(res.buffer, res.yanked ?? "", false);
    }
    const res = Op.deleteRange(src, target, true);
    return backToNormal(res.buffer, res.yanked ?? "", false, char === "c");
  }

  // > < 缩进选区
  if (char === ">" || char === "<") {
    const buf2 = Op.indentLines({ ...buffer, cursorRow: a.row }, b.row - a.row + 1, char === ">");
    return {
      buffer: buf2,
      state: { mode: "normal", pending: resetPending(pending), visualAnchor: null },
      consumed: true,
    };
  }

  // visual 下其它键：吞掉
  return { buffer, state, consumed: true };
}
