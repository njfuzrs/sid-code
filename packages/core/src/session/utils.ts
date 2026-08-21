/**
 * 会话工具函数
 * 提供搜索、排序、过滤等功能
 */

import type { Message } from "../llm/types.ts";
import { stripDateSuffix } from "../llm/model-name-normalize.ts";
import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import type { SessionData } from "./store.ts";
import { parseSessionJsonl, flushPendingSessionWrites, listAllSessionDirs } from "./store.ts";
import { sidPaths } from "../config/paths.ts";

/** 文本匹配结果 */
export interface TextMatch {
  /** 匹配前的文本 */
  before: string;
  /** 匹配的文本 */
  match: string;
  /** 匹配后的文本 */
  after: string;
  /** 消息角色 */
  role: "user" | "assistant";
}

/** 会话信息（用于列表展示） */
export interface SessionInfo {
  /** 会话 ID */
  id: string;
  /** 文件名（不含扩展名） */
  file: string;
  /** 完整文件名 */
  fileName: string;
  /** 开始时间（ISO） */
  startTime: string;
  /** 最后更新时间（ISO） */
  lastUpdated: string;
  /** 消息数 */
  messageCount: number;
  /** 显示名称 */
  displayName: string;
  /** 首条用户消息 */
  firstUserMessage: string;
  /** 是否当前会话 */
  isCurrentSession: boolean;
  /** 列表索引（1-based） */
  index: number;
  /** AI 摘要 */
  summary?: string;
  /** 完整内容（按需加载） */
  fullContent?: string;
  /** 消息列表（按需加载） */
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 搜索匹配片段 */
  matchSnippets?: TextMatch[];
  /** 匹配数量 */
  matchCount?: number;
  /** 会话工作目录（取 directories[0]，用于元信息行展示项目路径） */
  cwd?: string;
  /** 会话使用的模型（取自 session_start.model），用于元信息行展示 */
  model?: string;
  /** P0-1：会话文件所在目录的绝对路径（按项目分目录后，删除/定位必须用它而非根目录 join）。 */
  dirPath?: string;
}

/** 会话文件条目 */
export interface SessionFileEntry {
  /** 完整文件名 */
  fileName: string;
  /** P0-1：文件所在目录绝对路径（跨项目扫描时各条目可能来自不同项目子目录）。 */
  dirPath: string;
  /** 会话信息（损坏文件为 null） */
  sessionInfo: SessionInfo | null;
}

/** 获取会话选项 */
export interface GetSessionOptions {
  /** 是否加载完整内容（用于搜索） */
  includeFullContent?: boolean;
}

/**
 * 清理消息内容
 * 去除换行、空白、不可打印字符
 */
export function cleanMessage(message: string): string {
  return message
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\u4e00-\u9fa5]+/g, "") // 保留 ASCII 和中文
    .trim();
}

/**
 * 提取首条用户消息
 */
export function extractFirstUserMessage(messages: Message[]): string {
  // 过滤掉斜杠命令
  const userMessage = messages
    .filter((msg) => {
      const content = getMessageContent(msg);
      return !content.startsWith("/") && !content.startsWith("?") && content.trim().length > 0;
    })
    .find((msg) => msg.role === "user");

  let content: string;

  if (!userMessage) {
    // 回退到第一条用户消息（即使是斜杠命令）
    const firstMsg = messages.find((msg) => msg.role === "user");
    if (!firstMsg) return "空对话";
    content = cleanMessage(getMessageContent(firstMsg));
  } else {
    content = cleanMessage(getMessageContent(userMessage));
  }

  return content;
}

/**
 * 获取消息内容字符串
 */
function getMessageContent(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        // `"text" in block` 已覆盖 TextBlock；余下成员（tool_use / tool_result /
        // thinking / redacted_thinking）都不带 type: "text"，原先那条
        // `block.type === "text"` 兜底是死分支。
        if ("text" in block) return block.text;
        return "";
      })
      .join(" ");
  }
  return "";
}

/**
 * 格式化相对时间
 */
