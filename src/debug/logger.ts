/**
 * 调试日志系统
 * 支持分级日志、文件输出、格式化输出
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, appendFileSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { maskSensitiveData } from '../permission/sensitive.ts';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export interface LoggerOptions {
  enabled: boolean;
  level: LogLevel;
  logFile?: string;
  console: boolean;
  fileOnly: boolean;
  /** 静默的日志分类（支持前缀匹配，如 "UI:MD" 会匹配 "UI:MD" 分类） */
  mutedCategories?: string[];
  /** 是否同时输出 JSON Lines 格式的结构化日志 */
  jsonLog?: boolean;
  /** JSON Lines 日志文件路径（默认在 logFile 同目录下 .jsonl 后缀） */
  jsonLogFile?: string;
  /** 追加模式写入（审计日志跨会话累积用，默认 false=覆盖） */
  append?: boolean;
}

// ANSI 颜色码
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// 级别 → 颜色 + 图标
const LEVEL_STYLE: Record<number, { color: string; icon: string }> = {
  [LogLevel.ERROR]: { color: C.red, icon: '✗' },
  [LogLevel.WARN]:  { color: C.yellow, icon: '⚠' },
  [LogLevel.INFO]:  { color: C.cyan, icon: '●' },
  [LogLevel.DEBUG]: { color: C.gray, icon: '·' },
};

// 分类 → 颜色（高频分类做区分，其余用默认色）
const CAT_COLOR: Record<string, string> = {
  LLM: C.cyan + C.bold,
  TOOL: C.yellow,
  AGENT: C.green,
  PERMISSION: '\x1b[35m', // magenta
  HOOK: C.dim,
  CONFIG: C.dim,
  STREAM: C.gray,
};

// 结构化日志条目
interface LogEntry {
  ts: string;        // ISO 8601 时间戳
  level: string;     // ERROR/WARN/INFO/DEBUG
  cat: string;       // 分类
  msg: string;       // 消息
  data?: unknown;    // 附加数据（已脱敏）
}

