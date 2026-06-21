/**
 * 团队记忆写入 secret 守卫（对标 claude-code teamMemSecretGuard.ts）
 *
 * 在 write / edit 工具的执行前调用：当目标路径落在团队记忆目录、且内容含
 * secret 时，返回错误信息阻止写入——团队记忆会同步给所有协作者，secret 绝不
 * 能进入。非团队记忆路径或未启用时返回 null（放行）。
 */

import { scanForSecrets } from "./secret-scanner.ts";
import { isTeamMemPath, isTeamMemoryEnabled, type TeamMemoryOptions } from "./paths.ts";

/**
 * 检查一次「写入/编辑团队记忆路径」是否含 secret。
 * @returns 命中 secret 时返回错误信息（阻止写入），安全时返回 null。
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
  opts: TeamMemoryOptions | undefined,
  cwd: string = process.cwd(),
): string | null {
  // 未启用团队记忆：不拦截（团队记忆目录此时只是普通本地目录）
  if (!isTeamMemoryEnabled(opts)) return null;
  if (!isTeamMemPath(filePath, cwd)) return null;

  const matches = scanForSecrets(content);
  if (matches.length === 0) return null;

  const labels = Array.from(new Set(matches.map((m) => m.label))).join(", ");
  return (
    `内容包含潜在 secret (${labels})，无法写入团队记忆。` +
    `团队记忆会同步给所有仓库协作者。请移除敏感内容后重试——` +
    `凭证应放在 .env / 环境变量，运行时经 process.env 读取，不要写入记忆。`
  );
}
