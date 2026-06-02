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
import type { z } from "zod";
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

export class StructuredIO {
  /** 待处理的控制请求（request_id → Promise resolver） */
  private pendingRequests = new Map<string, PendingRequest>();
  /** 已解决的 tool_use ID（防重复，远程重连场景） */
  private resolvedToolUseIds = new Set<string>();
  /** 输出队列（保证写入序列化） */
  private writeQueue: StdoutMessage[] = [];
  private writing = false;

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
   * - 其他 → 作为 StdinMessage yield
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
          // 未知消息类型，仍 yield 给主循环兜底
          yield msg as unknown as StdinMessage;
      }
    }
  }

  /**
   * 写入 SDK 消息到输出流
   * 通过队列保证写入序列化，防止消息交错
   */
  async write(message: StdoutMessage): Promise<void> {
    this.writeQueue.push(message);
    if (this.writing) return;
    this.writing = true;

    try {
      while (this.writeQueue.length > 0) {
        const msg = this.writeQueue.shift()!;
        const line = ndjsonStringify(msg) + "\n";
        await new Promise<void>((resolve) => {
          const ok = this.output.write(line, "utf-8");
          if (ok) resolve();
          else this.output.once("drain", () => resolve());
        });
      }
    } finally {
      this.writing = false;
    }
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

      this.pendingRequests.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        schema: schema as z.ZodType<unknown>,
      });

      signal?.addEventListener(
        "abort",
        () => {
          if (this.pendingRequests.delete(requestId)) {
            reject(new Error("Request aborted"));
          }
        },
        { once: true },
      );

      // 发送请求；写失败直接 reject
      this.write(controlRequest).catch((err) => {
        if (this.pendingRequests.delete(requestId)) {
          reject(err instanceof Error ? err : new Error(String(err)));
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

  /**
   * 追踪已解决的 tool_use ID，防止重复处理
   * （远程场景下 WebSocket 重连可能导致重复投递）
   */
  trackResolvedToolUseId(toolUseId: string): void {
    this.resolvedToolUseIds.add(toolUseId);
    if (this.resolvedToolUseIds.size > 1000) {
      const first = this.resolvedToolUseIds.values().next().value;
      if (first !== undefined) this.resolvedToolUseIds.delete(first);
    }
  }

  isResolvedToolUseId(toolUseId: string): boolean {
    return this.resolvedToolUseIds.has(toolUseId);
  }

  /** 拒绝所有未决请求（关闭/中断时清理） */
  rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
