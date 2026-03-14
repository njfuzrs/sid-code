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
      const header = `\n${'='.repeat(80)}\nSID-CODE DEBUG LOG - ${new Date().toISOString()}\n${'='.repeat(80)}\n`;
      writeFileSync(this.logFilePath, header, 'utf-8');
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return this.options.enabled && level <= this.options.level;
  }

  private formatMessage(level: LogLevel, category: string, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level].padEnd(5);
    const categoryStr = category.padEnd(15);

    let formatted = `[${timestamp}] [${levelStr}] [${categoryStr}] ${message}`;

    if (data !== undefined) {
      formatted += '\n' + this.formatData(data);
    }

    return formatted;
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

    // 根据级别选择颜色
    const colors = {
      [LogLevel.ERROR]: '\x1b[31m', // 红色
      [LogLevel.WARN]: '\x1b[33m',  // 黄色
      [LogLevel.INFO]: '\x1b[36m',  // 青色
      [LogLevel.DEBUG]: '\x1b[90m', // 灰色
    };
    const reset = '\x1b[0m';

    const coloredMessage = `${colors[level]}${message}${reset}`;

    if (level === LogLevel.ERROR) {
      console.error(coloredMessage);
    } else {
      console.log(coloredMessage);
    }
  }

  private log(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.formatMessage(level, category, message, data);

    this.writeToFile(formatted);
    // fileOnly 模式下不输出到控制台（TUI 模式避免干扰 Ink 渲染）
    if (!this.options.fileOnly) {
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
  llmRequest(provider: string, model: string, messageCount: number, toolCount: number): void {
    this.debug('LLM', `发送请求到 ${provider}`, {
      model,
      messageCount,
      toolCount,
    });
  }

  // 特殊方法：记录 LLM 响应
  llmResponse(stopReason: string, usage?: { inputTokens: number; outputTokens: number }): void {
    this.debug('LLM', `收到响应 (${stopReason})`, usage);
  }

  // 特殊方法：记录流式事件
  streamEvent(eventType: string, data?: unknown): void {
    this.debug('STREAM', `事件: ${eventType}`, data);
  }

  // 特殊方法：记录工具执行
  toolExecution(toolName: string, args: unknown, result?: { success: boolean; error?: string }): void {
    this.debug('TOOL', `执行工具: ${toolName}`, { args, result });
  }

  // 特殊方法：记录配置加载
  configLoaded(source: string, config: unknown): void {
    this.info('CONFIG', `加载配置: ${source}`, config);
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
