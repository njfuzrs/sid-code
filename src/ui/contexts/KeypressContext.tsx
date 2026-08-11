/**
 * 键盘事件优先级系统（重构版）
 *
 * 核心变更：
 * - 不再依赖 Ink useInput()，直接读取 process.stdin 原始数据
 * - 生成器状态机解析转义序列（支持 CSI-u / SS3 / VT100 / Kitty）
 * - MultiMap<number, Handler> 优先级存储 + 缓存排序
 * - 同优先级内后注册先处理（栈语义）
 * - 50ms 转义序列超时缓冲
 * - 粘贴缓冲（Bracketed Paste Mode）
 * - 反斜杠+回车缓冲
 * - 非键盘事件过滤（鼠标/焦点事件不分发给键盘处理器）
 *
 * 参考 gemini-cli/packages/cli/src/ui/contexts/KeypressContext.tsx
 */

import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef } from "react";
import useStdin from "../../ink/hooks/use-stdin.ts";
import { MultiMap } from "mnemonist";
import { ESC } from "../utils/input.ts";
import { parseMouseEvent } from "../utils/mouse.ts";
import { terminalCapabilityManager } from "../utils/terminalCapabilityManager.ts";
import { getLogger } from "../../debug/logger.ts";

// ── 常量 ──

export const BACKSLASH_ENTER_TIMEOUT = 5;
export const ESC_TIMEOUT = 50;
export const PASTE_TIMEOUT = 30_000;
export const FAST_RETURN_TIMEOUT = 30;

/** 焦点事件序列 */
const FOCUS_IN = `${ESC}[I`;
const FOCUS_OUT = `${ESC}[O`;

// ── 优先级枚举 ──

export enum KeypressPriority {
  Low = -100,
  Normal = 0,
  High = 100,
  Critical = 200,
}

// ── 按键映射表 ──

const KEY_INFO_MAP: Record<string, { name: string; shift?: boolean; ctrl?: boolean }> = {
  '[200~': { name: 'paste-start' },
  '[201~': { name: 'paste-end' },
  '[[A': { name: 'f1' },
  '[[B': { name: 'f2' },
  '[[C': { name: 'f3' },
  '[[D': { name: 'f4' },
  '[[E': { name: 'f5' },
  '[1~': { name: 'home' },
  '[2~': { name: 'insert' },
  '[3~': { name: 'delete' },
  '[4~': { name: 'end' },
  '[5~': { name: 'pageup' },
  '[6~': { name: 'pagedown' },
  '[7~': { name: 'home' },
  '[8~': { name: 'end' },
  '[11~': { name: 'f1' },
  '[12~': { name: 'f2' },
  '[13~': { name: 'f3' },
  '[14~': { name: 'f4' },
  '[15~': { name: 'f5' },
  '[17~': { name: 'f6' },
  '[18~': { name: 'f7' },
  '[19~': { name: 'f8' },
  '[20~': { name: 'f9' },
  '[21~': { name: 'f10' },
  '[23~': { name: 'f11' },
  '[24~': { name: 'f12' },
  '[25~': { name: 'f13' },
  '[26~': { name: 'f14' },
  '[28~': { name: 'f15' },
  '[29~': { name: 'f16' },
  '[31~': { name: 'f17' },
  '[32~': { name: 'f18' },
  '[33~': { name: 'f19' },
  '[34~': { name: 'f20' },
  '[A': { name: 'up' },
  '[B': { name: 'down' },
  '[C': { name: 'right' },
  '[D': { name: 'left' },
  '[E': { name: 'clear' },
  '[F': { name: 'end' },
  '[H': { name: 'home' },
  '[P': { name: 'f1' },
  '[Q': { name: 'f2' },
  '[R': { name: 'f3' },
  '[S': { name: 'f4' },
  OA: { name: 'up' },
  OB: { name: 'down' },
  OC: { name: 'right' },
  OD: { name: 'left' },
  OE: { name: 'clear' },
  OF: { name: 'end' },
  OH: { name: 'home' },
  OP: { name: 'f1' },
  OQ: { name: 'f2' },
  OR: { name: 'f3' },
  OS: { name: 'f4' },
  OZ: { name: 'tab', shift: true },
  '[[5~': { name: 'pageup' },
  '[[6~': { name: 'pagedown' },
  '[a': { name: 'up', shift: true },
  '[b': { name: 'down', shift: true },
  '[c': { name: 'right', shift: true },
  '[d': { name: 'left', shift: true },
  '[e': { name: 'clear', shift: true },
  '[2$': { name: 'insert', shift: true },
  '[3$': { name: 'delete', shift: true },
  '[5$': { name: 'pageup', shift: true },
  '[6$': { name: 'pagedown', shift: true },
  '[7$': { name: 'home', shift: true },
  '[8$': { name: 'end', shift: true },
  '[Z': { name: 'tab', shift: true },
  Oa: { name: 'up', ctrl: true },
  Ob: { name: 'down', ctrl: true },
  Oc: { name: 'right', ctrl: true },
  Od: { name: 'left', ctrl: true },
  Oe: { name: 'clear', ctrl: true },
  '[2^': { name: 'insert', ctrl: true },
  '[3^': { name: 'delete', ctrl: true },
  '[5^': { name: 'pageup', ctrl: true },
  '[6^': { name: 'pagedown', ctrl: true },
  '[7^': { name: 'home', ctrl: true },
  '[8^': { name: 'end', ctrl: true },
};

