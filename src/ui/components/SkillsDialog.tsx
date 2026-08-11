/**
 * Skills 管理面板（/skills 无参时打开）
 *
 * 对标 claude-code /skills：可搜索、可管理的 Skill 列表。
 *   list   → Skill 列表：状态字形 + 定宽名称列 + 来源徽章 + token 估算 + 单行描述
 *   detail → Skill 详情（含 whenToUse / allowedTools / 文件路径 / token 估算）
 *
 * 搜索框常驻（对标 resume 选择器）：一进面板就能直接打字过滤 name/description/来源，
 * 无需先按 / 唤起。因字母键都进搜索框，管理动作全部落在非字母键上：
 *   输入    即时过滤
 *   ↑↓      移动选择
 *   Enter   切换启用/禁用（写盘 → 热更命令注册表 → 即时重渲）
 *   Tab     查看/退出详情
 *   Ctrl+S  切换排序（名称 / 状态 / 来源）
 *   Ctrl+T  切换作用范围（全局=用户级 ⇄ 仅本项目=项目级）
 *   Esc     detail→list → 有查询先清空 → 关闭（渐进退出，不丢状态）
 *
 * 数据源用 SkillManager.getAllSkills()（含禁用项）+ loadBundledSkills()（编译时内置），
 * 启/停状态从合并后的 settings.disabledSkills 判定，写盘复用 patchSettingsFile 外科式补丁。
 */

import React, { useState, useMemo, useEffect, useCallback } from "react";
import stringWidth from "string-width";
import Box from "../../ink/components/Box.tsx";
import Text from "../../ink/components/Text.tsx";
import useStdout from "../../ink/_vendor/use-stdout.ts";
import { theme } from "../semantic-colors.ts";
import type { Color } from "../../ink/styles.ts";
import { useKeypress, KeypressPriority, type Key } from "../contexts/KeypressContext.tsx";
import {
  POINTER,
  SUCCESS_MARK,
  ERROR_MARK,
  SEARCH_MARK,
} from "../constants/figures.ts";
import { SkillManager } from "../../skill/manager.ts";
import { loadBundledSkills } from "../../skill/bundled/index.ts";
import { estimateSkillListingTokens } from "../../skill/budget.ts";
import {
  getSettings,
  getSettingsForSource,
  patchSettingsFile,
} from "../../config/settings/index.ts";
import type { UnifiedCommandRegistry } from "../../command/unified-registry.ts";

interface SkillsDialogProps {
  onClose: () => void;
  registry: UnifiedCommandRegistry;
}

// 搜索框常驻（对标 resume 选择器）：列表态下输入即过滤，无需先按 / 唤起。
// 因此只有 list / detail 两态，不再有独立 search 态。
type Mode = "list" | "detail";
type SortKey = "name" | "status" | "source";
type Scope = "user" | "project";

/** 归一化后的 Skill 行（磁盘 Skill 与 bundled Skill 统一成此形状） */
interface SkillRow {
  name: string;
  description: string;
  whenToUse?: string;
  /** 来源键：builtin / bundled / user / project / mcp */
  sourceKey: string;
  /** 执行方式：inline（注入当前对话）/ fork（子代理执行） */
  type: string;
  argumentHint?: string;
  allowedTools?: string[];
  filePath?: string;
  tokens: number;
  // ── 详情视图补充字段 ──
  aliases?: string[];
  version?: string;
  model?: string;
  effort?: string;
  agent?: string;
  maxTurns?: number;
  timeoutMins?: number;
  /** 命名参数 $arg_name */
  argumentNames?: string[];
  /** 条件激活路径（glob） */
  paths?: string[];
  /** 生命周期钩子的事件名列表（如 PreToolUse） */
  hookEvents?: string[];
  /** 用户能否通过 /name 调用 */
  userInvocable?: boolean;
  /** 模型能否自动调用（disableModelInvocation 取反） */
  modelInvocable?: boolean;
  /** 提示词正文（仅磁盘 Skill 有静态正文；bundled 为动态生成，无预览） */
  prompt?: string;
  /** 提示词正文总行数（用于「还有 N 行」提示） */
  promptLines?: number;
}

