/**
 * sid-code 配置目录解析
 *
 * 统一解析配置根目录，支持 SID_CONFIG_DIR 环境变量覆盖
 * （对标 Claude Code 的 CLAUDE_CONFIG_DIR）。
 *
 * 用途：
 * 1. 测试隔离——测试可将配置目录指向临时目录，不污染真实 ~/.sid-code
 * 2. 多实例/沙箱——同一机器跑多个隔离的 sid-code 实例
 * 3. 容器/CI——显式指定配置位置
 *
 * 注意：本解析器是新增的，仅被新 Settings/AppConfig 子系统使用。
 * 旧模块仍直接 join(homedir(), ".sid-code")——渐进迁移，不在本次一并重构。
 */

import { homedir } from "os";
import { join } from "path";

/**
 * 返回 sid-code 配置根目录。
 * 优先级：SID_CONFIG_DIR 环境变量 > ~/.sid-code
 *
 * 每次调用都重新读取 env（不缓存）——使测试可在 beforeEach 中切换目录。
 */
export function getSidHome(): string {
  const override = process.env.SID_CONFIG_DIR;
  if (override && override.trim() !== "") {
    return override;
  }
  return join(homedir(), ".sid-code");
}

/** 返回配置目录下的文件路径 */
export function sidHomePath(...segments: string[]): string {
  return join(getSidHome(), ...segments);
}
