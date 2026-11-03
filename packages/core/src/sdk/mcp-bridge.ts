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
 * 目标形态：CLI 侧把 MCP JSON-RPC 包装为 control_request(subtype: mcp_message)，
 * SDK 宿主解包转发给 MCP Server，响应通过 control_response 回传。
 *
 * 对齐 Claude Code SdkControlTransport（spec §5.3）。
 *
 * ⚠️ 接线现状（如实记录，勿夸大）：`mcp_message` 控制子类型的生产接线**尚未实现**
 * （属另案），本文件目前在生产中零调用者。这里只修传输层自身的协议语义与生命周期，
 * 不代表 SDK MCP 服务器的功能入口已经可用。
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

/**
 * MCP Transport 接口（简化版）
 *
 * 对齐 MCP SDK 的 Transport 契约：`send` 是「发出」方向，`onmessage` 是「收到」方向，
 * 二者相互独立——发送失败不应从 send 抛出，而是走 onerror；关闭时通知 onclose。
 */
export interface MCPTransport {
  send(message: JSONRPCMessage): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  /** 传输层错误（发送失败、已关闭后仍在发送等）。缺失时错误会被静默丢弃。 */
  onerror?: (error: Error) => void;
  /** 传输层关闭。 */
  onclose?: () => void;
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 按 JSON-RPC 2.0 的形状给消息分类。
 *
 * 之所以要分类而不是一律把控制层回执投给 onmessage：MCP 的 send 与 onmessage 是
 * 两条独立方向，控制层 ack 是传输层的「发送回执」，不是 MCP 入站消息。把它投给
 * onmessage 会被 MCP Client 当成对端推送（例如把一条 ack 当成未知通知，或让
 * 请求 id 被二次匹配）。
 *
 * - request：有 method 且有 id，对端需要回响应；
 * - notification：有 method 无 id，无需响应；
 * - response：无 method，有 id/result/error，是我们在回应某个入站请求。
 */
type MessageKind = "request" | "notification" | "response";

function classifyMessage(message: JSONRPCMessage): MessageKind {
  if (message.method !== undefined) {
    return message.id !== undefined ? "request" : "notification";
  }
  return "response";
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * CLI 侧 Transport：将 MCP 消息包装为控制协议消息发往 SDK 宿主
 */
export class SdkControlClientTransport implements MCPTransport {
  private serverName: string;
  private sendMcpMessage: (serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>;
  private closed = false;

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(
    serverName: string,
    sendMcpMessage: (name: string, msg: JSONRPCMessage) => Promise<JSONRPCMessage>,
  ) {
    this.serverName = serverName;
    this.sendMcpMessage = sendMcpMessage;
  }

  /**
   * 发送一条 MCP 消息。
   *
   * 按消息类型分流（见 classifyMessage）：
   * - request：await 控制层往返拿到响应后，把响应投给 onmessage ——
   *   MCP Client 自己按 id 匹配待决请求，所以「响应回投」是正确路径；
   * - notification / response：控制协议要求每个 control_request 都必须有
   *   control_response（否则宿主侧会一直挂起对应的 pending 请求），所以我们仍然
   *   await 它的 ack；但 ack 只是控制层回执，**不投给 onmessage**。
   *
   * 任何失败都走 onerror，不从 send 抛出——这是 MCP Transport 的契约：send 只承诺
   * 「已交给传输层」，传输层错误异步上报。
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      // 已关闭的传输不能再发：对齐 MCP Transport，错误走 onerror 而非抛出。
      this.onerror?.(new Error(`MCP transport for "${this.serverName}" is closed`));
      return;
    }

    const kind = classifyMessage(message);
    try {
      const response = await this.sendMcpMessage(this.serverName, message);
      if (kind === "request" && !this.closed) {
        this.onmessage?.(response);
      }
    } catch (err) {
      this.onerror?.(toError(err));
    }
  }

  /**
   * 宿主（控制层）主动推送的 MCP 消息从这里进入：服务端通知、对端请求、
   * 以及 MCP Server 主动发来的响应，最终都投给 onmessage。
   *
   * 这是「服务端主动通知能到达客户端」的唯一真实通道——send 的返回值不是它。
   * 生产侧还没有人调用它（mcp_message 控制子类型接线属另案），语义先对齐。
   */
  receiveFromControl(message: JSONRPCMessage): void {
    if (this.closed) {
      // 关闭后到达的入站消息直接丢弃，不再投递给 MCP Client
      return;
    }
    this.onmessage?.(message);
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

/**
 * SDK 宿主侧 Transport：接收控制协议消息，转发给 MCP Server
 */
export class SdkControlServerTransport implements MCPTransport {
  private sendResponse: (message: JSONRPCMessage) => void;
  private closed = false;

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(sendResponse: (message: JSONRPCMessage) => void) {
    this.sendResponse = sendResponse;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      this.onerror?.(new Error("MCP transport is closed"));
      return;
    }
    try {
      this.sendResponse(message);
    } catch (err) {
      // 回写控制层失败（如底层流已断开）不应从 send 抛出，走 onerror
      this.onerror?.(toError(err));
    }
  }

  /** 从控制协议接收消息，转发给 MCP Server */
  receiveFromControl(message: JSONRPCMessage): void {
    if (this.closed) return;
    this.onmessage?.(message);
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

/**
 * 同进程 MCP Transport 对（用于内置 SDK 工具）
 * 通过 queueMicrotask 异步投递，避免同步调用栈溢出
 */
export function createLinkedTransportPair(): [MCPTransport, MCPTransport] {
  class InProcessTransport implements MCPTransport {
    private peer?: InProcessTransport;
    private closed = false;

    onmessage?: (message: JSONRPCMessage) => void;
    onerror?: (error: Error) => void;
    onclose?: () => void;

    setPeer(peer: InProcessTransport): void {
      this.peer = peer;
    }

    async send(message: JSONRPCMessage): Promise<void> {
      if (this.closed) {
        this.onerror?.(new Error("MCP in-process transport is closed"));
        return;
      }
      // 先在同步阶段取出 peer 引用：即使随后 close 把它解引用，这条已排队的
      // 消息仍能判断自己该不该投递（是否有对端）。
      const peer = this.peer;
      queueMicrotask(() => {
        // 二次检查：close 可能发生在消息入队之后、微任务执行之前。只在 send
        // 入口检查不够——那样已排队的消息仍会穿过 close 投递出去。
        if (this.closed) return;
        peer?.onmessage?.(message);
      });
    }

    async start(): Promise<void> {}

    async close(): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      // 双向解引用 peer，断开 a.peer ↔ b.peer 的强引用环：
      // GC 虽能回收环，但闭包里的 onmessage 会跟着两端一直活到整个 pair 不可达，
      // 对反复创建/销毁的「同进程 MCP」是可观测的内存台阶。
      const peer = this.peer;
      this.peer = undefined;
      if (peer) peer.peer = undefined;
      this.onclose?.();
    }
  }

  const a = new InProcessTransport();
  const b = new InProcessTransport();
  a.setPeer(b);
  b.setPeer(a);
  return [a, b];
}
