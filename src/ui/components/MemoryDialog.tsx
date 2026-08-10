/**
 * Memory 管理面板（/memory 无参时打开）
 *
 * M5：主视图改指 **auto-memory 条目**（~/.sid-code/projects/<key>/memory/*.md），
 * 而非 CLAUDE.md 文件。对齐 CC /memory 的「查看 + 编辑」语义。
 *
 * 视图状态机：
 *   auto-list     → auto-memory 条目列表（name/type/description/updated，按 updated 降序）
 *   auto-detail   → 选中条目全文（非截断）
 *   confirm-del   → 删除二次确认（标红，y/n）
 *   files-list    → CLAUDE.md 文件列表（保留原浏览能力，f 键切换）
 *   files-preview → CLAUDE.md 文件只读预览
 *
 * 交互键（遵守 src/ui/CLAUDE.md 交互铁律）：
 *   ↑↓ 导航 · Enter 查看 · e 编辑器打开 · d 删除（二次确认）· f 切 CLAUDE.md · Esc 返回/关闭
 */

import React, { useState, useMemo, useEffect, useCallback } from "react";
import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import stringWidth from "string-width";
import { theme } from "../semantic-colors.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import { BaseSelectionList, type SelectionListItem } from "./shared/BaseSelectionList.tsx";
import { ARROW_PROMPT } from "../constants/figures.ts";
import { openFileInExternalEditor } from "../utils/external-editor.ts";
import {
  discoverMemoryFiles,
  readMemoryContent,
  formatFileSize,
  formatMtime,
  type MemoryFileInfo,
} from "../utils/memory-files.ts";
import type { MemoryEntry } from "../../memory/store.ts";

interface MemoryDialogProps {
  onClose: () => void;
  cwd: string;
}

type ViewState =
  | { type: "auto-list" }
  | { type: "auto-detail"; entry: MemoryEntry }
  | { type: "confirm-del"; entry: MemoryEntry }
  | { type: "files-list" }
  | { type: "files-preview"; file: MemoryFileInfo };

interface EntryItem extends SelectionListItem<string> {
  entry: MemoryEntry;
}

interface FileItem extends SelectionListItem<string> {
  info: MemoryFileInfo;
}

const SCOPE_LABEL: Record<MemoryFileInfo["scope"], string> = {
  project: "项目级",
  user: "用户级",
};

const ENTRY_SCOPE_LABEL: Record<MemoryEntry["scope"], string> = {
  project: "项目",
  global: "全局",
};

const TYPE_LABEL: Record<string, string> = {
  user: "画像",
  feedback: "反馈",
  project: "项目",
  reference: "引用",
};

/** 预览最多渲染的行数（CLAUDE.md 文件预览用；auto-detail 不截断）。 */
const MAX_PREVIEW_LINES = 30;

