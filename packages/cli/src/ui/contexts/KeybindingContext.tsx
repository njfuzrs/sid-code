/**
 * 键位上下文 — K2 接线 + K5 和弦集成
 *
 * 统一向全 app 提供：
 * 1. 合并后的运行时键位表（默认表 + 用户 keybindings.json 覆盖，由 K2 loadUserBindings 产出）。
 * 2. 一个绑定该表的 ChordMachine 实例（K5：把和弦状态机接入真实键位流程）。
 * 3. matchBinding / bindingFor 的"已绑表"便捷版（消费方无需自带 bindings 参数）。
 *
 * 加载是异步的（读 ~/.sid-code/keybindings.json）；加载完成前用 DEFAULT_BINDINGS 兜底，
 * 保证首帧键位即可用、绝不阻塞启动。
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Key } from "./KeypressContext.tsx";
import {
  DEFAULT_BINDINGS,
  matchBinding as matchBindingRaw,
  bindingFor as bindingForRaw,
  type KeyBinding,
} from "../keybindings/defaultBindings.ts";
import { ChordMachine, type ChordBinding, defaultChordBindings } from "../keybindings/chord.ts";
import { loadUserBindings } from "../keybindings/loadUserBindings.ts";

export interface KeybindingContextValue {
  /** 当前生效的键位表（默认 + 用户覆盖）。 */
  bindings: KeyBinding[];
  /** 用绑定表查单键命中。 */
  matchBinding: (key: Key) => KeyBinding | undefined;
  /** 用绑定表反查 action。 */
  bindingFor: (action: string) => KeyBinding | undefined;
  /** 绑定了当前和弦表的 ChordMachine（K5）。 */
  chordMachine: ChordMachine;
  /** 用户配置是否已应用（false = 纯默认表）。 */
  userConfigApplied: boolean;
}

const KeybindingContext = createContext<KeybindingContextValue | null>(null);

/**
 * 从单键 KeyBinding 表 + 额外和弦派生 ChordMachine 的绑定。
 *
 * 关键：**只把多键和弦喂给 ChordMachine**，单键仍由 matchBinding 在各 handler 内处理。
 * 否则单键会被和弦机和单键 handler 双重触发。默认和弦取 chord.ts 的 defaultChordBindings
 * （Ctrl+K→Ctrl+C 等），调用方可通过 extraChords 追加。
 *
 * bindings 参数当前未直接参与（单键不入机），保留形参是为将来"用户在 keybindings.json
 * 里声明多键和弦"预留扩展点。
 */
export function deriveChordBindings(
  _bindings: KeyBinding[],
  extraChords: ChordBinding[] = defaultChordBindings,
): ChordBinding[] {
  return [...extraChords];
}

export function KeybindingProvider({
  children,
  /** 测试可注入固定表，跳过异步加载。 */
  initialBindings,
  extraChords,
}: {
  children: React.ReactNode;
  initialBindings?: KeyBinding[];
  extraChords?: ChordBinding[];
}) {
  const [bindings, setBindings] = useState<KeyBinding[]>(
    initialBindings ?? DEFAULT_BINDINGS,
  );
  const [userConfigApplied, setUserConfigApplied] = useState(false);

  // ChordMachine 实例只创建一次；表变化时通过 setBindings 重新喂入。
  const chordMachineRef = useRef<ChordMachine | null>(null);
  if (chordMachineRef.current === null) {
    chordMachineRef.current = new ChordMachine(
      deriveChordBindings(initialBindings ?? DEFAULT_BINDINGS, extraChords),
    );
  }

  // 异步加载用户键位（仅当未注入固定表时）。
  useEffect(() => {
    if (initialBindings) return;
    let cancelled = false;
    void loadUserBindings().then((result) => {
      if (cancelled) return;
      setBindings(result.bindings);
      setUserConfigApplied(result.userConfigApplied);
    });
    return () => {
      cancelled = true;
    };
  }, [initialBindings]);

  // 表变化时同步到 ChordMachine（K5）。
  useEffect(() => {
    chordMachineRef.current?.setBindings(deriveChordBindings(bindings, extraChords));
  }, [bindings, extraChords]);

  const value = useMemo<KeybindingContextValue>(
    () => ({
      bindings,
      matchBinding: (key: Key) => matchBindingRaw(key, bindings),
      bindingFor: (action: string) => bindingForRaw(action, bindings),
      chordMachine: chordMachineRef.current!,
      userConfigApplied,
    }),
    [bindings, userConfigApplied],
  );

  return (
    <KeybindingContext.Provider value={value}>
      {children}
    </KeybindingContext.Provider>
  );
}

/**
 * 取键位上下文。Provider 之外调用时降级为默认表（不抛错），保证旧组件/测试不破。
 */
export function useKeybindings(): KeybindingContextValue {
  const ctx = useContext(KeybindingContext);
  if (ctx) return ctx;
  // 降级：无 Provider 时用默认表（如孤立渲染的单元测试）。
  return {
    bindings: DEFAULT_BINDINGS,
    matchBinding: (key: Key) => matchBindingRaw(key, DEFAULT_BINDINGS),
    bindingFor: (action: string) => bindingForRaw(action, DEFAULT_BINDINGS),
    chordMachine: fallbackChordMachine(),
    userConfigApplied: false,
  };
}

// 降级路径共享一台 ChordMachine，避免每次 useKeybindings 都新建。
let _fallbackMachine: ChordMachine | null = null;
function fallbackChordMachine(): ChordMachine {
  if (!_fallbackMachine) {
    _fallbackMachine = new ChordMachine(deriveChordBindings(DEFAULT_BINDINGS));
  }
  return _fallbackMachine;
}