// Kitty 键盘协议（CSI u）码映射
const KITTY_CODE_MAP: Record<number, { name: string; sequence?: string }> = {
  2: { name: 'insert' },
  3: { name: 'delete' },
  5: { name: 'pageup' },
  6: { name: 'pagedown' },
  9: { name: 'tab' },
  13: { name: 'enter' },
  14: { name: 'up' },
  15: { name: 'down' },
  16: { name: 'right' },
  17: { name: 'left' },
  27: { name: 'escape' },
  32: { name: 'space', sequence: ' ' },
  127: { name: 'backspace' },
  57358: { name: 'capslock' },
  57359: { name: 'scrolllock' },
  57360: { name: 'numlock' },
  57361: { name: 'printscreen' },
  57362: { name: 'pausebreak' },
  57409: { name: 'numpad_decimal', sequence: '.' },
  57410: { name: 'numpad_divide', sequence: '/' },
  57411: { name: 'numpad_multiply', sequence: '*' },
  57412: { name: 'numpad_subtract', sequence: '-' },
  57413: { name: 'numpad_add', sequence: '+' },
  57414: { name: 'enter' },
  57416: { name: 'numpad_separator', sequence: ',' },
  // F13-F35
  ...Object.fromEntries(
    Array.from({ length: 23 }, (_, i) => [302 + i, { name: `f${13 + i}` }]),
  ),
  // 数字键盘 0-9
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [
      57399 + i,
      { name: `numpad${i}`, sequence: String(i) },
    ]),
  ),
};

// 应用键盘模式下的数字键盘（SS3 序列）
const NUMPAD_MAP: Record<string, string> = {
  Oj: '*', Ok: '+', Om: '-', Oo: '/',
  Op: '0', Oq: '1', Or: '2', Os: '3', Ot: '4',
  Ou: '5', Ov: '6', Ow: '7', Ox: '8', Oy: '9', On: '.',
};

// Mac Alt 键特殊字符映射
const MAC_ALT_KEY_CHARACTER_MAP: Record<string, string> = {
  '\u222B': 'b', // ∫ — 后退一个词
  '\u0192': 'f', // ƒ — 前进一个词
  '\u00B5': 'm', // µ
  '\u03A9': 'z', // Ω — Option+z
  '\u00B8': 'Z', // ¸ — Option+Shift+z
  '\u2202': 'd', // ∂ — 向前删除一个词
};

