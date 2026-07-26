/**
 * 输入历史持久化 Hook
 *
 * P2-G8：权威源升级为全局 `~/.sid-code/history.jsonl`（带 project/sessionId 元数据的 JSONL
 * 追加索引），替代旧的 `~/.sid-code/input-history.json`（纯字符串数组、进程覆写）。
 * 首次读取时若发现旧文件且新索引为空，自动迁移一次（见 history-index.migrateLegacyInputHistory）。
 *
 * 对现有消费方（useReverseSearch / ↑↓ 历史）保持 `history: string[]`（最新在前）接口不变，
 * 只是数据来源换成 history.jsonl 的 display 列表；写入改为向 JSONL 追加带元数据的记录。
 */

import { useState, useCallback } from "react";
import {
  appendHistoryEntry,
  readHistoryDisplays,
  type HistoryEntry,
} from "../../session/history-index.ts";
import { getSessionId, getProjectRoot } from "../../bootstrap/state.ts";
import { listPastes } from "../pasted-contents.ts";

/** 内存展示上限（与 history-index 的读取上限一致即可） */
const MAX_IN_MEMORY = 500;

export interface UseInputHistoryStoreReturn {
  /** 历史记录（最新在前，去重） */
  history: string[];
  /** 添加一条历史 */
  addEntry: (text: string) => void;
}

/** 采集当前粘贴内容摘要（P2-G8：history.jsonl 的 pastedContents 字段）。
 *  只存类型 + 首行预览，不存全文（history.jsonl 是检索索引，不该膨胀成内容库）。 */
function collectPastedContents(): HistoryEntry["pastedContents"] {
  try {
    return listPastes().map(p => ({
      id: p.id,
      type: p.type,
      preview: p.type === "text" ? p.content.slice(0, 80) : p.content,
    }));
  } catch {
    return [];
  }
}

export function useInputHistoryStore(): UseInputHistoryStoreReturn {
  // 初始从 history.jsonl 读 display 列表（最新在前、去重）；含旧文件一次性迁移。
  const [history, setHistory] = useState<string[]>(() =>
    readHistoryDisplays({ limit: MAX_IN_MEMORY }),
  );

  const addEntry = useCallback((text: string) => {
    if (!text.trim()) return;
    // 追加到全局 JSONL 索引（带 project/sessionId/时间戳/粘贴内容）。
    appendHistoryEntry({
      display: text,
      pastedContents: collectPastedContents(),
      timestamp: new Date().toISOString(),
      project: safeProjectRoot(),
      sessionId: safeSessionId(),
    });
    // 同步更新内存视图（去重、最新在前）供本次会话即时检索。
    setHistory(prev => {
      const filtered = prev.filter(item => item !== text);
      return [text, ...filtered].slice(0, MAX_IN_MEMORY);
    });
  }, []);

  return { history, addEntry };
}

function safeProjectRoot(): string {
  try {
    return getProjectRoot();
  } catch {
    return "";
  }
}

function safeSessionId(): string {
  try {
    return getSessionId();
  } catch {
    return "";
  }
}
