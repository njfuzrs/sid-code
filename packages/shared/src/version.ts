/**
 * 版本号唯一来源
 * 从 package.json 读取，避免多处硬编码漂移
 */

import pkg from "../../../package.json";

export function getVersion(): string {
  return `sid-code v${pkg.version} (TypeScript)`;
}

/** 原始版本号（仅 x.y.z，不含前后缀），供 MCP clientInfo/serverInfo 等需要裸版本号处使用。 */
export function getRawVersion(): string {
  return pkg.version;
}