const kUTF16SurrogateThreshold = 0x10000;
function charLengthAt(str: string, i: number): number {
  if (str.length <= i) return 1;
  const code = str.codePointAt(i);
  return code !== undefined && code >= kUTF16SurrogateThreshold ? 2 : 1;
}

// ── Key 接口 ──

export interface Key {
  name: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  cmd: boolean;
  insertable: boolean;
  sequence: string;
}

export type KeypressHandler = (key: Key) => boolean | void;

// ── 中间件：过滤非键盘事件 ──

function nonKeyboardEventFilter(keypressHandler: KeypressHandler): KeypressHandler {
  return (key: Key) => {
    if (
      !parseMouseEvent(key.sequence) &&
      key.sequence !== FOCUS_IN &&
      key.sequence !== FOCUS_OUT
    ) {
      return keypressHandler(key);
    }
  };
}

// ── 中间件：快速回车转换为 Shift+Enter ──

function bufferFastReturn(keypressHandler: KeypressHandler): KeypressHandler {
  let lastKeyTime = 0;
  return (key: Key) => {
    const now = Date.now();
    if (key.name === 'enter' && now - lastKeyTime <= FAST_RETURN_TIMEOUT) {
      return keypressHandler({
        ...key,
        name: 'enter',
        shift: true,
        alt: false,
        ctrl: false,
        cmd: false,
        sequence: '\r',
        insertable: true,
      });
    } else {
      const result = keypressHandler(key);
      lastKeyTime = key.insertable ? now : 0;
      return result;
    }
  };
}

// ── 中间件：反斜杠+回车缓冲 ──

function bufferBackslashEnter(keypressHandler: KeypressHandler): KeypressHandler {
  const bufferer = (function* (): Generator<void, void, Key | null> {
    while (true) {
      const key = yield;
      if (key == null) continue;
      if (key.sequence !== '\\') {
        keypressHandler(key);
        continue;
      }

      const timeoutId = setTimeout(() => bufferer.next(null), BACKSLASH_ENTER_TIMEOUT);
      const nextKey = yield;
      clearTimeout(timeoutId);

      if (nextKey === null) {
        keypressHandler(key);
      } else if (nextKey.name === 'enter') {
        keypressHandler({ ...nextKey, shift: true, sequence: '\r' });
      } else {
        keypressHandler(key);
        keypressHandler(nextKey);
      }
    }
  })();
  bufferer.next();
  return (key: Key) => { bufferer.next(key); };
}

// ── 中间件：粘贴缓冲（Bracketed Paste Mode） ──

function bufferPaste(keypressHandler: KeypressHandler): KeypressHandler {
  const bufferer = (function* (): Generator<void, void, Key | null> {
    while (true) {
      let key = yield;
      if (key === null) continue;
      if (key.name !== 'paste-start') {
        keypressHandler(key);
        continue;
      }

      let buffer = '';
      while (true) {
        const timeoutId = setTimeout(() => bufferer.next(null), PASTE_TIMEOUT);
        key = yield;
        clearTimeout(timeoutId);

        if (key === null) break;
        if (key.name === 'paste-end') break;
        buffer += key.sequence;
      }

      if (buffer.length > 0) {
        keypressHandler({
          name: 'paste',
          shift: false, alt: false, ctrl: false, cmd: false,
          insertable: true,
          sequence: buffer,
        });
      }
    }
  })();
  bufferer.next();
  return (key: Key) => { bufferer.next(key); };
}

// ── 原始数据 → 按键事件解析器 ──

function createDataListener(keypressHandler: KeypressHandler) {
  const parser = emitKeys(keypressHandler);
  parser.next();

  let timeoutId: NodeJS.Timeout;
  return (data: string) => {
    clearTimeout(timeoutId);
    for (const char of data) {
      parser.next(char);
    }
    if (data.length !== 0) {
      timeoutId = setTimeout(() => parser.next(''), ESC_TIMEOUT);
    }
  };
}