class Logger {
  private options: LoggerOptions;
  private logFilePath?: string;
  private logStream?: WriteStream;
  private jsonLogPath?: string;
  private jsonStream?: WriteStream;
  private readonly maxLogSize = 10 * 1024 * 1024; // 10MB
  private currentLogSize = 0;
  /** 缺口 7：per-session WARN/ERROR 日志路径（由 collector 注入） */
  private sessionWarnLogPath?: string;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = Logger.normalizeOptions(options);
    this.setupStreams();
  }

  /** 把外部传入的部分配置补全为完整 LoggerOptions（构造与 reconfigure 共用，避免两处默认值漂移）。 */
  private static normalizeOptions(options: Partial<LoggerOptions>): LoggerOptions {
    return {
      enabled: options.enabled ?? false,
      level: options.level ?? LogLevel.INFO,
      console: options.console ?? true,
      fileOnly: options.fileOnly ?? false,
      logFile: options.logFile,
      mutedCategories: options.mutedCategories,
      jsonLog: options.jsonLog ?? false,
      jsonLogFile: options.jsonLogFile,
      append: options.append ?? false,
    };
  }

  /**
   * 按当前 options 打开日志文件流（幂等：先关旧流再开新流）。
   * 从构造器抽出，供 reconfigure 复用——这是 initLogger 能「原地换配置」而不必换实例的前提。
   */
  private setupStreams(): void {
    // 关掉可能存在的旧流（reconfigure 路径），避免句柄泄漏与两个流写同一文件。
    if (this.logStream) {
      this.logStream.end();
      this.logStream = undefined;
    }
    if (this.jsonStream) {
      this.jsonStream.end();
      this.jsonStream = undefined;
    }
    this.logFilePath = undefined;
    this.jsonLogPath = undefined;
    this.currentLogSize = 0;

    if (this.options.enabled && this.options.logFile) {
      this.logFilePath = this.options.logFile.startsWith('~')
        ? join(homedir(), this.options.logFile.slice(1))
        : this.options.logFile;

      // 确保日志目录存在
      const logDir = join(this.logFilePath, '..');
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      // 改用 WriteStream 异步写入（审计模式 append 跨会话累积，debug 模式 w 覆盖）
      this.logStream = createWriteStream(this.logFilePath, { flags: this.options.append ? 'a' : 'w' });
      this.logStream.on('error', () => {}); // 静默错误

      // 写入头部
      const header = `${'─'.repeat(60)}\n SID-CODE DEBUG LOG  ${new Date().toLocaleString('zh-CN')}\n${'─'.repeat(60)}\n\n`;
      this.logStream.write(header);

      // append 模式必须用**既有文件大小**作为起点，否则轮转永不触发：
      // 跨会话累积时单次会话写不满 maxLogSize，而 currentLogSize 每次启动都从
      // header 字节数重新计数 → `currentLogSize >= maxLogSize` 永远撞不到。
      // 实测后果：用户 audit.log 长到 104MB 且 audit.log.1 从未生成。
      let existingSize = 0;
      if (this.options.append) {
        try {
          existingSize = statSync(this.logFilePath).size;
        } catch {
          // 文件不存在（首次创建）或 stat 失败 → 从 0 起算，退化为原行为
        }
      }
      this.currentLogSize = existingSize + Buffer.byteLength(header);

      // JSON Lines 输出
      if (this.options.jsonLog) {
        this.jsonLogPath = this.options.jsonLogFile ?? this.logFilePath.replace(/\.log$/, '.jsonl');
        this.jsonStream = createWriteStream(this.jsonLogPath, { flags: 'w' });
        this.jsonStream.on('error', () => {});
      }
    }
  }

  private formatMessage(level: LogLevel, category: string, message: string, data?: unknown): string {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    const style = LEVEL_STYLE[level] ?? LEVEL_STYLE[LogLevel.DEBUG];
    const catColor = CAT_COLOR[category] ?? C.dim;

    // 格式: [HH:MM:SS] ● [CATEGORY] 消息
    let line = `${C.gray}[${time}]${C.reset} ${style.color}${style.icon}${C.reset} ${catColor}[${category}]${C.reset} ${message}`;

    if (data !== undefined) {
      const dataStr = this.formatData(data);
      // 数据紧凑放在同一行（短数据）或换行缩进（长数据）
      if (dataStr.length < 120 && !dataStr.includes('\n')) {
        line += ` ${C.dim}${dataStr}${C.reset}`;
      } else {
        line += `\n${C.dim}  ${dataStr.split('\n').join('\n  ')}${C.reset}`;
      }
    }

    return line;
  }

  private formatData(data: unknown): string {
    if (typeof data === 'string') {
      return maskSensitiveData(data);
    }

    try {
      const json = JSON.stringify(data, this.sensitiveReplacer, 2);
      return maskSensitiveData(json);
    } catch (err) {
      return maskSensitiveData(String(data));
    }
  }

  /** 替换敏感字段（API Key 等） */
  private sensitiveReplacer(key: string, value: unknown): unknown {
    const sensitiveKeys = ['anthropicKey', 'openaiKey', 'apiKey', 'api_key', 'token', 'secret'];
    if (typeof value === 'string' && sensitiveKeys.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
      if (value.length > 8) {
        return value.slice(0, 4) + '****' + value.slice(-4);
      }
      return '****';
    }
    return value;
  }

  /** 去除 ANSI 转义码 */
  private stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private writeToFile(message: string): void {
    if (!this.logStream || this.logStream.destroyed) return;

    const data = this.stripAnsi(message) + '\n';
    this.currentLogSize += Buffer.byteLength(data);
    this.logStream.write(data);

    // 超过大小限制时轮转
    if (this.currentLogSize >= this.maxLogSize) {
      this.rotate();
    }
  }

  private rotate(): void {
    if (!this.logFilePath || !this.logStream) return;

    // 关闭当前流
    this.logStream.end();

    // 重命名旧文件（只保留 1 个备份）
    const backupPath = this.logFilePath + '.1';
    try {
      if (existsSync(backupPath)) unlinkSync(backupPath);
      if (existsSync(this.logFilePath)) renameSync(this.logFilePath, backupPath);
    } catch {}

    // 创建新流
    this.logStream = createWriteStream(this.logFilePath, { flags: 'w' });
    this.logStream.on('error', () => {});
    this.currentLogSize = 0;

    const header = `${'─'.repeat(60)}\n SID-CODE DEBUG LOG (轮转) ${new Date().toLocaleString('zh-CN')}\n${'─'.repeat(60)}\n\n`;
    this.logStream.write(header);
    this.currentLogSize = Buffer.byteLength(header);

    // JSON 日志也轮转
    if (this.jsonStream && this.jsonLogPath) {
      this.jsonStream.end();
      const jsonBackup = this.jsonLogPath + '.1';
      try {
        if (existsSync(jsonBackup)) unlinkSync(jsonBackup);
        if (existsSync(this.jsonLogPath)) renameSync(this.jsonLogPath, jsonBackup);
      } catch {}
      this.jsonStream = createWriteStream(this.jsonLogPath, { flags: 'w' });
      this.jsonStream.on('error', () => {});
    }
  }

  private writeToConsole(level: LogLevel, message: string): void {
    if (!this.options.console) return;
    // message 已包含 ANSI 颜色
    if (level === LogLevel.ERROR) {
      console.error(message);
    } else {
      console.log(message);
    }
  }

  private log(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (!this.options.enabled) {
      // OBSERV-4：enabled=false 时也不能静默吞掉 ERROR/WARN——否则生产环境
      // （未开 --debug、audit:false、或 initLogger 之前 getLogger() 兜底实例的早期错误）
      // 关键错误将无任何留痕。此处兜底把 ERROR/WARN 输出到 stderr：
      //   - 走 stderr 而非 stdout，不污染无头模式的结构化输出，也不破坏 TUI 的 Ink 主屏（用 stdout）；
      //   - 测试环境（NODE_ENV=test）跳过，避免污染单测输出；
      //   - WARN 仍尊重 mutedCategories，ERROR 始终输出。
      if (level <= LogLevel.WARN && process.env.NODE_ENV !== "test") {
        if (level === LogLevel.WARN && this.isMuted(category)) return;
        const formatted = this.formatMessage(level, category, message, data);
        process.stderr.write(this.stripAnsi(formatted) + "\n");
      }
      return;
    }

    // 静默分类过滤（ERROR 级别不受影响，始终输出）
    if (level > LogLevel.ERROR && this.isMuted(category)) return;

    const formatted = this.formatMessage(level, category, message, data);

    // 落盘级别门控：文件与控制台统一尊重 options.level。
    //
    // 原先此处无条件落盘（注释自称「文件始终写入所有级别，确保完整信息」），使 level
    // 只门控控制台。审计模式（cli.ts:995，level=WARN）复用同一落盘路径，于是 level
    // 形同虚设——实测真实 audit.log 中 DEBUG 占 90.7% / INFO 占 8.1%，应落盘 1.2MB
    // 实际 104MB（写放大 87 倍）。
    //
    // 为何这样改是安全的：debugLevel 默认为 "DEBUG"（config.ts:749，cli.ts:973 二次兜底），
    // 该取值下此门控是**恒等变换**，--debug 用户不丢任何现场。只有显式传
    // --debug-level INFO/WARN/ERROR 才会过滤，而这正是该 flag 承诺的语义（help.ts:90）。
    //
    // 注意：必须门控在 writeToFile 这一处，不能提前 return——下方 per-session warn.log
    // 与 jsonLog 是**独立 sink**，各有自己的级别语义，连带阻断会造成新的现场缺失。
    if (level <= this.options.level) {
      this.writeToFile(formatted);
    }

    // 缺口 7：WARN/ERROR 级别同步追加到 per-session warn.log（不被后续会话覆盖）
    if (level <= LogLevel.WARN && this.sessionWarnLogPath) {
      try {
        const ts = new Date().toISOString();
        const levelName = level === LogLevel.ERROR ? "ERROR" : "WARN";
        const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : "";
        appendFileSync(
          this.sessionWarnLogPath,
          `[${ts}] [${levelName}] [${category}] ${message}${dataStr}\n`,
        );
      } catch { /* per-session 日志写入失败静默 */ }
    }

    // JSON Lines 输出
    this.logJson(level, category, message, data);

    // 控制台输出受 level 过滤（fileOnly 模式下不输出到控制台）
    if (!this.options.fileOnly && level <= this.options.level) {
      this.writeToConsole(level, formatted);
    }
  }

  private logJson(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (!this.jsonStream || this.jsonStream.destroyed) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level: LogLevel[level],
      cat: category,
      msg: message,
    };

    if (data !== undefined) {
      entry.data = JSON.parse(JSON.stringify(data, this.sensitiveReplacer));
    }

    this.jsonStream.write(JSON.stringify(entry) + '\n');
  }

  /** 检查分类是否被静默 */
  private isMuted(category: string): boolean {
    const muted = this.options.mutedCategories;
    if (!muted || muted.length === 0) return false;
    return muted.some(m => category === m || category.startsWith(m + ':'));
  }

  /** 切换为仅文件输出模式（TUI 模式下使用） */
  setFileOnly(fileOnly: boolean): void {
    this.options.fileOnly = fileOnly;
  }

  /**
   * 原地重配置（**不换实例**）——initLogger 的实现基座。
   *
   * 为什么必须原地改而不是 new 一个：模块级 `const log = getLogger()` 这种写法会把
   * "当时那个实例"永久捕获进闭包。若 initLogger 换新实例，早于 initLogger 求值的模块
   * （如 gateway-pricing.ts ← cost-tracker.ts ← config.ts ← cli.ts 这条静态链）就永远
   * 持有 enabled=false 的兜底实例，其 WARN/ERROR 会走 log() 里的 stderr 兜底分支直接
   * 打到用户终端，且**不写进 audit.log**——既污染 TUI，又让日志文件缺失现场。
   * 原地重配置让所有既有引用（无论抓得多早）立刻跟随新配置生效。
   */
  reconfigure(options: Partial<LoggerOptions>): void {
    this.options = Logger.normalizeOptions(options);
    this.setupStreams();
  }

  error(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, category, message, data);
  }

  warn(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.WARN, category, message, data);
  }

  info(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.INFO, category, message, data);
  }

  debug(category: string, message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, category, message, data);
  }

  // 特殊方法：记录 LLM 请求
  llmRequest(_provider: string, model: string, messageCount: number, toolCount: number, maxTokens?: number): void {
    this.info('LLM', `→ ${model} (${messageCount}消息, ${toolCount}工具, maxTokens=${maxTokens ?? '?'})`);
  }

  // 特殊方法：记录 LLM 响应
  llmResponse(stopReason: string, usage?: { inputTokens: number; outputTokens: number }, durationMs?: number, costUSD?: number): void {
    const tokens = usage ? ` in=${usage.inputTokens} out=${usage.outputTokens}` : '';
    const dur = durationMs !== undefined ? ` ${(durationMs / 1000).toFixed(1)}s` : '';
    const cost = costUSD !== undefined ? ` $${costUSD.toFixed(4)}` : '';
    this.info('LLM', `← ${stopReason}${tokens}${dur}${cost}`);
  }

  // 特殊方法：记录 LLM 回复文本内容（截断到合理长度）
  llmResponseText(text: string): void {
    if (!text) return;
    const preview = text.length > 500 ? text.slice(0, 500) + `... (共${text.length}字符)` : text;
    this.info('LLM', `回复内容:\n${preview}`);
  }

  // 特殊方法：记录流式事件
  streamEvent(eventType: string, data?: unknown): void {
    this.debug('STREAM', eventType, data);
  }

  // 特殊方法：记录工具执行开始（含输入参数）
  toolStart(toolName: string, input: unknown): void {
    const inputStr = typeof input === 'object' ? JSON.stringify(input) : String(input);
    const preview = inputStr.length > 300 ? inputStr.slice(0, 300) + '...' : inputStr;
    this.info('TOOL', `▶ ${toolName} ${preview}`);
  }

  // 特殊方法：记录工具执行结果（含输出摘要和耗时）
  toolEnd(toolName: string, output: string, isError: boolean, durationMs: number): void {
    const icon = isError ? '✗' : '✓';
    const preview = output.length > 300 ? output.slice(0, 300) + `... (共${output.length}字符)` : output;
    this.info('TOOL', `${icon} ${toolName} (${durationMs}ms)\n${preview}`);
  }

  // 特殊方法：记录工具执行（兼容旧调用）
  toolExecution(toolName: string, args: unknown, result?: { success: boolean; error?: string }): void {
    const status = result ? (result.success ? '✓' : `✗ ${result.error}`) : '';
    this.debug('TOOL', `${toolName} ${status}`, args);
  }

  // 特殊方法：记录配置加载
  configLoaded(source: string, config: unknown): void {
    this.info('CONFIG', `加载: ${source}`, config);
  }

  // 更新配置
  updateOptions(options: Partial<LoggerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * 缺口 7：设置 per-session WARN/ERROR 日志文件路径。
   * 由 TraceCollector.handleSessionStart 注入 session 目录下的 warn.log 路径。
   * 不被后续会话覆盖（每个 session 独立文件）。
   */
  setSessionWarnLogPath(path: string | undefined): void {
    this.sessionWarnLogPath = path;
  }

  getSessionWarnLogPath(): string | undefined {
    return this.sessionWarnLogPath;
  }

  // 获取日志文件路径
  getLogFilePath(): string | undefined {
    return this.logFilePath;
  }

  /** 关闭日志流（进程退出时调用） */
  close(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = undefined;
    }
    if (this.jsonStream) {
      this.jsonStream.end();
      this.jsonStream = undefined;
    }
  }
}

// 全局单例
let globalLogger: Logger | null = null;

/**
 * 初始化/重配置全局 logger。
 *
 * **恒定返回同一个实例**（首次创建，后续原地 reconfigure）。不可改成 `new Logger()`——
 * 见 Logger.reconfigure 的注释：换实例会让早于本函数求值的模块级 `getLogger()` 捕获
 * 永久停在 enabled=false 的兜底实例上，其 WARN 直接泄漏到用户终端且不入 audit.log。
 */
export function initLogger(options: Partial<LoggerOptions>): Logger {
  if (globalLogger) {
    globalLogger.reconfigure(options);
  } else {
    globalLogger = new Logger(options);
  }
  return globalLogger;
}

export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger({ enabled: false });
  }
  return globalLogger;
}
