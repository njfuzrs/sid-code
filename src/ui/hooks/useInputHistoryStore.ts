/**
 * 输入历史持久化 Hook
 *
 * 参考 gemini-cli useInputHistoryStore
 * 将输入历史保存到磁盘，跨会话保留。
 *
 * 存储位置：~/.sid-code/input-history.json
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".sid-code");
const HISTORY_FILE = join(CONFIG_DIR, "input-history.json");
const MAX_PERSISTED_HISTORY = 200;

/** 从磁盘加载历史 */
function loadHistory(): string[] {
  try {
    const data = readFileSync(HISTORY_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_PERSISTED_HISTORY);
    }
  } catch {
    // 文件不存在或解析失败
  }
  return [];
}

/** 保存历史到磁盘 */
function saveHistory(history: string[]): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, MAX_PERSISTED_HISTORY)), "utf-8");
  } catch {
    // 写入失败静默忽略
  }
}

export interface UseInputHistoryStoreReturn {
  /** 历史记录（最新在前） */
  history: string[];
  /** 添加一条历史 */
  addEntry: (text: string) => void;
}

export function useInputHistoryStore(): UseInputHistoryStoreReturn {
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 防抖保存
  const scheduleSave = useCallback((newHistory: string[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveHistory(newHistory);
      saveTimerRef.current = null;
    }, 1000);
  }, []);

  // 组件卸载时立即保存
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveHistory(history);
      }
    };
  }, [history]);

  const addEntry = useCallback((text: string) => {
    if (!text.trim()) return;
    setHistory(prev => {
      // 去重：移除已有的相同条目
      const filtered = prev.filter(item => item !== text);
      const newHistory = [text, ...filtered].slice(0, MAX_PERSISTED_HISTORY);
      scheduleSave(newHistory);
      return newHistory;
    });
  }, [scheduleSave]);

  return { history, addEntry };
}
