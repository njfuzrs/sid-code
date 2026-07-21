/**
 * Vim 引擎类型定义（P2-2）
 *
 * 设计：纯函数引擎，输入 {当前缓冲 + 模式态 + 一个按键} → 输出 {新缓冲 + 新模式态 + 是否消费}。
 * 不碰 React / text-buffer 实例——InputArea 拿到新缓冲后用 tb.vimSetBuffer 原子写回。
 *
 * 与旧的 coarse-ops state-machine 的区别：旧设计产出抽象 op 列表交给 InputArea 翻译，
 * 无法表达 operator+motion 组合、text object、count 前缀。本引擎直接在缓冲模型上求值，
 * y/d/c/p、iw/aw/i"、f/F/t/T、count 全部可实现。
 */

/** 缓冲模型：多行 + 光标（逻辑行号 + 行内 code point 列）。纯数据。 */
export interface VimBuffer {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

/** vim 主模式。visual/visual-line 为可视选择模式。 */
export type VimMode = "normal" | "insert" | "visual" | "visual-line";

/**
 * 待决状态：正在积攒一个多键命令（operator / g 前缀 / f 待收字符 / count）。
 * 单一事实源，reducer 每次要么消费完成、要么继续积攒、要么放弃复位。
 */
export interface VimPending {
  /** 已按下的 operator（d/c/y/>/< 等），等待 motion 或 text-object 补全。null=无。 */
  operator: string | null;
  /** g 前缀（gg）等待第二键。 */
  gPrefix: boolean;
  /** 字符查找待决：等待 f/F/t/T 的目标字符。null=无。 */
  findPending: "f" | "F" | "t" | "T" | null;
  /** text object 待决：已按下 i/a，等待对象类型键（w/"/( 等）。null=无。 */
  textObjectPending: "i" | "a" | null;
  /** 数字 count 前缀累积（字符串，空=无）。作用于 motion/operator 的重复次数。 */
  count: string;
  /** 寄存器：最近一次 y/d/c/x 暂存的文本（供 p/P 粘贴）。 */
  register: string;
  /** 寄存器是否为整行内容（yy/dd）——影响 p/P 的粘贴方式（整行则粘到新行）。 */
  registerLinewise: boolean;
  /** 上次字符查找（供 ; 重复、, 反向重复）。 */
  lastFind: { kind: "f" | "F" | "t" | "T"; char: string } | null;
}

/** 完整 vim 运行态。 */
export interface VimEngineState {
  mode: VimMode;
  pending: VimPending;
  /** visual 模式锚点（选择起点）。非 visual 模式为 null。 */
  visualAnchor: { row: number; col: number } | null;
}

/** 引擎对外的按键信号（从 KeypressContext.Key 精简）。 */
export interface VimKey {
  name: string;
  sequence: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** 引擎单步求值结果。 */
export interface VimStepResult {
  buffer: VimBuffer;
  state: VimEngineState;
  /** 是否消费该键（true=引擎已处理，InputArea 不再走普通分发）。 */
  consumed: boolean;
}

export const INITIAL_PENDING: VimPending = {
  operator: null,
  gPrefix: false,
  findPending: null,
  textObjectPending: null,
  count: "",
  register: "",
  registerLinewise: false,
  lastFind: null,
};

export const INITIAL_ENGINE_STATE: VimEngineState = {
  mode: "normal",
  pending: INITIAL_PENDING,
  visualAnchor: null,
};

/** 复位 pending（保留寄存器与 lastFind——它们跨命令存活）。 */
export function resetPending(p: VimPending): VimPending {
  return {
    ...INITIAL_PENDING,
    register: p.register,
    registerLinewise: p.registerLinewise,
    lastFind: p.lastFind,
  };
}