const MAX_ROWS = 12;
const NAME_COL = 26;
/** 详情卡里提示词正文预览的最大行数（超出显示「还有 N 行」） */
const PROMPT_PREVIEW_LINES = 8;
const DEFAULT_TERM_WIDTH = 100;
const SORT_CYCLE: SortKey[] = ["name", "status", "source"];
const SORT_LABEL: Record<SortKey, string> = {
  name: "名称",
  status: "状态",
  source: "来源",
};
const SOURCE_ORDER: Record<string, number> = {
  builtin: 0,
  bundled: 1,
  user: 2,
  project: 3,
  mcp: 4,
};

function sourceLabel(key: string): string {
  switch (key) {
    case "builtin":
    case "bundled":
      return "内置";
    case "user":
      return "用户";
    case "project":
      return "项目";
    case "mcp":
      return "MCP";
    default:
      return "其他";
  }
}

function sourceColor(key: string): Color {
  switch (key) {
    case "user":
      return theme.status.success;
    case "project":
      return theme.status.warning;
    case "builtin":
    case "bundled":
    case "mcp":
    default:
      return theme.text.secondary;
  }
}

function tokLabel(tok: number): string {
  return tok < 20 ? "<20 tok" : `~${tok} tok`;
}

/** 按列宽（stringWidth）右侧补空格，含 CJK 时不会漂移 */
function padEndWidth(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** 按列宽截断，超出补 …（预留 1 列给省略号） */
function truncateToWidth(s: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (stringWidth(s) <= maxCols) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > maxCols - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** 读取合并生效的禁用列表（user + project 合并后的 settings.disabledSkills） */
function readEffectiveDisabled(): Set<string> {
  try {
    const list = getSettings().settings?.disabledSkills ?? [];
    return new Set(list.map((n) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

export const SkillsDialog: React.FC<SkillsDialogProps> = ({ onClose, registry }) => {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || DEFAULT_TERM_WIDTH;

  const [rows, setRows] = useState<SkillRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0); // toggle 后自增，触发禁用状态重算
  const [mode, setMode] = useState<Mode>("list");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [scope, setScope] = useState<Scope>("user");
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selected, setSelected] = useState<SkillRow | null>(null);

  // ── 加载全部 Skill（磁盘 + bundled，bundled 优先） ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const merged = new Map<string, SkillRow>();

      // bundled 优先（编译时内置，覆盖磁盘同名）
      try {
        for (const b of loadBundledSkills()) {
          const bp = b as {
            allowedTools?: string[];
            maxTurns?: number;
            timeoutMins?: number;
            context?: "inline" | "fork";
          };
          merged.set(b.name.toLowerCase(), {
            name: b.name,
            description: b.description ?? "",
            whenToUse: b.whenToUse,
            sourceKey: "bundled",
            type: bp.context === "inline" ? "inline" : "fork",
            argumentHint: b.argumentHint,
            allowedTools: bp.allowedTools,
            aliases: b.aliases,
            maxTurns: bp.maxTurns,
            timeoutMins: bp.timeoutMins,
            userInvocable: b.userInvocable !== false,
            modelInvocable: b.disableModelInvocation !== true,
            tokens: estimateSkillListingTokens({
              name: b.name,
              description: b.description ?? "",
              whenToUse: b.whenToUse,
            }),
          });
        }
      } catch {
        /* bundled 加载失败降级为无 */
      }

      // 磁盘 Skill（含禁用项）
      try {
        const mgr = new SkillManager();
        await mgr.discover(process.cwd());
        for (const s of mgr.getAllSkills()) {
          const key = s.name.toLowerCase();
          if (merged.has(key)) continue;
          const sourceKey =
            s.isBuiltin || s.loadedFrom === "builtin"
              ? "builtin"
              : s.source === "mcp"
                ? "mcp"
                : String(s.source);
          merged.set(key, {
            name: s.name,
            description: s.description ?? "",
            whenToUse: s.whenToUse,
            sourceKey,
            type: s.mode === "activate" || s.context === "inline" ? "inline" : "fork",
            argumentHint: s.argumentHint,
            allowedTools: s.allowedTools,
            filePath: s.filePath,
            version: s.version,
            model: s.model,
            effort: s.effort,
            agent: s.agent,
            maxTurns: s.maxTurns,
            timeoutMins: s.timeoutMins,
            argumentNames: s.argumentNames,
            paths: s.paths,
            hookEvents: s.hooks ? Object.keys(s.hooks) : undefined,
            userInvocable: s.userInvocable !== false,
            modelInvocable: s.disableModelInvocation !== true,
            prompt: s.prompt,
            promptLines: s.prompt ? s.prompt.split("\n").length : undefined,
            tokens: estimateSkillListingTokens({
              name: s.name,
              description: s.description ?? "",
              whenToUse: s.whenToUse,
            }),
          });
        }
      } catch {
        /* 磁盘扫描失败降级为仅 bundled */
      }

      if (!cancelled) {
        setRows([...merged.values()]);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 禁用状态（合并生效值），toggle 后随 version 重算
  const disabledSet = useMemo(() => readEffectiveDisabled(), [version]);

  const decorated = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        disabled: disabledSet.has(r.name.toLowerCase()),
      })),
    [rows, disabledSet],
  );

  const enabledCount = useMemo(
    () => decorated.filter((r) => !r.disabled).length,
    [decorated],
  );

  // 搜索过滤 + 排序
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = decorated;
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          sourceLabel(r.sourceKey).toLowerCase().includes(q) ||
          r.sourceKey.includes(q),
      );
    }
    return [...list].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "status") {
        if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
        return a.name.localeCompare(b.name);
      }
      // source
      const oa = SOURCE_ORDER[a.sourceKey] ?? 9;
      const ob = SOURCE_ORDER[b.sourceKey] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
  }, [decorated, query, sort]);

  // 过滤结果变化时把 activeIndex 夹紧到合法区间
  useEffect(() => {
    if (activeIndex > filtered.length - 1) {
      setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, activeIndex]);

  const safeIndex = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  // ── 启用/禁用切换 ──
  const toggle = useCallback(
    (row: SkillRow) => {
      const source = scope === "project" ? "projectSettings" : "userSettings";
      const { settings } = getSettingsForSource(source);
      const scopeList = settings?.disabledSkills ?? [];
      const inScope = scopeList.some(
        (n) => n.toLowerCase() === row.name.toLowerCase(),
      );
      const next = inScope
        ? scopeList.filter((n) => n.toLowerCase() !== row.name.toLowerCase())
        : [...scopeList, row.name];

      patchSettingsFile(source, "disabledSkills", next);

      // 热更命令注册表：用合并后的生效列表刷新，命令补全 / skill 工具同步
      try {
        const eff = getSettings().settings?.disabledSkills ?? [];
        registry.setDisabledSkills(eff);
      } catch {
        /* 注册表刷新失败不阻断面板 */
      }

      setVersion((v) => v + 1);
    },
    [scope, registry],
  );

  // ── 键盘调度 ──
  const moveUp = useCallback(() => {
    setActiveIndex((i) => {
      const n = i - 1;
      return n < 0 ? Math.max(0, filtered.length - 1) : n;
    });
  }, [filtered.length]);

  const moveDown = useCallback(() => {
    setActiveIndex((i) => (i + 1 >= filtered.length ? 0 : i + 1));
  }, [filtered.length]);

  useKeypress(KeypressPriority.Critical, (key: Key) => {
    // ── 详情态：Tab / Esc 返回列表 ──
    if (mode === "detail") {
      if (key.name === "escape" || key.name === "tab") {
        setMode("list");
        setSelected(null);
      }
      return true;
    }

    // ── 列表态（搜索框常驻，字母键进搜索框） ──

    // Esc：有查询先清空，否则关闭（渐进退出，不丢状态）
    if (key.name === "escape") {
      if (query) {
        setQuery("");
        setActiveIndex(0);
      } else {
        onClose();
      }
      return true;
    }

    // 导航
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      moveUp();
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      moveDown();
      return true;
    }

    // Enter：切换启用/禁用（主动作）
    if (key.name === "return" || key.name === "enter") {
      const row = filtered[safeIndex];
      if (row) toggle(row);
      return true;
    }

    // Tab：查看详情（字母键要留给搜索，详情移到 Tab）
    if (key.name === "tab") {
      const row = filtered[safeIndex];
      if (row) {
        setSelected(row);
        setMode("detail");
      }
      return true;
    }

    // Ctrl+S：切换排序（名称 / 状态 / 来源）
    if (key.ctrl && key.name === "s") {
      setSort((s) => SORT_CYCLE[(SORT_CYCLE.indexOf(s) + 1) % SORT_CYCLE.length]);
      return true;
    }
    // Ctrl+T：切换作用范围（全局=用户级 ⇄ 仅本项目=项目级）
    if (key.ctrl && key.name === "t") {
      setScope((s) => (s === "user" ? "project" : "user"));
      return true;
    }

    // 搜索框输入：backspace 删字，可打印字符入队，即时过滤
    if (key.name === "backspace" || key.name === "delete") {
      setQuery((q) => q.slice(0, -1));
      setActiveIndex(0);
      return true;
    }
    if (key.insertable && !key.ctrl && !key.alt && key.sequence) {
      setQuery((q) => q + key.sequence);
      setActiveIndex(0);
      return true;
    }

    return false;
  });

  // ── 详情视图 ──
  if (mode === "detail" && selected) {
    const isDisabled = disabledSet.has(selected.name.toLowerCase());
    // 元信息行的键值项（短值，标签定宽对齐成列，遵守 L2「对齐成列」）
    const sec = theme.text.secondary;
    const execLabel =
      selected.type === "inline" ? "inline（注入当前对话）" : "fork（子代理执行）";
    const metaRows: Array<{ label: string; node: React.ReactNode }> = [
      {
        label: "来源",
        node: <Text color={sourceColor(selected.sourceKey)}>{sourceLabel(selected.sourceKey)}</Text>,
      },
      { label: "执行", node: <Text color={sec}>{execLabel}</Text> },
      { label: "开销", node: <Text color={sec}>{tokLabel(selected.tokens)}</Text> },
    ];
    if (selected.model) metaRows.push({ label: "模型", node: <Text color={sec}>{selected.model}</Text> });
    if (selected.effort) metaRows.push({ label: "强度", node: <Text color={sec}>{selected.effort}</Text> });
    if (selected.agent) metaRows.push({ label: "代理", node: <Text color={sec}>{selected.agent}</Text> });
    // 轮次 / 超时仅 fork 模式有意义
    if (selected.type !== "inline" && selected.maxTurns != null)
      metaRows.push({ label: "轮次", node: <Text color={sec}>{`最多 ${selected.maxTurns} 轮`}</Text> });
    if (selected.type !== "inline" && selected.timeoutMins != null)
      metaRows.push({ label: "超时", node: <Text color={sec}>{`${selected.timeoutMins} 分钟`}</Text> });
    if (selected.argumentHint)
      metaRows.push({ label: "参数", node: <Text color={sec}>{selected.argumentHint}</Text> });
    if (selected.version)
      metaRows.push({ label: "版本", node: <Text color={sec}>{selected.version}</Text> });
    // 调用方式：谁能触发（用户 / 模型）
    const callers: string[] = [];
    if (selected.userInvocable !== false) callers.push("用户 /命令");
    if (selected.modelInvocable !== false) callers.push("模型自动");
    metaRows.push({
      label: "调用",
      node: <Text color={sec}>{callers.length ? callers.join(" · ") : "无（已限制）"}</Text>,
    });
    const metaLabelW = 4; // 两个中文字符宽 = 4 列，标签留白后接值

    // 提示词正文预览（仅磁盘 Skill 有静态正文）：去掉首尾空行后取前 N 行
    const promptBody = selected.prompt?.replace(/^\s+|\s+$/g, "") ?? "";
    const promptAllLines = promptBody ? promptBody.split("\n") : [];
    const promptPreview = promptAllLines.slice(0, PROMPT_PREVIEW_LINES);
    const promptRemaining = Math.max(0, promptAllLines.length - PROMPT_PREVIEW_LINES);

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={2} paddingY={1}>
        {/* 身份区：大号命令名 + 状态徽章，主色点睛（L2 排版表达状态） */}
        <Box>
          <Text bold color={theme.ui.active}>/{selected.name}</Text>
          <Text color={isDisabled ? theme.status.error : theme.status.success}>
            {"   "}
            {isDisabled ? ERROR_MARK : SUCCESS_MARK} {isDisabled ? "已禁用" : "已启用"}
          </Text>
        </Box>

        {/* 分隔留白 + 描述区（标签独占一行，正文缩进另起，杜绝「标签和正文黏一起」） */}
        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.text.secondary}>描述</Text>
          <Box paddingLeft={2}>
            <Text color={theme.text.primary} wrap="wrap">
              {selected.description || "（无）"}
            </Text>
          </Box>
        </Box>

        {selected.whenToUse && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.text.secondary}>何时使用</Text>
            <Box paddingLeft={2}>
              <Text color={theme.text.secondary} wrap="wrap">{selected.whenToUse}</Text>
            </Box>
          </Box>
        )}

        {/* 元信息区：短键值定宽对齐成列 */}
        <Box marginTop={1} flexDirection="column">
          {metaRows.map((r) => (
            <Box key={r.label} flexDirection="row">
              <Box width={metaLabelW} flexShrink={0}>
                <Text color={theme.text.secondary}>{r.label}</Text>
              </Box>
              <Text color={theme.text.secondary}>  </Text>
              {r.node}
            </Box>
          ))}
        </Box>

        {/* 可用工具（可能较长，标签独占一行 + 缩进） */}
        {selected.allowedTools && selected.allowedTools.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.text.secondary}>可用工具</Text>
            <Box paddingLeft={2}>
              <Text color={theme.text.secondary} wrap="wrap">{selected.allowedTools.join("、")}</Text>
            </Box>
          </Box>
        )}

        {/* 命名参数 $arg_name */}
        {selected.argumentNames && selected.argumentNames.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.text.secondary}>命名参数</Text>
            <Box paddingLeft={2}>
              <Text color={theme.text.secondary} wrap="wrap">
                {selected.argumentNames.map((n) => `$${n}`).join("、")}
              </Text>
            </Box>
          </Box>
        )}

        {/* 条件激活路径（glob）：只在操作匹配文件时自动激活 */}
        {selected.paths && selected.paths.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.text.secondary}>激活路径</Text>
            <Box paddingLeft={2}>
              <Text color={theme.text.secondary} wrap="wrap">{selected.paths.join("、")}</Text>
            </Box>
          </Box>
        )}

        {/* 生命周期钩子（按事件名） */}
        {selected.hookEvents && selected.hookEvents.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.text.secondary}>钩子</Text>
            <Box paddingLeft={2}>
              <Text color={theme.text.secondary} wrap="wrap">{selected.hookEvents.join("、")}</Text>
            </Box>
          </Box>
        )}

        {/* 提示词正文预览（折叠前 N 行；bundled 动态生成无静态正文，不显示） */}
        {promptPreview.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.text.secondary}>
              提示词预览
              <Text>
                {"  "}（共 {selected.promptLines ?? promptAllLines.length} 行）
              </Text>
            </Text>
            <Box paddingLeft={2} flexDirection="column">
              {promptPreview.map((line, i) => (
                <Text key={i} color={theme.text.secondary} wrap="truncate-end">
                  {line || " "}
                </Text>
              ))}
              {promptRemaining > 0 && (
                <Text italic>… 还有 {promptRemaining} 行（见文件）</Text>
              )}
            </Box>
          </Box>
        )}

        {/* 路径（长路径，弱化为暗色，单独一行截断） */}
        {selected.filePath && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={theme.text.secondary}>路径</Text>
            <Box paddingLeft={2}>
              <Text wrap="truncate-middle">{selected.filePath}</Text>
            </Box>
          </Box>
        )}

        <Box marginTop={1}>
          <Text italic>Tab / Esc 返回列表</Text>
        </Box>
      </Box>
    );
  }

  // ── 列表视图 ──
  // 滚动偏移（对齐 BaseSelectionList 逻辑）
  let effectiveScroll = scrollOffset;
  if (safeIndex < effectiveScroll) {
    effectiveScroll = safeIndex;
  } else if (safeIndex >= effectiveScroll + MAX_ROWS) {
    effectiveScroll = Math.max(0, Math.min(safeIndex - MAX_ROWS + 1, filtered.length - MAX_ROWS));
  }
  if (effectiveScroll !== scrollOffset) {
    setScrollOffset(effectiveScroll);
  }
  const visible = filtered.slice(effectiveScroll, effectiveScroll + MAX_ROWS);

  // 描述可用列宽 = 终端宽 - 边框/内边距 - 指针 - 状态 - 名称列 - 徽章 - token
  const descWidth = Math.max(
    12,
    termWidth - 2 /*border*/ - 2 /*padX*/ - 2 /*指针*/ - 2 /*状态*/ - (NAME_COL + 1) - 8 /*徽章*/ - 12 /*tok*/ - 2,
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.ui.active} paddingX={1} paddingY={0}>
      {/* 标题行 */}
      <Box>
        <Text bold color={theme.text.accent}>Skills</Text>
        <Text color={theme.text.secondary}>
          {"  "}· {enabledCount}/{decorated.length} 已启用 · 排序 {SORT_LABEL[sort]} · 作用范围 {scope === "user" ? "全局" : "仅本项目"}
        </Text>
      </Box>

      {/* 搜索行（常驻）：可输入的信号靠 ⌕ 字形 + 光标块传达，不再套第二层边框——
          面板本身已有 round 容器，再包一层就是 L2.2 禁止的「盒子套盒子」。 */}
      <Box marginTop={1}>
        <Text color={theme.ui.symbol}>{SEARCH_MARK} </Text>
        {query ? (
          <Text color={theme.text.primary}>{query}</Text>
        ) : (
          <Text color={theme.text.secondary}>输入以搜索…</Text>
        )}
        <Text color={theme.ui.active}>▏</Text>
      </Box>

      {/* 列表 */}
      {!loaded ? (
        <Box marginTop={1}><Text color={theme.text.secondary}>加载中…</Text></Box>
      ) : filtered.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{query ? "无匹配的 Skill" : "暂无可用 Skill"}</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {visible.map((row, i) => {
            const idx = effectiveScroll + i;
            const isSel = idx === safeIndex;
            const nameCell = padEndWidth(truncateToWidth(row.name, NAME_COL), NAME_COL);
            const nameColor = row.disabled
              ? theme.text.secondary
              : isSel
                ? theme.ui.focus
                : theme.text.primary;
            return (
              <Box key={row.name} flexDirection="row">
                <Box width={2} flexShrink={0}>
                  <Text color={theme.ui.focus}>{isSel ? POINTER : " "}</Text>
                </Box>
                <Box width={2} flexShrink={0}>
                  <Text color={row.disabled ? theme.status.error : theme.status.success}>
                    {row.disabled ? ERROR_MARK : SUCCESS_MARK}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text color={nameColor} bold={isSel} strikethrough={row.disabled}>
                    /{nameCell}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text color={sourceColor(row.sourceKey)}> [{sourceLabel(row.sourceKey)}]</Text>
                </Box>
                <Box flexShrink={0}>
                  <Text color={theme.text.secondary}>{" "}{padEndWidth(tokLabel(row.tokens), 9)}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={theme.text.secondary}>{truncateToWidth(row.description, descWidth)}</Text>
                </Box>
              </Box>
            );
          })}
          {filtered.length > MAX_ROWS && (
            <Text color={theme.text.secondary}>
              {"  "}… 共 {filtered.length} 项，滚动查看更多
            </Text>
          )}
        </Box>
      )}

      {/* 底部 hint（常驻，对标 resume：输入即过滤，动作在非字母键） */}
      <Box marginTop={1}>
        <Text italic>
          输入过滤 · ↑↓ 选择 · Enter 启/禁 · Tab 详情 · Ctrl+S 排序 · Ctrl+T 作用范围 · Esc {query ? "清除" : "关闭"}
        </Text>
      </Box>
    </Box>
  );
};