/**
 * 生成器状态机：将原始字符流解析为结构化按键事件
 *
 * 支持：VT100/xterm、SS3、CSI-u（Kitty）、ModifyOtherKeys、
 * SGR/X11 鼠标（透传）、OSC（如 OSC 52 剪贴板）、Bracketed Paste
 */
function* emitKeys(keypressHandler: KeypressHandler): Generator<void, void, string> {
  const lang = process.env['LANG'] || '';
  const lcAll = process.env['LC_ALL'] || '';
  const isGreek = lang.startsWith('el') || lcAll.startsWith('el');

  while (true) {
    let ch = yield;
    let sequence = ch;
    let escaped = false;

    let name: string | undefined = undefined;
    let shift = false;
    let alt = false;
    let ctrl = false;
    let cmd = false;
    let code: string | undefined = undefined;
    let insertable = false;

    if (ch === ESC) {
      escaped = true;
      ch = yield;
      sequence += ch;
      if (ch === ESC) {
        ch = yield;
        sequence += ch;
      }
    }

    if (escaped && (ch === 'O' || ch === '[' || ch === ']')) {
      code = ch;
      let modifier = 0;

      if (ch === ']') {
        // OSC 序列
        let buffer = '';
        while (true) {
          const next = yield;
          if (next === '' || next === '\u0007') break;
          if (next === ESC) {
            const afterEsc = yield;
            if (afterEsc === '' || afterEsc === '\\') break;
            buffer += next + afterEsc;
            continue;
          }
          buffer += next;
        }
        // OSC 52 剪贴板
        const match = /^52;[cp];(.*)$/.exec(buffer);
        if (match) {
          try {
            const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
            keypressHandler({
              name: 'paste', shift: false, alt: false, ctrl: false, cmd: false,
              insertable: true, sequence: decoded,
            });
          } catch (_e) { /* 解码失败 */ }
        }
        continue;
      } else if (ch === 'O') {
        // SS3 序列
        ch = yield;
        sequence += ch;
        if (ch >= '0' && ch <= '9') {
          modifier = parseInt(ch, 10) - 1;
          ch = yield;
          sequence += ch;
        }
        code += ch;
      } else if (ch === '[') {
        // CSI 序列
        ch = yield;
        sequence += ch;
        if (ch === '[') {
          code += ch;
          ch = yield;
          sequence += ch;
        }

        const cmdStart = sequence.length - 1;

        while (ch >= '0' && ch <= '9') { ch = yield; sequence += ch; }

        if (ch === ';') {
          while (ch === ';') {
            ch = yield; sequence += ch;
            while (ch >= '0' && ch <= '9') { ch = yield; sequence += ch; }
          }
        } else if (ch === '<') {
          // SGR 鼠标
          ch = yield; sequence += ch;
          while (ch === '' || ch === ';' || (ch >= '0' && ch <= '9')) {
            ch = yield; sequence += ch;
          }
        } else if (ch === 'M') {
          // X11 鼠标
          ch = yield; sequence += ch;
          ch = yield; sequence += ch;
          ch = yield; sequence += ch;
        }

        const cmd = sequence.slice(cmdStart);
        let match;

        if ((match = /^(\d+)(?:;(\d+))?(?:;(\d+))?([~^$u])$/.exec(cmd))) {
          if (match[1] === '27' && match[3] && match[4] === '~') {
            code += match[3] + 'u';
            modifier = parseInt(match[2] ?? '1', 10) - 1;
          } else {
            code += match[1] + match[4];
            modifier = parseInt(match[2] ?? '1', 10) - 1;
          }
        } else if ((match = /^(\d+)?(?:;(\d+))?([A-Za-z])$/.exec(cmd))) {
          code += match[3];
          modifier = parseInt(match[2] ?? match[1] ?? '1', 10) - 1;
        } else {
          code += cmd;
        }
      }

      shift = !!(modifier & 1);
      alt = !!(modifier & 2);
      ctrl = !!(modifier & 4);
      cmd = !!(modifier & 8);

      const keyInfo = KEY_INFO_MAP[code!];
      if (keyInfo) {
        name = keyInfo.name;
        if (keyInfo.shift) shift = true;
        if (keyInfo.ctrl) ctrl = true;
        if (name === 'space' && !ctrl && !cmd && !alt) {
          sequence = ' ';
          insertable = true;
        }
      } else {
        const numpadChar = NUMPAD_MAP[code!];
        if (numpadChar) {
          name = numpadChar;
          if (!ctrl && !cmd && !alt) { sequence = numpadChar; insertable = true; }
        } else {
          name = 'undefined';
          if (code!.endsWith('u') || code!.endsWith('~')) {
            const codeNumber = parseInt(code!.slice(1, -1), 10);
            const mapped = KITTY_CODE_MAP[codeNumber];
            if (mapped) {
              name = mapped.name;
              if (mapped.sequence && !ctrl && !cmd && !alt) {
                sequence = mapped.sequence;
                insertable = true;
              }
            } else if (
              codeNumber >= 33 && codeNumber <= 0x10ffff &&
              (codeNumber < 0xd800 || codeNumber > 0xdfff)
            ) {
              const char = String.fromCodePoint(codeNumber);
              name = char.toLowerCase();
              if (char !== name) shift = true;
              if (!ctrl && !cmd && !alt) { sequence = char; insertable = true; }
            }
          }
        }
      }
    } else if (ch === '\r') {
      name = 'enter'; alt = escaped;
    } else if (escaped && ch === '\n') {
      name = 'enter'; alt = escaped;
    } else if (ch === '\t') {
      name = 'tab'; alt = escaped;
    } else if (ch === '\b' || ch === '\x7f') {
      name = 'backspace'; alt = escaped;
    } else if (ch === ESC) {
      name = 'escape'; alt = escaped;
    } else if (ch === ' ') {
      name = 'space'; alt = escaped; insertable = true;
    } else if (!escaped && ch <= '\x1a') {
      name = String.fromCharCode(ch.charCodeAt(0) + 'a'.charCodeAt(0) - 1);
      ctrl = true;
    } else if (/^[0-9A-Za-z]$/.exec(ch) !== null) {
      name = ch.toLowerCase();
      shift = /^[A-Z]$/.exec(ch) !== null;
      alt = escaped;
      insertable = true;
    } else if (MAC_ALT_KEY_CHARACTER_MAP[ch]) {
      if (isGreek && ch === '\u03A9') {
        insertable = true;
      } else {
        const mapped = MAC_ALT_KEY_CHARACTER_MAP[ch];
        name = mapped.toLowerCase();
        shift = mapped !== name;
        alt = true;
      }
    } else if (sequence === `${ESC}${ESC}`) {
      // P2-1：Esc+Esc 双击不再合并/去抖为单 escape（那样会抹掉双击信号），而是发出
      // 专门的 escape-escape 事件，供 rewind 回退选择器消费。单 Esc 逻辑（中断/关面板）不变——
      // 单 Esc 走上面的 ch === ESC 分支发 name:'escape'，二者互不干扰。
      name = 'escape-escape'; alt = false;
    } else if (escaped) {
      name = ch.length ? undefined : 'escape';
      alt = ch.length > 0;
    } else {
      name = ch.toLowerCase();
      if (ch !== name) shift = true;
      insertable = true;
    }

    if (
      (sequence.length !== 0 && (name !== undefined || escaped)) ||
      charLengthAt(sequence, 0) === sequence.length
    ) {
      keypressHandler({
        name: name || '', shift, alt, ctrl, cmd, insertable, sequence,
      });
    }
  }
}

