/**
 * Bridge 远程控制类型定义
 * 对标 Claude Code 的 Bridge 子系统（云端中继 / 远程控制）
 */

/** Bridge 输出消息（发送给远程客户端） */
export interface BridgeOutMessage {
  type: "text" | "tool_use" | "tool_result" | "status" | "permission_request";
  id?: string;
  data: unknown;
  timestamp: number;
}

/** Bridge 输入消息（从远程客户端接收） */
export interface BridgeInMessage {
  type: "user_message" | "permission_response" | "control";
  id?: string;
  data: unknown;
}

/** 传输层抽象（对标 Claude Code 的 ReplBridgeTransport） */
export interface BridgeTransport {
  /** 发送单条消息 */
  write(message: BridgeOutMessage): Promise<void>;
  /** 批量发送 */
  writeBatch(messages: BridgeOutMessage[]): Promise<void>;
  /** 关闭连接 */
  close(): void;
  /** 是否已连接 */
  isConnected(): boolean;
  /** 状态标签（用于日志） */
  getStateLabel(): string;
  /** 注册数据接收回调 */
  setOnData(callback: (data: string) => void): void;
  /** 注册连接关闭回调 */
  setOnClose(callback: (code?: number) => void): void;
  /** 注册连接建立回调 */
  setOnConnect(callback: () => void): void;
  /** 建立连接 */
  connect(): Promise<void>;
  /** 刷新缓冲区 */
  flush(): Promise<void>;
}

/** 权限请求（转发给远程客户端） */
export interface BridgePermissionRequest {
  toolName: string;
  toolInput: unknown;
  description: string;
  dangerLevel: string;
}
