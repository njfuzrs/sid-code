/**
 * SDK MCP 工具桥接（SdkControlTransport）
 *
 * 让 SDK 宿主进程注册的自定义 MCP 工具能被 CLI 子进程调用：
 *
 *   SDK 宿主进程                              CLI 子进程
 *   ┌──────────────────────┐                ┌──────────────────────────┐
 *   │  SDK MCP Server      │                │  MCP Client (sid-code)    │
 *   │       ▼              │                │       ▼                  │
 *   │  SdkControlServer    │   stdin/stdout │  SdkControlClient        │
 *   │  Transport           │◄──────────────►│  Transport               │
 *   └──────────────────────┘   控制协议      └──────────────────────────┘
 *
 * CLI 侧把 MCP JSON-RPC 包装为 control_request(subtype: mcp_message)，
 * SDK 宿主解包转发给 MCP Server，响应通过 control_response 回传。
 *
 * 对齐 Claude Code SdkControlTransport（spec §5.3）。
 */

/** MCP JSON-RPC 消息（简化版，对齐 @modelcontextprotocol/sdk） */
export interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** MCP Transport 接口（简化版） */
export interface MCPTransport {
  send(message: JSONRPCMessage): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * CLI 侧 Transport：将 MCP 消息包装为控制协议消息发往 SDK 宿主
 */
export class SdkControlClientTransport implements MCPTransport {
  private serverName: string;
  private sendMcpMessage: (serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>;

  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    serverName: string,
    sendMcpMessage: (name: string, msg: JSONRPCMessage) => Promise<JSONRPCMessage>,
  ) {
    this.serverName = serverName;
    this.sendMcpMessage = sendMcpMessage;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const response = await this.sendMcpMessage(this.serverName, message);
    this.onmessage?.(response);
  }

  async start(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * SDK 宿主侧 Transport：接收控制协议消息，转发给 MCP Server
 */
export class SdkControlServerTransport implements MCPTransport {
  private sendResponse: (message: JSONRPCMessage) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(sendResponse: (message: JSONRPCMessage) => void) {
    this.sendResponse = sendResponse;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sendResponse(message);
  }

  /** 从控制协议接收消息，转发给 MCP Server */
  receiveFromControl(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  async start(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * 同进程 MCP Transport 对（用于内置 SDK 工具）
 * 通过 queueMicrotask 异步投递，避免同步调用栈溢出
 */
export function createLinkedTransportPair(): [MCPTransport, MCPTransport] {
  class InProcessTransport implements MCPTransport {
    private peer?: InProcessTransport;
    onmessage?: (message: JSONRPCMessage) => void;

    setPeer(peer: InProcessTransport): void {
      this.peer = peer;
    }

    async send(message: JSONRPCMessage): Promise<void> {
      const peer = this.peer;
      queueMicrotask(() => {
        peer?.onmessage?.(message);
      });
    }

    async start(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const a = new InProcessTransport();
  const b = new InProcessTransport();
  a.setPeer(b);
  b.setPeer(a);
  return [a, b];
}
