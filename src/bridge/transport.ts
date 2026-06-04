/**
 * Bridge 传输层工厂
 * 根据 URL 协议选择具体传输实现。当前仅支持 WebSocket。
 */

import type { BridgeTransport } from "./types.ts";
import { WebSocketBridgeTransport } from "./ws-transport.ts";

export type { BridgeTransport } from "./types.ts";

/** 根据 URL 创建 Bridge 传输 */
export function createBridgeTransport(url: string, authToken?: string): BridgeTransport {
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return new WebSocketBridgeTransport(url, authToken);
  }
  throw new Error(`不支持的 Bridge 传输协议: ${url}（当前仅支持 ws:// / wss://）`);
}
