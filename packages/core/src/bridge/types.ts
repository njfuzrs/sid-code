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

/**
 * 传输层降级/异常计数（对标 CC 的 `ReplBridgeTransport.droppedBatchCount`）。
 *
 * ⚠️ **这组字段不是"顺手加的可观测性"，是丢弃逻辑的准入条件**：
 * 本仓判据是「**降级动作必须留下计数**」—— 没有计数的丢弃/降级是完全不可观测的
 * 行为，线上出问题时无法回答"有没有丢消息"，只能猜。D10 加丢弃上限（否则故障时
 * 无限重试同一批、整条链路停摆），那么同一个 PR 里就必须把计数一起加上，
 * 否则只是把"卡住"换成了"静默丢消息"——后者更难排查。
 *
 * 同理 `reconnectCount` / `halfOpenDetectedCount`：重连与半开检测都是"坏事发生了
 * 但我们兜住了"，而这类事件**不留计数就永远不知道它有没有发生过**
 * （与「防线触发率」同一条原则：「有防线」和「防线被触发过」是两个事实）。
 */
export interface BridgeTransportStats {
  /** 累计丢弃批次数（连续失败超限 + 关停时放弃） */
  droppedBatchCount: number;
  /** 累计丢弃条目数 —— 批次数不够用：一批可能 1 条也可能 500 条 */
  droppedItemCount: number;
  /** 累计重连次数（每次成功重连 +1） */
  reconnectCount: number;
  /** 累计检测到半开连接的次数（心跳探活判定超时，D12） */
  halfOpenDetectedCount: number;
  /** 因永久失败关闭码而放弃重连的次数（D11） */
  permanentFailureCount: number;
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
  /**
   * 刷新缓冲区，**带时限**（D9）。
   *
   * @returns true = 真的排空了；false = 到点了仍未排空。
   * 返回值不是可选的装饰：调用方（`BridgeCore.stop()`）要据此决定是否记一条
   * "关停时仍有未发送消息"。原实现无条件等到队列空，断连时永不返回。
   */
  flush(timeoutMs?: number): Promise<boolean>;
  /** 降级/异常计数（见 BridgeTransportStats 的注释） */
  getStats(): BridgeTransportStats;
}

/** 权限请求（转发给远程客户端） */
export interface BridgePermissionRequest {
  toolName: string;
  toolInput: unknown;
  description: string;
  dangerLevel: string;
}
