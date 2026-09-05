/**
 * LSP Client — 最底层，负责 JSON-RPC over stdio 通信
 *
 * 对标 Claude Code 的 LSPClient：
 * - 通过 stdio 管道与 LSP 服务器通信
 * - JSON-RPC 2.0 请求/响应/通知（Content-Length 帧协议）
 * - 进程生命周期管理
 */

import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { getLogger } from "../debug/logger.ts";

/** LSP 帧头与消息体的分隔符（4 字节 ASCII，按字节检索） */
const HEADER_SEPARATOR = "\r\n\r\n";

/**
 * 单条 LSP 消息体的字节上限。
 *
 * LSP 规范没有上限，但真实响应（哪怕是大文件的 documentSymbol / 几百条 findReferences）
 * 也在百 KB 量级，32MB 比它们大两个数量级。超过即视为畸形帧。
 *
 * 为什么必须有这条：`Content-Length` 来自服务器，此前被无条件信任。一旦它大于服务器
 * 实际会发送的总字节数，"消息体未完整"就永远成立，而 `contentLength` 只在成功截取
 * 消息体后才重置 —— 解析器进入**不可恢复**状态：进程还活着、state 还是 running、
 * onCrash 不触发，但这条连接上后续所有响应永远到不了 handleMessage，全部等到 30s 超时。
 * 这比崩溃更坏（崩溃有 handleCrash 重启兜底，这个状态没有任何机制能检测）。
 */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/**
 * 接收缓冲的字节上限，必须显著大于 MAX_MESSAGE_BYTES（否则合法的大消息会被误杀）。
 *
 * 它挡的是 MAX_MESSAGE_BYTES 挡不住的另一类情形：服务器持续往 stdout 写非协议内容、
 * 始终凑不出一个 `\r\n\r\n`，于是 buffer 只增不减。
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * 半截帧的最长容忍时间：头部声明了 N 字节但迟迟收不齐。
 *
 * 上界校验只挡"声明值过大"，挡不住"声明 1000 字节却只发了 900 就再也不发"——
 * 后者同样让解析器永久停在等待态。这里用**数据驱动**的检查（下次收到数据时才判定），
 * 刻意不起定时器：定时器要跟进程生命周期一起摘，是新的泄漏来源，而数据驱动
 * 已经足够拿到关键性质 —— 从"永久报废"变成"下一批数据到达即重新同步"。
 */
const STALE_FRAME_TIMEOUT_MS = 60_000;

