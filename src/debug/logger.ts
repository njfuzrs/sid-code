/**
 * 调试日志系统
 * 支持分级日志、文件输出、格式化输出
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
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

class Logger {
  private options: LoggerOptions;
  private logFilePath?: string;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = {
      enabled: options.enabled ?? false,
      level: options.level ?? LogLevel.INFO,
      console: options.console ?? true,
      fileOnly: options.fileOnly ?? false,
      logFile: options.logFile,
    };

    if (this.options.enabled && this.options.logFile) {
      this.logFilePath = this.options.logFile.startsWith('~')
        ? join(homedir(), this.options.logFile.slice(1))
        : this.options.logFile;

      // 确保日志目录存在
      const logDir = join(this.logFilePath, '..');
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      // 初始化日志文件（清空旧日志）
      const header = `${C.cyan}${C.bold}${'─'.repeat(60)}\n SID-CODE DEBUG LOG  ${new Date().toLocaleString('zh-CN')}\n${'─'.repeat(60)}${C.reset}\n\n`;
      writeFileSync(this.logFilePath, header, 'utf-8');
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

  private writeToFile(message: string): void {
    if (this.logFilePath) {
      try {
        appendFileSync(this.logFilePath, message + '\n', 'utf-8');
      } catch (err) {
        // 静默失败，避免日志系统本身导致程序崩溃
      }
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
    if (!this.options.enabled) return;

    const formatted = this.formatMessage(level, category, message, data);

    // 文件始终写入所有级别，确保日志文件包含完整信息
    this.writeToFile(formatted);

    // 控制台输出受 level 过滤（fileOnly 模式下不输出到控制台）
    if (!this.options.fileOnly && level <= this.options.level) {
      this.writeToConsole(level, formatted);
    }
  }

  /** 切换为仅文件输出模式（TUI 模式下使用） */
  setFileOnly(fileOnly: boolean): void {
    this.options.fileOnly = fileOnly;
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

  // 获取日志文件路径
  getLogFilePath(): string | undefined {
    return this.logFilePath;
  }
}

// 全局单例
let globalLogger: Logger | null = null;

export function initLogger(options: Partial<LoggerOptions>): Logger {
  globalLogger = new Logger(options);
  return globalLogger;
}

export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger({ enabled: false });
  }
  return globalLogger;
}
