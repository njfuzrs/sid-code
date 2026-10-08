/**
 * 版本号唯一来源
 * 从 package.json 读取，避免多处硬编码漂移
 */

import pkg from "../../../package.json";
import { getChannelLabel } from "./release-channel.ts";

/**
 * ⚠️ 不要把通道拼进这里：app.ts 用它做网关定价的刷新水位线、daemon 锁也记它，
 * 拼进通道会让 promote 前后被判成「刚更新过」。给人看的版本串用 getVersionDisplay()。
 */
export function getVersion(): string {
  return `sid-code v${pkg.version} (TypeScript)`;
}

/** 原始版本号（仅 x.y.z，不含前后缀），供 MCP clientInfo/serverInfo 等需要裸版本号处使用。 */
export function getRawVersion(): string {
  return pkg.version;
}

/** 给人看的版本串：beta / dev 追加通道标签，正式版（stable）与 getVersion() 完全相同。 */
export function getVersionDisplay(): string {
  const base = getVersion();
  const label = getChannelLabel();
  return label ? `${base} · ${label}` : base;
}
