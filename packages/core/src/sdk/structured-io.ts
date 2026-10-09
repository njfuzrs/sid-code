/**
 * StructuredIO — NDJSON 协议核心
 *
 * 双向 NDJSON 通信：数据消息和控制消息共用一个通道（单通道全序）。
 * - read()：解析输入流，分发 user / control_response / keep_alive
 * - write()：通过写队列保证消息序列化，防止并发写交错
 * - sendRequest()：发送控制请求并等待响应（权限、MCP、上下文查询）
 *
 * 对齐 Claude Code 的 StructuredIO 设计（spec §4.3）。
 */

import type { Readable, Writable } from "node:stream";
import type { z } from "zod/v3";
import type {
  SDKControlRequest,
  SDKControlRequestInner,
  SDKControlResponse,
  StdinMessage,
  StdoutMessage,
} from "./types.ts";
import { ndjsonStringify, ndjsonLines, ndjsonParse } from "./ndjson.ts";
import { SDKControlResponseSchema } from "./control-schemas.ts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  schema: z.ZodType<unknown>;
}

/** 写队列里的一条：消息 + 它自己的结算器（缺陷 1：谁的写失败就 reject 谁） */
interface QueuedWrite {
  message: StdoutMessage;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class StructuredIO {
  /** 待处理的控制请求（request_id → Promise resolver） */
  private pendingRequests = new Map<string, PendingRequest>();
  /** 输出队列（保证写入序列化）；每条带自己的 resolve/reject */
  private writeQueue: QueuedWrite[] = [];
  private writing = false;
  /**
   * 输入流已结束（宿主关了 stdin / 进程断开）。
   * 之后发出的控制请求不可能再等到响应——必须立即 reject，否则 can_use_tool
   * 会一直挂到超时，fail-closed 变成「卡死 N 分钟后 fail-closed」。
   */
  private inputClosed = false;

  private input: Readable;
  private output: Writable;

  constructor(input: Readable, output: Writable) {
    this.input = input;
    this.output = output;
  }

  /**
   * 读取输入流，解析 NDJSON，分发消息类型
   * - user → yield 给主循环
   * - control_response → 匹配并解析 pending 请求（不 yield）
   * - keep_alive → 静默忽略
   * - control_request → yield 给调用方分发（interrupt 等；见 headless-runner）
   * - 其他 → 作为 StdinMessage yield
   *
   * 输入流结束时 reject 全部未决请求：宿主断开 = 不会再有响应。
   */
  async *read(): AsyncGenerator<StdinMessage> {
    for await (const line of ndjsonLines(this.input)) {
      let msg: Record<string, unknown> | null = null;
      try {
        msg = ndjsonParse(line) as Record<string, unknown>;
      } catch {
        // 解析失败，跳过该行
        continue;
      }
      if (!msg || typeof msg !== "object") continue;

      switch (msg.type) {
        case "user":
          yield msg as unknown as StdinMessage;
          break;

        case "control_response": {
          const parsed = SDKControlResponseSchema().safeParse(msg);
          if (parsed.success) {
            this.handleControlResponse(parsed.data);
          }
          break;
        }

        case "keep_alive":
          // 静默忽略
          break;

        default:
          // control_request 与未知消息类型都 yield 给主循环，由它决定回什么
          yield msg as unknown as StdinMessage;
      }
    }
    this.inputClosed = true;
    this.rejectAllPending("SDK 宿主输入流已关闭");
  }

  /**
   * 写入 SDK 消息到输出流。
   *
   * 队列保证写入序列化，且 **Promise 只在「这一条」写出（或写失败）时结算**（缺陷 1）。
   * 旧实现是「入队即 resolve」：并发时 B/C 的 Promise 立刻 fulfilled，真正的写发生在
   * A 的 drain 循环里——于是 B 的写错误由 A reject、B 被谎报成功、而异常穿出循环后
   * 残留的 C 无人再取，静默丢失。现在每条消息带自己的结算器，一条写失败只 reject
   * 它自己，循环继续写后面的。
   */
  write(message: StdoutMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ message, resolve, reject });
      if (!this.writing) void this.drainWrites();
    });
  }

  private async drainWrites(): Promise<void> {
    this.writing = true;
    try {
      while (this.writeQueue.length > 0) {
        const item = this.writeQueue.shift()!;
        try {
          await this.writeOne(item.message);
          item.resolve();
        } catch (err) {
          item.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this.writing = false;
    }
  }

  private writeOne(msg: StdoutMessage): Promise<void> {
    const line = ndjsonStringify(msg) + "\n";
    return new Promise<void>((resolve, reject) => {
      // 同步抛错（EPIPE 等）在 Promise 执行器里会被转成 reject
      const ok = this.output.write(line, "utf-8");
      if (ok) resolve();
      else this.output.once("drain", () => resolve());
    });
  }

  /**
   * 发送控制请求并等待响应
   * 用于权限请求、MCP 通信等需要同步响应的场景
   */
  sendRequest<T>(
    request: SDKControlRequestInner,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    const controlRequest: SDKControlRequest = {
      type: "control_request",
      request_id: requestId,
      request,
    };

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Request aborted"));
        return;
      }
      if (this.inputClosed) {
        reject(new Error("SDK 宿主输入流已关闭"));
        return;
      }

      // 缺陷 2：`{ once: true }` 只在 abort 触发后自动解绑；请求正常结算时监听器会一直
      // 挂在 signal 上。调用方传会话级长寿 signal 时，每次请求泄漏一个闭包（EventTarget
      // 没有 MaxListeners 警告，静默）。所以 resolve / reject 两条路都先解绑。
      const onAbort = () => {
        if (this.pendingRequests.delete(requestId)) {
          signal?.removeEventListener("abort", onAbort);
          reject(new Error("Request aborted"));
        }
      };
      const detach = () => signal?.removeEventListener("abort", onAbort);

      this.pendingRequests.set(requestId, {
        resolve: (v: unknown) => {
          detach();
          resolve(v as T);
        },
        reject: (e: Error) => {
          detach();
          reject(e);
        },
        schema: schema as z.ZodType<unknown>,
      });

      signal?.addEventListener("abort", onAbort, { once: true });

      // 发送请求；写失败直接 reject（write 现在按条结算，这里拿到的就是这条请求自己的写错误）
      this.write(controlRequest).catch((err) => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          this.pendingRequests.delete(requestId);
          pending.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /**
   * 处理控制响应，匹配 pending 请求
   */
  private handleControlResponse(response: SDKControlResponse): void {
    const inner = response.response;
    const requestId = inner.request_id;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return; // 孤儿响应，忽略

    this.pendingRequests.delete(requestId);

    if (inner.subtype === "error") {
      pending.reject(new Error(inner.error));
      return;
    }

    // Zod 校验响应载荷
    const parsed = pending.schema.safeParse(inner.response);
    if (parsed.success) {
      pending.resolve(parsed.data);
    } else {
      pending.reject(new Error(`响应校验失败: ${parsed.error.message}`));
    }
  }

  /** 当前未决的控制请求数（测试 / 诊断用） */
  pendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /** 拒绝所有未决请求（关闭/中断时清理） */
  rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
