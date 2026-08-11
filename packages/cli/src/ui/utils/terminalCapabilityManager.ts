/**
 * 终端能力探测管理器
 *
 * 启动时发送探测序列，检测终端支持的能力：
 * - Kitty 键盘协议
 * - ModifyOtherKeys
 * - OSC 11 背景色
 * - 终端名称/版本
 *
 * 使用 Primary Device Attributes 响应作为哨兵，确认终端已处理所有查询。
 *
 * 参考 gemini-cli/packages/cli/src/ui/utils/terminalCapabilityManager.ts
 */

import * as fs from 'node:fs';
import { getLogger } from '@sid-code/core/debug/logger.ts';

export type TerminalBackgroundColor = string | undefined;

/** Kitty 键盘协议：启用 flags=0b11111（所有增强） */
const ENABLE_KITTY = '\x1b[>31u';
/** Kitty 键盘协议：禁用（弹出所有 flags） */
const DISABLE_KITTY = '\x1b[<u';
/** ModifyOtherKeys level 2 */
const ENABLE_MODIFY_OTHER_KEYS = '\x1b[>4;2m';
/** 禁用 ModifyOtherKeys */
const DISABLE_MODIFY_OTHER_KEYS = '\x1b[>4;0m';
/** 启用 Bracketed Paste Mode */
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
/** 禁用 Bracketed Paste Mode */
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

/** 退出时的清理序列（同步写入） */
const TERMINAL_CLEANUP_SEQUENCE = `${DISABLE_KITTY}${DISABLE_MODIFY_OTHER_KEYS}${DISABLE_BRACKETED_PASTE}`;

/** 同步清理终端模式（用于 exit/SIGTERM/SIGINT 处理） */
export function cleanupTerminalOnExit() {
  try {
    if (process.stdout?.fd !== undefined) {
      fs.writeSync(process.stdout.fd, TERMINAL_CLEANUP_SEQUENCE);
      return;
    }
  } catch (_e) {
    // 静默失败
  }
  // fallback：异步写入
  try {
    process.stdout.write(DISABLE_KITTY);
    process.stdout.write(DISABLE_MODIFY_OTHER_KEYS);
    process.stdout.write(DISABLE_BRACKETED_PASTE);
  } catch (_e) {
    // 静默失败
  }
}

/**
 * 解析 OSC 11 返回的 16 位颜色分量为 hex 颜色字符串
 * 输入格式：1-4 位 hex 字符串（如 "0000", "ffff", "7f7f"）
 * 输出：标准化为 2 位 hex（取高 8 位）
 */
function parseColorComponent(hex: string): string {
  if (hex.length <= 2) return hex.padStart(2, '0');
  // 取高 8 位（前 2 位）
  return hex.slice(0, 2);
}

/** 将 OSC 11 的 rgb 分量解析为 #rrggbb 格式 */
export function parseColor(r: string, g: string, b: string): string {
  return `#${parseColorComponent(r)}${parseColorComponent(g)}${parseColorComponent(b)}`;
}

export class TerminalCapabilityManager {
  private static instance: TerminalCapabilityManager | undefined;

  // 探测查询序列
  private static readonly KITTY_QUERY = '\x1b[?u';
  private static readonly OSC_11_QUERY = '\x1b]11;?\x1b\\';
  private static readonly TERMINAL_NAME_QUERY = '\x1b[>q';
  private static readonly DEVICE_ATTRIBUTES_QUERY = '\x1b[c';
  private static readonly MODIFY_OTHER_KEYS_QUERY = '\x1b[>4;?m';
  private static readonly HIDDEN_MODE = '\x1b[8m';
  private static readonly CLEAR_LINE_AND_RETURN = '\x1b[2K\r';
  private static readonly RESET_ATTRIBUTES = '\x1b[0m';

  /** 触发终端背景色查询 */
  static queryBackgroundColor(stdout: { write: (data: string) => void | boolean }): void {
    stdout.write(TerminalCapabilityManager.OSC_11_QUERY);
  }