// ── React Context ──

interface KeypressContextValue {
  subscribe: (handler: KeypressHandler, priority?: KeypressPriority | boolean) => void;
  unsubscribe: (handler: KeypressHandler) => void;
}

const KeypressCtx = createContext<KeypressContextValue | undefined>(undefined);

export function useKeypressContext() {
  const context = useContext(KeypressCtx);
  if (!context) {
    throw new Error("useKeypressContext 必须在 KeypressProvider 内使用");
  }
  return context;
}

export function KeypressProvider({ children }: { children: React.ReactNode }) {
  const log = getLogger();
  const { stdin, setRawMode } = useStdin();

  const subscribersToPriority = useRef<Map<KeypressHandler, number>>(new Map()).current;
  const subscribers = useRef(new MultiMap<number, KeypressHandler>(Set)).current;
  const sortedPriorities = useRef<number[]>([]);

  const subscribe = useCallback(
    (handler: KeypressHandler, priority: KeypressPriority | boolean = KeypressPriority.Normal) => {
      const p = typeof priority === 'boolean'
        ? (priority ? KeypressPriority.High : KeypressPriority.Normal)
        : priority;
      subscribersToPriority.set(handler, p);
      const hadPriority = subscribers.has(p);
      subscribers.set(p, handler);
      if (!hadPriority) {
        sortedPriorities.current = Array.from(subscribers.keys()).sort((a, b) => b - a);
      }
    },
    [subscribers, subscribersToPriority],
  );

  const unsubscribe = useCallback(
    (handler: KeypressHandler) => {
      const p = subscribersToPriority.get(handler);
      if (p !== undefined) {
        subscribers.remove(p, handler);
        subscribersToPriority.delete(handler);
        if (!subscribers.has(p)) {
          sortedPriorities.current = Array.from(subscribers.keys()).sort((a, b) => b - a);
        }
      }
    },
    [subscribers, subscribersToPriority],
  );

  const broadcast = useCallback(
    (key: Key) => {
      for (const p of sortedPriorities.current) {
        const set = subscribers.get(p);
        if (!set) continue;
        const handlers = Array.from(set as Iterable<KeypressHandler>).reverse();
        for (const handler of handlers) {
          try {
            if (handler(key) === true) return;
          } catch (err) {
            if (process.env.DEBUG) {
              log.error('UI:KEYPRESS', `handler 异常`, { error: (err as Error).message });
            }
          }
        }
      }
    },
    [subscribers],
  );

  useEffect(() => {
    terminalCapabilityManager.enableSupportedModes();

    const wasRaw = stdin.isRaw;
    if (wasRaw === false) {
      setRawMode(true);
    }
    process.stdin.setEncoding('utf8');

    // 构建中间件链
    let processor: KeypressHandler = nonKeyboardEventFilter(broadcast);
    if (!terminalCapabilityManager.isKittyProtocolEnabled()) {
      processor = bufferFastReturn(processor);
    }
    processor = bufferBackslashEnter(processor);
    processor = bufferPaste(processor);
    const dataListener = createDataListener(processor);

    stdin.on('data', dataListener);
    return () => {
      stdin.removeListener('data', dataListener);
      if (wasRaw === false) {
        setRawMode(false);
      }
    };
  }, [stdin, setRawMode, broadcast]);

  const contextValue = useMemo(
    () => ({ subscribe, unsubscribe }),
    [subscribe, unsubscribe],
  );

  return (
    <KeypressCtx.Provider value={contextValue}>
      {children}
    </KeypressCtx.Provider>
  );
}

// ── 兼容 hook：useKeypress ──

/**
 * 注册键盘事件处理器
 *
 * handler 接收新的 Key 接口（包含 name/shift/alt/ctrl/cmd/insertable/sequence）
 * 返回 true 消费事件，false/void 传递给下一个
 */
export function useKeypress(priority: KeypressPriority, handler: KeypressHandler): void {
  const ctx = useContext(KeypressCtx);
  if (!ctx) throw new Error("useKeypress 必须在 KeypressProvider 内使用");

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const wrappedHandler: KeypressHandler = (key) => handlerRef.current(key);
    ctx.subscribe(wrappedHandler, priority);
    return () => ctx.unsubscribe(wrappedHandler);
  }, [ctx, priority]);
}
