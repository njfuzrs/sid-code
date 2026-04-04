/**
 * 版本号唯一来源
 * 从 package.json 读取，避免多处硬编码漂移
 */

import pkg from "../package.json";

export function getVersion(): string {
  return `sid-code v${pkg.version} (TypeScript)`;
}