  // 响应匹配正则
  // eslint-disable-next-line no-control-regex
  private static readonly KITTY_REGEX = /\x1b\[\?(\d+)u/;
  // eslint-disable-next-line no-control-regex
  private static readonly TERMINAL_NAME_REGEX = /\x1bP>\|(.+?)(\x1b\\|\x07)/;
  // eslint-disable-next-line no-control-regex
  private static readonly DEVICE_ATTRIBUTES_REGEX = /\x1b\[\?(\d+)(;\d+)*c/;
  // eslint-disable-next-line no-control-regex
  static readonly OSC_11_REGEX = /\x1b\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(\x1b\\|\x07)/;
  // eslint-disable-next-line no-control-regex
  private static readonly MODIFY_OTHER_KEYS_REGEX = /\x1b\[>4;(\d+)m/;

  private detectionComplete = false;
  private terminalBackgroundColor: TerminalBackgroundColor;
  private kittySupported = false;
  private kittyEnabled = false;
  private modifyOtherKeysSupported = false;
  private terminalName: string | undefined;

  private constructor() {}

  static getInstance(): TerminalCapabilityManager {
    if (!this.instance) {
      this.instance = new TerminalCapabilityManager();
    }
    return this.instance;
  }

  static resetInstanceForTesting(): void {
    this.instance = undefined;
  }

  /**
   * 检测终端能力（Kitty 协议、终端名称、背景色等）
   * 应在应用启动时调用一次
   */
  async detectCapabilities(): Promise<void> {
    if (this.detectionComplete) return;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      this.detectionComplete = true;
      return;
    }

    const log = getLogger();

    // 注册退出清理
    process.off('exit', cleanupTerminalOnExit);
    process.off('SIGTERM', cleanupTerminalOnExit);
    process.off('SIGINT', cleanupTerminalOnExit);
    process.on('exit', cleanupTerminalOnExit);
    process.on('SIGTERM', cleanupTerminalOnExit);
    process.on('SIGINT', cleanupTerminalOnExit);

    return new Promise((resolve) => {
      const originalRawMode = process.stdin.isRaw;
      if (!originalRawMode) {
        process.stdin.setRawMode(true);
      }

      let buffer = '';
      let kittyKeyboardReceived = false;
      let terminalNameReceived = false;
      let deviceAttributesReceived = false;
      let bgReceived = false;
      let modifyOtherKeysReceived = false;
      let timeoutId: NodeJS.Timeout;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        process.stdin.removeListener('data', onData);
        if (!originalRawMode) {
          process.stdin.setRawMode(false);
        }
        this.detectionComplete = true;
        resolve();
      };

      // 1 秒超时（所有终端都应响应 Device Attributes 查询）
      timeoutId = setTimeout(cleanup, 1000);

      const onData = (data: Buffer) => {
        buffer += data.toString();

        // 检测 OSC 11 背景色响应
        if (!bgReceived) {
          const match = buffer.match(TerminalCapabilityManager.OSC_11_REGEX);
          if (match) {
            bgReceived = true;
            this.terminalBackgroundColor = parseColor(match[1], match[2], match[3]);
            log.info('TERMINAL', `检测到终端背景色: ${this.terminalBackgroundColor}`);
          }
        }

        // 检测 Kitty 键盘协议支持
        if (!kittyKeyboardReceived && TerminalCapabilityManager.KITTY_REGEX.test(buffer)) {
          kittyKeyboardReceived = true;
          this.kittySupported = true;
          log.info('TERMINAL', 'Kitty 键盘协议受支持');
        }

        // 检测 ModifyOtherKeys 支持
        if (!modifyOtherKeysReceived) {
          const match = buffer.match(TerminalCapabilityManager.MODIFY_OTHER_KEYS_REGEX);
          if (match) {
            modifyOtherKeysReceived = true;
            const level = parseInt(match[1], 10);
            this.modifyOtherKeysSupported = level >= 2;
            log.info('TERMINAL', `ModifyOtherKeys 支持: ${this.modifyOtherKeysSupported} (level ${level})`);
          }
        }

        // 检测终端名称/版本
        if (!terminalNameReceived) {
          const match = buffer.match(TerminalCapabilityManager.TERMINAL_NAME_REGEX);
          if (match) {
            terminalNameReceived = true;
            this.terminalName = match[1];
            log.info('TERMINAL', `检测到终端名称: ${this.terminalName}`);
          }
        }

        // Device Attributes 响应作为哨兵（最后发送，收到即可停止等待）
        if (!deviceAttributesReceived) {
          const match = buffer.match(TerminalCapabilityManager.DEVICE_ATTRIBUTES_REGEX);
          if (match) {
            deviceAttributesReceived = true;
            cleanup();
          }
        }
      };

      process.stdin.on('data', onData);

      try {
        // 使用隐藏模式防止查询序列在终端上显示
        fs.writeSync(
          process.stdout.fd,
          TerminalCapabilityManager.HIDDEN_MODE +
            TerminalCapabilityManager.KITTY_QUERY +
            TerminalCapabilityManager.OSC_11_QUERY +
            TerminalCapabilityManager.TERMINAL_NAME_QUERY +
            TerminalCapabilityManager.MODIFY_OTHER_KEYS_QUERY +
            TerminalCapabilityManager.DEVICE_ATTRIBUTES_QUERY +
            TerminalCapabilityManager.CLEAR_LINE_AND_RETURN +
            TerminalCapabilityManager.RESET_ATTRIBUTES,
        );
      } catch (e) {
        log.warn('TERMINAL', '写入终端能力查询失败', { error: (e as Error).message });
        cleanup();
      }
    });
  }

  /** 启用终端支持的增强模式 */
  enableSupportedModes(): void {
    const log = getLogger();
    try {
      if (this.kittySupported) {
        log.info('TERMINAL', '启用 Kitty 键盘协议');
        process.stdout.write(ENABLE_KITTY);
        this.kittyEnabled = true;
      } else if (this.modifyOtherKeysSupported) {
        log.info('TERMINAL', '启用 ModifyOtherKeys');
        process.stdout.write(ENABLE_MODIFY_OTHER_KEYS);
      }
      // 始终启用 Bracketed Paste（不支持的终端会忽略）
      process.stdout.write(ENABLE_BRACKETED_PASTE);
    } catch (e) {
      log.warn('TERMINAL', '启用键盘协议失败', { error: (e as Error).message });
    }
  }

  getTerminalBackgroundColor(): TerminalBackgroundColor {
    return this.terminalBackgroundColor;
  }

  getTerminalName(): string | undefined {
    return this.terminalName;
  }

  isKittyProtocolEnabled(): boolean {
    return this.kittyEnabled;
  }

  /** 检查终端是否支持 OSC 9 通知 */
  supportsOsc9Notifications(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env['WT_SESSION']) return false;
    return (
      this.hasOsc9TerminalSignature(this.getTerminalName()) ||
      this.hasOsc9TerminalSignature(env['TERM_PROGRAM']) ||
      this.hasOsc9TerminalSignature(env['TERM'])
    );
  }

  private hasOsc9TerminalSignature(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.toLowerCase();
    return (
      normalized.includes('wezterm') ||
      normalized.includes('ghostty') ||
      normalized.includes('iterm') ||
      normalized.includes('kitty')
    );
  }
}

export const terminalCapabilityManager = TerminalCapabilityManager.getInstance();