export class LSPClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  /**
   * 接收缓冲。**必须是 Buffer 而不是 string** —— 帧协议的 Content-Length 是字节数，
   * 用字符串累积就要在"字符索引"和"字节长度"两套坐标之间来回换算，而入口处
   * 逐 chunk 解码本身还会损坏跨 chunk 的多字节字符（见 stdout 监听处的注释）。
   * 全程按字节走，两个问题一起消失，且省掉每个 chunk 一次全量 Buffer.from（O(n²)）。
   */
  private buffer: Buffer = Buffer.alloc(0);
  private contentLength = -1;
  /** 当前帧头被解析出来的时刻，供半截帧看门狗判定（contentLength < 0 时无意义） */
  private frameStartedAt = 0;
  /** stderr 也可能含中文（诊断/堆栈），同样按流解码，避免日志里出现 `?` */
  private stderrDecoder = new StringDecoder("utf8");
  private isStopping = false;
  private serverName: string;

  /** 进程崩溃回调 */
  onCrash?: () => void;

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  /** 进程是否在运行 */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /** 启动 LSP 服务器进程 */
  async start(
    command: string,
    args: string[],
    options: { env?: Record<string, string>; cwd?: string },
  ): Promise<void> {
    const log = getLogger();

    this.isStopping = false;
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
    });

    // 等待进程成功 spawn
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.process?.removeListener("spawn", onSpawn);
        this.process?.removeListener("error", onError);
      };
      this.process!.once("spawn", onSpawn);
      this.process!.once("error", onError);
    });

    // 监听 stdout（JSON-RPC 消息）
    //
    // ⚠️ 这里**直接把 Buffer 交给 handleData，绝不能先 chunk.toString()**。
    // data 事件的切分点由内核/流缓冲决定，与字符边界无关：一个汉字 3 字节、emoji 4 字节，
    // 边界完全可能落在字符的字节中间。逐 chunk 独立解码会把不完整的字节序列**不可逆地**
    // 替换成 U+FFFD，下一个 chunk 里的续字节又被解成第二个 U+FFFD —— 于是内容损坏、
    // 字节数也变了，Content-Length 校验从此错位，一次损坏污染后续所有消息（并直接
    // 级联触发"声明长度大于实际字节数"的永久卡死）。触发条件只要两条同时成立：
    // 消息里有多字节字符 + 单条消息跨越 chunk 边界（大响应必然发生）——
    // 「中文代码库 + 较大 LSP 响应」正是本项目的目标场景。
    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.handleData(chunk);
    });

    // 监听 stderr（调试日志）。同样按流解码，否则中文日志会被切成 `?`。
    this.process.stderr!.on("data", (chunk: Buffer) => {
      const text = this.stderrDecoder.write(chunk).trim();
      if (text) log.debug("LSP", `[${this.serverName}] stderr: ${text}`);
    });

    // 监听进程退出
    this.process.on("exit", (code) => {
      // reject 所有 pending 请求
      const err = new Error(`LSP 进程退出 (code=${code})`);
      for (const [, pending] of this.pendingRequests) pending.reject(err);
      this.pendingRequests.clear();

      if (!this.isStopping) {
        log.warn("LSP", `[${this.serverName}] 进程意外退出，code=${code}`);
        this.onCrash?.();
      }
    });
  }

  /** 发送请求并等待响应 */
  async sendRequest<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.process || this.process.killed) {
      throw new Error(`LSP 服务器 ${this.serverName} 未运行`);
    }

    const id = ++this.requestId;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP 请求超时: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.writeMessage(message);
    });
  }

  /** 发送通知（无 id，不等响应） */
  sendNotification(method: string, params?: unknown): void {
    if (!this.process || this.process.killed) return;
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  /** 注册通知处理器（支持同一 method 多个处理器） */
  onNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  /** 停止进程 */
  stop(): void {
    this.isStopping = true;
    if (this.process && !this.process.killed) {
      // 先摘掉 stdout/stderr/exit 监听器,避免进程退出后回调残留(LEAK-6)
      try {
        this.process.stdout?.removeAllListeners();
      } catch {
        /* ignore */
      }
      try {
        this.process.stderr?.removeAllListeners();
      } catch {
        /* ignore */
      }
      try {
        this.process.removeAllListeners("exit");
      } catch {
        /* ignore */
      }
      try {
        this.process.kill();
      } catch {}
    }
    // reject 残留 pending 请求,避免调用方永久挂起
    const err = new Error(`LSP 服务器 ${this.serverName} 已停止`);
    for (const [, pending] of this.pendingRequests) pending.reject(err);
    this.pendingRequests.clear();
    this.process = null;
  }

  // ─── 内部方法 ───

  /** 写入 JSON-RPC 消息（Content-Length 帧协议） */
  private writeMessage(message: unknown): void {
    const json = JSON.stringify(message);
    const contentLength = Buffer.byteLength(json, "utf-8");
    const payload = `Content-Length: ${contentLength}\r\n\r\n${json}`;
    this.process?.stdin?.write(payload);
  }

  /**
   * 丢弃已污染的缓冲并让解析器回到"等待下一个帧头"的状态。
   *
   * `contentLength` 的重置是关键：只加校验而不重置，解析器一样卡死在等待态。
   */
  private resetParser(): void {
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
    this.frameStartedAt = 0;
  }

  /**
   * 处理 stdout 数据（解析 Content-Length 帧）。
   *
   * 入参是 **Buffer**（不是 string）：解码只发生在按 Content-Length 精确切出完整消息体
   * 之后，所以跨 chunk 的多字节字符天然无损。
   */
  private handleData(chunk: Buffer): void {
    // 防线一：半截帧看门狗。上一个帧头声明的字节数迟迟收不齐时重新同步，
    // 而不是永远停在等待态（此时新数据往往正是一条完整的新帧）。
    if (this.contentLength >= 0 && Date.now() - this.frameStartedAt > STALE_FRAME_TIMEOUT_MS) {
      getLogger().error(
        "LSP",
        `[${this.serverName}] 帧体 ${STALE_FRAME_TIMEOUT_MS}ms 未收齐` +
          `（已收 ${this.buffer.length}/${this.contentLength} 字节），重置解析器并重新同步`,
      );
      this.resetParser();
    }

    // 空 buffer 时直接接管 chunk，省掉一次拷贝（stream 不复用 chunk，且我们只读不写）
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    // 防线二：缓冲上限。挡住"始终凑不出帧头"（服务器把非协议内容写进 stdout）这类只增不减。
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      getLogger().error(
        "LSP",
        `[${this.serverName}] 接收缓冲超过 ${MAX_BUFFER_BYTES} 字节，丢弃并重置解析器状态`,
      );
      this.resetParser();
      return;
    }

    while (true) {
      if (this.contentLength < 0) {
        // 寻找头部结束标记（字节索引）
        const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
        if (headerEnd === -1) return; // 头部未完整

        // 头部是 ASCII；用 latin1 逐字节映射，前置垃圾里的多字节序列也不会影响匹配
        const header = this.buffer.subarray(0, headerEnd).toString("latin1");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // 头部损坏，跳过（实测这条路径能正确恢复：后续帧照常解析）
          this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
          continue;
        }

        // 防线三：上界 + 合理性校验。声明值不可信，超限就丢帧重新同步。
        const declared = Number.parseInt(match[1]!, 10);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_MESSAGE_BYTES) {
          getLogger().error(
            "LSP",
            `[${this.serverName}] 畸形 Content-Length: ${match[1]}` +
              `（上限 ${MAX_MESSAGE_BYTES} 字节），丢弃该帧并重置解析器`,
          );
          this.resetParser();
          return;
        }

        this.contentLength = declared;
        this.frameStartedAt = Date.now();
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
      }

      // 按字节长度截取消息体（buffer 本身就是字节，无需再转换）
      if (this.buffer.length < this.contentLength) return; // 消息体未完整

      const body = this.buffer.subarray(0, this.contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      this.frameStartedAt = 0;

      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch {
        getLogger().error("LSP", `[${this.serverName}] JSON 解析失败`);
      }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      // 响应
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method && msg.id == null) {
      // 通知
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(msg.params);
          } catch {}
        }
      }
    } else if (msg.method && msg.id != null) {
      // G8：服务器→客户端的请求。此前被忽略（服务器永远等不到响应），部分服务器
      // 会因此阻塞初始化或反复重发。这里给出最小可用应答，让服务器继续工作：
      this.handleServerRequest(msg);
    }
  }

  /**
   * G8：处理服务器→客户端请求。
   *
   * 我们不维护完整的客户端能力（无 UI / 配置面板），故对常见请求给出"无害默认值"，
   * 其余一律回 MethodNotFound——这比静默丢弃更合规，避免服务器无限等待响应。
   * - workspace/configuration：返回与请求项数等长的空配置数组（多数服务器接受 null/空）
   * - window/workDoneProgress/create：返回 null（同意创建进度令牌，但我们不渲染）
   * - client/registerCapability、client/unregisterCapability：返回 null（接受动态注册）
   * - workspace/semanticTokens/refresh 等 refresh 类：返回 null（确认收到）
   * - 其余未知请求：回 -32601 MethodNotFound
   */
  private handleServerRequest(msg: any): void {
    const respond = (result: unknown) => this.writeMessage({ jsonrpc: "2.0", id: msg.id, result });

    switch (msg.method) {
      case "workspace/configuration": {
        // 请求形如 { items: [{ section?, scopeUri? }, ...] }，按项数返回等长空配置数组。
        const items = Array.isArray(msg.params?.items) ? msg.params.items : [];
        respond(items.length > 0 ? items.map(() => ({})) : [{}]);
        break;
      }
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/diagnostic/refresh":
      case "workspace/codeLens/refresh":
        respond(null);
        break;
      default:
        // 未知请求：返回 MethodNotFound，而非静默丢弃。
        this.writeMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
        break;
    }
  }
}