/** 格式化更新时间为 YYYY-MM-DD HH:mm（本地时区）。 */
function formatUpdated(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const MemoryDialog: React.FC<MemoryDialogProps> = ({ onClose, cwd }) => {
  const [view, setView] = useState<ViewState>({ type: "auto-list" });
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");

  // CLAUDE.md 文件（f 键切换视图时用）
  const files = useMemo(() => discoverMemoryFiles(cwd), [cwd]);

  // 加载 auto-memory 条目（异步）
  const reloadEntries = useCallback(async () => {
    try {
      const { MemoryStore } = await import("../../memory/store.ts");
      const store = new MemoryStore(cwd);
      const list = await store.list();
      setEntries(list);
    } catch {
      setEntries([]);
    }
  }, [cwd]);

  useEffect(() => {
    void reloadEntries();
  }, [reloadEntries]);

  // 用编辑器打开某条记忆
  const openEntryInEditor = useCallback(async (entry: MemoryEntry) => {
    try {
      const { MemoryStore } = await import("../../memory/store.ts");
      const store = new MemoryStore(cwd);
      const path = await store.resolveEntryPath(entry.key, entry.scope);
      if (!path) {
        setStatusMsg(`未找到记忆文件: ${entry.key}`);
        return;
      }
      const res = await openFileInExternalEditor(path);
      if (!res.ok) {
        setStatusMsg(res.error || "编辑器打开失败");
      } else {
        setStatusMsg(`已编辑: ${entry.key}`);
        await reloadEntries();
      }
    } catch (e) {
      setStatusMsg(`编辑失败: ${(e as Error)?.message}`);
    }
  }, [cwd, reloadEntries]);

  // 删除某条记忆
  const deleteEntry = useCallback(async (entry: MemoryEntry) => {
    try {
      const { MemoryStore } = await import("../../memory/store.ts");
      const store = new MemoryStore(cwd);
      const ok = await store.delete(entry.key, entry.scope);
      setStatusMsg(ok ? `已删除: ${entry.key}` : `删除失败: ${entry.key}`);
      await reloadEntries();
    } catch (e) {
      setStatusMsg(`删除失败: ${(e as Error)?.message}`);
    }
    setView({ type: "auto-list" });
  }, [cwd, reloadEntries]);

  // 键盘：动作键（e/d/f）+ Esc 分层返回。BaseSelectionList 处理 ↑↓/Enter。
  useKeypress(KeypressPriority.Critical, (key: Key) => {
    // Esc：分层返回
    if (key.name === "escape") {
      if (view.type === "auto-detail" || view.type === "confirm-del") {
        setView({ type: "auto-list" });
      } else if (view.type === "files-preview") {
        setView({ type: "files-list" });
      } else if (view.type === "files-list") {
        setView({ type: "auto-list" });
      } else {
        onClose();
      }
      return true;
    }

    // 删除确认：y 确认 / n 取消
    if (view.type === "confirm-del") {
      if (key.name === "y") {
        void deleteEntry(view.entry);
        return true;
      }
      if (key.name === "n") {
        setView({ type: "auto-list" });
        return true;
      }
      return true; // 确认态吞掉其它键
    }

    // auto-list 视图的动作键
    if (view.type === "auto-list" && entries && entries.length > 0) {
      const cur = entries.find((e) => e.key === highlightedKey) ?? entries[0];
      if (key.name === "e" && !key.ctrl && !key.alt) {
        void openEntryInEditor(cur);
        return true;
      }
      if (key.name === "d" && !key.ctrl && !key.alt) {
        setView({ type: "confirm-del", entry: cur });
        return true;
      }
    }

    // f：auto-list ↔ files-list 切换
    if (key.name === "f" && !key.ctrl && !key.alt) {
      if (view.type === "auto-list") { setView({ type: "files-list" }); return true; }
      if (view.type === "files-list") { setView({ type: "auto-list" }); return true; }
    }

    return false;
  });

  // ── auto-detail：条目全文 ──
  if (view.type === "auto-detail") {
    const { entry } = view;
    const lines = entry.value.split("\n");
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Box>
          <Text bold color={theme.ui.active}>{entry.key}</Text>
          <Text color={theme.text.secondary}> ({ENTRY_SCOPE_LABEL[entry.scope]}{entry.type ? ` · ${TYPE_LABEL[entry.type] ?? entry.type}` : ""})</Text>
        </Box>
        {entry.description && <Text color={theme.text.secondary}>{entry.description}</Text>}
        <Text color={theme.text.secondary}>更新: {formatUpdated(entry.updatedAt)}</Text>
        <Box marginTop={1} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color={theme.text.primary}>{line || " "}</Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text italic>e 编辑器打开 · Esc 返回</Text>
        </Box>
      </Box>
    );
  }

  // ── confirm-del：删除二次确认（标红）──
  if (view.type === "confirm-del") {
    const { entry } = view;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.status.error} paddingX={1} paddingY={0}>
        <Text bold color={theme.status.error}>确认删除记忆？</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.primary}>{entry.key}</Text>
          {entry.description && <Text color={theme.text.secondary}>{entry.description}</Text>}
          <Text color={theme.text.secondary}>此操作不可撤销，将删除对应的 .md 文件。</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.status.error}>y 确认删除</Text>
          <Text color={theme.text.secondary}>  ·  n 取消</Text>
        </Box>
      </Box>
    );
  }

  // ── files-preview：CLAUDE.md 文件只读预览 ──
  if (view.type === "files-preview") {
    const { file } = view;
    const content = readMemoryContent(file.path);
    const allLines = content.split("\n");
    const lines = allLines.slice(0, MAX_PREVIEW_LINES);
    const truncated = allLines.length > MAX_PREVIEW_LINES;

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Box>
          <Text bold color={theme.ui.active}>{file.displayPath}</Text>
          <Text color={theme.text.secondary}> ({SCOPE_LABEL[file.scope]})</Text>
        </Box>
        <Text color={theme.text.secondary}>
          {formatFileSize(file.size)} · {formatMtime(file.mtimeMs)} 修改
        </Text>
        <Box marginTop={1} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color={theme.text.primary} wrap="truncate-end">
              {line || " "}
            </Text>
          ))}
          {truncated && (
            <Text italic>
              … 还有 {allLines.length - MAX_PREVIEW_LINES} 行（完整内容请用编辑器打开）
            </Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text italic>Esc 返回列表</Text>
        </Box>
      </Box>
    );
  }

  // ── files-list：CLAUDE.md 文件列表 ──
  if (view.type === "files-list") {
    if (files.length === 0) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
          <Text bold color={theme.ui.active}>CLAUDE.md 文件</Text>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>未发现任何 CLAUDE.md 文件</Text>
          </Box>
          <Text>可在项目根创建 CLAUDE.md，或 ~/.claude/CLAUDE.md（用户级）</Text>
          <Box marginTop={1}>
            <Text italic>f 返回记忆条目 · Esc 返回</Text>
          </Box>
        </Box>
      );
    }
    const fileItems: FileItem[] = files.map((info, i) => ({ value: info.path, key: `f-${i}`, info }));
    const pathColWidth = Math.max(...files.map((f) => stringWidth(f.displayPath)), 0);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Box>
          <Text bold color={theme.ui.active}>CLAUDE.md 文件</Text>
          <Text color={theme.text.secondary}> · {files.length} 个</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <BaseSelectionList<string, FileItem>
            items={fileItems}
            onSelect={(path) => {
              const file = files.find((f) => f.path === path);
              if (file) setView({ type: "files-preview", file });
            }}
            isFocused={true}
            showNumbers={false}
            maxItemsToShow={12}
            selectedIndicator={ARROW_PROMPT}
            renderItem={(item, { isSelected }) => {
              const { info } = item;
              const pad = " ".repeat(Math.max(2, pathColWidth - stringWidth(info.displayPath) + 2));
              return (
                <Box>
                  <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{info.displayPath}</Text>
                  <Text color={theme.text.secondary}>
                    {pad}{SCOPE_LABEL[info.scope]} · {formatFileSize(info.size)} · {formatMtime(info.mtimeMs)}
                  </Text>
                </Box>
              );
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text italic>↑↓ 导航 · Enter 查看 · f 返回记忆条目 · Esc 返回</Text>
        </Box>
      </Box>
    );
  }

  // ── auto-list：auto-memory 条目列表（主视图）──
  if (entries === null) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>Memory 管理</Text>
        <Box marginTop={1}><Text color={theme.text.secondary}>加载中…</Text></Box>
      </Box>
    );
  }

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
        <Text bold color={theme.ui.active}>Memory 管理</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>暂无 auto-memory 记忆条目</Text>
        </Box>
        <Text>对话中自动提取，或用 /memory set &lt;key&gt; &lt;value&gt; 手动添加</Text>
        <Box marginTop={1}>
          <Text italic>f 查看 CLAUDE.md 文件 · Esc 关闭</Text>
        </Box>
      </Box>
    );
  }

  const entryItems: EntryItem[] = entries.map((entry, i) => ({
    value: entry.key,
    key: `e-${i}`,
    entry,
  }));
  const keyColWidth = Math.max(...entries.map((e) => stringWidth(e.key)), 0);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      <Box>
        <Text bold color={theme.ui.active}>Memory 管理</Text>
        <Text color={theme.text.secondary}> · {entries.length} 条记忆</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <BaseSelectionList<string, EntryItem>
          items={entryItems}
          onSelect={(key) => {
            const entry = entries.find((e) => e.key === key);
            if (entry) setView({ type: "auto-detail", entry });
          }}
          onHighlight={(key) => setHighlightedKey(key)}
          isFocused={true}
          showNumbers={false}
          maxItemsToShow={12}
          selectedIndicator={ARROW_PROMPT}
          renderItem={(item, { isSelected }) => {
            const { entry } = item;
            const pad = " ".repeat(Math.max(2, keyColWidth - stringWidth(entry.key) + 2));
            const meta = `${ENTRY_SCOPE_LABEL[entry.scope]}${entry.type ? ` · ${TYPE_LABEL[entry.type] ?? entry.type}` : ""} · ${formatMtime(entry.updatedAt)}`;
            return (
              <Box>
                <Text color={isSelected ? theme.ui.focus : theme.text.primary}>{entry.key}</Text>
                <Text color={theme.text.secondary}>{pad}{meta}</Text>
              </Box>
            );
          }}
        />
      </Box>
      {statusMsg && <Box marginTop={1}><Text color={theme.text.secondary}>{statusMsg}</Text></Box>}
      <Box marginTop={1}>
        <Text italic>↑↓ 导航 · Enter 查看 · e 编辑 · d 删除 · f CLAUDE.md · Esc 关闭</Text>
      </Box>
    </Box>
  );
};