export function formatRelativeTime(timestamp: string, style: "long" | "short" = "long"): string {
  const now = new Date();
  const time = new Date(timestamp);
  const diffMs = now.getTime() - time.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (style === "short") {
    if (diffSeconds < 1) return "now";
    if (diffSeconds < 60) return `${diffSeconds}s`;
    if (diffMinutes < 60) return `${diffMinutes}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 30) return `${diffDays}d`;
    const diffMonths = Math.floor(diffDays / 30);
    return diffMonths < 12 ? `${diffMonths}mo` : `${Math.floor(diffMonths / 12)}y`;
  } else {
    if (diffDays > 0) {
      return `${diffDays} 天前`;
    } else if (diffHours > 0) {
      return `${diffHours} 小时前`;
    } else if (diffMinutes > 0) {
      return `${diffMinutes} 分钟前`;
    } else {
      return "刚刚";
    }
  }
}

/**
 * 格式化为北京时间（UTC+8）的具体日期时间，用于会话列表定位。
 * 输出形如 "07-15 14:32"（同年省略年份）或 "2025-12-30 09:05"（跨年补年份）。
 * 用固定 +8 偏移手工换算，不依赖运行环境时区，保证任何机器上都显示北京时间。
 */
export function formatAbsoluteTime(timestamp: string): string {
  const time = new Date(timestamp);
  if (isNaN(time.getTime())) return "";
  // 转成北京时间：UTC 毫秒 + 8h，再用 getUTC* 取“北京墙上时间”各字段。
  const bj = new Date(time.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = bj.getUTCFullYear();
  const month = pad(bj.getUTCMonth() + 1);
  const day = pad(bj.getUTCDate());
  const hour = pad(bj.getUTCHours());
  const minute = pad(bj.getUTCMinutes());
  const nowYear = new Date().getUTCFullYear();
  const datePart = year === nowYear ? `${month}-${day}` : `${year}-${month}-${day}`;
  return `${datePart} ${hour}:${minute}`;
}

/**
 * 把模型 ID 缩短为可读短名，用于列表元信息行。
 * 去掉 provider 前缀与常见冗余后缀（日期戳、[1m]、括号说明），过长再截断。
 *
 * ⚠ 日期后缀走 `stripDateSuffix`（`llm/model-name-normalize.ts`），不要在这里重写正则。
 * 这里原先是 `/-\d{8}$/` + `/-\d{4}-\d{2}-\d{2}$/` 两条，**缺 6 位（YYMMDD）那一支**，
 * 于是 `doubao-seed-1-8-251228` 这类国内厂商命名在会话列表里不会被缩短 —— 一处纯显示的
 * 漂移，但它与查询链路上那处真正会借错值的漂移是同一个成因（同一条规则被写了三遍）。
 * 复用共享函数后长度判据只有一处，改一次三处同步。
 */
export function shortenModel(model: string | undefined): string {
  if (!model) return "";
  let m = model.trim();
  // 去掉 provider 前缀（如 "anthropic/claude-..." / "openai:gpt-..."）
  m = m.replace(/^[^/:]+[/:]/, "");
  // 去掉尾部 [1m]、(xxx) 之类修饰
  m = m.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/\s*\([^)]*\)\s*$/, "");
  // 去掉结尾的日期戳（-YYMMDD / -YYYYMMDD / -YYYY-MM-DD，判据与采集/查询两侧同源）
  m = stripDateSuffix(m);
  if (m.length > 28) m = m.slice(0, 27) + "…";
  return m;
}

/** 扫描单个会话目录，返回其中所有会话文件条目（不递归子目录，summaries/ 由调用方排除）。 */
async function scanSessionDir(
  sessionDir: string,
  currentSessionId?: string,
  options: GetSessionOptions = {},
): Promise<SessionFileEntry[]> {
  if (!existsSync(sessionDir)) return [];

  // 同时扫描旧 JSON 与新 JSONL 两种格式（Bug1：此前只扫 .json，
  // 导致已迁移到 jsonl 的会话在列表/清理中完全不可见）。
  const files = readdirSync(sessionDir)
    .filter((f) => (f.endsWith(".json") || f.endsWith(".jsonl")) && !f.startsWith("."))
    .sort();

  const sessionPromises = files.map(async (file): Promise<SessionFileEntry> => {
    const filePath = join(sessionDir, file);
    try {
      // 目录项可能是子目录（如 summaries/ 已被上面过滤，但防御性再判一次）。
      if (!statSync(filePath).isFile()) {
        return { fileName: file, dirPath: sessionDir, sessionInfo: null };
      }
      const content = await Bun.file(filePath).text();
      // jsonl 是多行事件流，不能用 JSON.parse 整体解析——走逐行解析器。
      const data = file.endsWith(".jsonl")
        ? parseSessionJsonl(content)
        : (JSON.parse(content) as SessionData);

      // 验证必需字段
      if (
        !data ||
        !data.id ||
        !data.messages ||
        !Array.isArray(data.messages) ||
        !data.createdAt ||
        !data.updatedAt
      ) {
        return { fileName: file, dirPath: sessionDir, sessionInfo: null };
      }

      // 跳过空会话（只有系统消息）
      const hasUserOrAssistant = data.messages.some(
        (msg) => msg.role === "user" || msg.role === "assistant",
      );
      if (!hasUserOrAssistant) {
        return { fileName: file, dirPath: sessionDir, sessionInfo: null };
      }

      // 跳过子代理会话
      if (data.kind === "subagent") {
        return { fileName: file, dirPath: sessionDir, sessionInfo: null };
      }

      const firstUserMessage = extractFirstUserMessage(data.messages);
      // 是否当前会话：按解析出的 data.id 精确相等判断。
      // 旧实现 file.includes(currentSessionId.slice(0,8)) 依赖「id 恒为 8 位 hex」，
      // 新 id 格式为 YYYYMMDD-HHMMSS-<hex>，截前 8 位会得到日期串（如 20260627）
      // 从而把「同一天的所有会话」全部误判为当前会话。改用 id 相等彻底规避。
      const isCurrentSession = currentSessionId ? data.id === currentSessionId : false;

      let fullContent: string | undefined;
      let messages: Array<{ role: "user" | "assistant"; content: string }> | undefined;

      if (options.includeFullContent) {
        fullContent = data.messages.map((msg) => getMessageContent(msg)).join(" ");
        messages = data.messages.map((msg) => ({
          role: msg.role === "user" ? ("user" as const) : ("assistant" as const),
          content: getMessageContent(msg),
        }));
      }

      const sessionInfo: SessionInfo = {
        id: data.id,
        file: file.replace(/\.(json|jsonl)$/, ""),
        fileName: file,
        startTime: data.createdAt,
        lastUpdated: data.updatedAt,
        messageCount: data.messages.length,
        // P2-5：用户经 --name/-n 指定的显示名（session_name 元数据）优先，其次摘要，最后首条用户消息。
        displayName:
          (typeof data.metadata?.session_name === "string" && data.metadata.session_name.trim()
            ? data.metadata.session_name
            : undefined) ||
          data.summary ||
          firstUserMessage,
        firstUserMessage,
        isCurrentSession,
        index: 0, // 排序后设置
        summary: data.summary,
        fullContent,
        messages,
        // 优先 session_start.cwd（几乎所有会话都有），退回 directories[0]（早期少数会话）
        cwd: data.cwd || data.directories?.[0],
        model: data.model || undefined,
        dirPath: sessionDir,
      };

      return { fileName: file, dirPath: sessionDir, sessionInfo };
    } catch {
      // 文件损坏
      return { fileName: file, dirPath: sessionDir, sessionInfo: null };
    }
  });

  return Promise.all(sessionPromises);
}

/**
 * 加载会话文件（包括损坏文件）。
 *
 * P0-1：会话已按项目物理分目录（sessions/<projectKey>/）。此函数的语义是「全局视图」——
 * 当传入的 sessionDir 是 sessions 根目录时，跨所有项目子目录聚合扫描（供 --list-sessions /
 * 选择器「全部项目」默认视图 / cleanup 使用）；当传入的是某个具体项目子目录时，只扫该目录。
 * 判定方式：sessionDir === sidPaths.sessions() 视为全局根。
 */
export async function getAllSessionFiles(
  sessionDir: string,
  currentSessionId?: string,
  options: GetSessionOptions = {},
): Promise<SessionFileEntry[]> {
  try {
    // P0-3：SessionStore 写入已改为缓冲批量落盘（100ms 窗口），直接读文件系统可能
    // 读到落后于内存状态的内容——扫描前先把所有会话的待写入缓冲同步落盘。
    flushPendingSessionWrites();

    const isGlobalRoot = sessionDir === sidPaths.sessions();
    const dirs = isGlobalRoot ? listAllSessionDirs() : [sessionDir];

    const perDir = await Promise.all(dirs.map((d) => scanSessionDir(d, currentSessionId, options)));
    return perDir.flat();
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * 加载所有有效会话文件
 */
export async function getSessionFiles(
  sessionDir: string,
  currentSessionId?: string,
  options: GetSessionOptions = {},
): Promise<SessionInfo[]> {
  const allFiles = await getAllSessionFiles(sessionDir, currentSessionId, options);

  // 过滤损坏文件
  const validSessions = allFiles
    .filter(
      (entry): entry is SessionFileEntry & { sessionInfo: SessionInfo } =>
        entry.sessionInfo !== null,
    )
    .map((entry) => entry.sessionInfo);

  // 去重（按 ID）
  const uniqueSessionsMap = new Map<string, SessionInfo>();
  for (const session of validSessions) {
    if (
      !uniqueSessionsMap.has(session.id) ||
      new Date(session.lastUpdated).getTime() >
        new Date(uniqueSessionsMap.get(session.id)!.lastUpdated).getTime()
    ) {
      uniqueSessionsMap.set(session.id, session);
    }
  }
  const uniqueSessions = Array.from(uniqueSessionsMap.values());

  // 按开始时间排序（最旧的在前）
  uniqueSessions.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  // 设置索引（1-based）
  uniqueSessions.forEach((session, index) => {
    session.index = index + 1;
  });

  return uniqueSessions;
}

/**
 * 查找文本匹配
 */
export function findTextMatches(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  query: string,
): TextMatch[] {
  const matches: TextMatch[] = [];
  const lowerQuery = query.toLowerCase();
  const contextLength = 40; // 前后各 40 字符

  for (const msg of messages) {
    const content = cleanMessage(msg.content);
    const lowerContent = content.toLowerCase();
    let startIndex = 0;

    while (true) {
      const matchIndex = lowerContent.indexOf(lowerQuery, startIndex);
      if (matchIndex === -1) break;

      const beforeStart = Math.max(0, matchIndex - contextLength);
      const afterEnd = Math.min(content.length, matchIndex + query.length + contextLength);

      const before = (beforeStart > 0 ? "..." : "") + content.slice(beforeStart, matchIndex);
      const match = content.slice(matchIndex, matchIndex + query.length);
      const after =
        content.slice(matchIndex + query.length, afterEnd) +
        (afterEnd < content.length ? "..." : "");

      matches.push({
        before,
        match,
        after,
        role: msg.role,
      });

      startIndex = matchIndex + query.length;
    }
  }

  return matches;
}

/**
 * 过滤会话
 */
export function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
  if (!query.trim()) {
    return sessions;
  }

  const lowerQuery = query.toLowerCase();

  return sessions
    .map((session) => {
      // 搜索范围：标题、ID、首条消息
      const searchableText = [session.displayName, session.id, session.firstUserMessage]
        .join(" ")
        .toLowerCase();

      if (searchableText.includes(lowerQuery)) {
        // 如果有完整内容，查找匹配片段
        if (session.messages) {
          const matches = findTextMatches(session.messages, query);
          return {
            ...session,
            matchSnippets: matches.slice(0, 3), // 最多 3 个片段
            matchCount: matches.length,
          };
        }
        return session;
      }

      return null;
    })
    .filter((s): s is SessionInfo => s !== null);
}

/**
 * 排序会话
 */
export function sortSessions(
  sessions: SessionInfo[],
  sortOrder: "date" | "messages" | "name",
  reverse: boolean,
): SessionInfo[] {
  const sorted = [...sessions];

  switch (sortOrder) {
    case "date":
      sorted.sort((a, b) => new Date(a.lastUpdated).getTime() - new Date(b.lastUpdated).getTime());
      break;
    case "messages":
      sorted.sort((a, b) => a.messageCount - b.messageCount);
      break;
    case "name":
      sorted.sort((a, b) => a.displayName.localeCompare(b.displayName));
      break;
  }

  if (reverse) {
    sorted.reverse();
  }

  return sorted;
}

/**
 * 会话选择器
 */
export class SessionSelector {
  constructor(private sessionDir: string) {}

  /** 列出所有会话 */
  async listSessions(): Promise<SessionInfo[]> {
    return getSessionFiles(this.sessionDir);
  }

  /** 查找会话（按 ID 或索引） */
  async findSession(identifier: string): Promise<SessionInfo> {
    const trimmed = identifier.trim();
    const sessions = await this.listSessions();

    if (sessions.length === 0) {
      throw new Error("未找到任何会话");
    }

    // 按开始时间排序
    const sorted = sessions.sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );

    // 尝试按 UUID 查找
    const byUuid = sorted.find((s) => s.id === trimmed);
    if (byUuid) return byUuid;

    // 尝试按索引查找（1-based）
    const index = parseInt(trimmed, 10);
    if (!isNaN(index) && index.toString() === trimmed && index > 0 && index <= sorted.length) {
      return sorted[index - 1];
    }

    throw new Error(`无效的会话标识符: ${trimmed}`);
  }

  /** 解析会话参数（latest / ID / 索引） */
  async resolveSession(resumeArg: string): Promise<SessionInfo> {
    const trimmed = resumeArg.trim();

    if (trimmed === "latest") {
      const sessions = await this.listSessions();
      if (sessions.length === 0) {
        throw new Error("未找到任何会话");
      }
      sessions.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
      return sessions[sessions.length - 1];
    }

    return this.findSession(trimmed);
  }
}
