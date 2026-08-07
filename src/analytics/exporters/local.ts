// src/analytics/exporters/local.ts
// 本地事件后端——将 logEvent 事件持久化到 JSONL
//
// 对应 spec 17 §3.2 路由架构中的 LocalBackend。
// 特权后端:stripProtected=false,看到完整数据(含 _PROTECTED_* 字段)。
// 接受所有事件,追加写入 ~/.sid-code/telemetry/events.jsonl(异步,fire-and-forget)。

import { appendFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { sidPaths } from "../../config/paths.ts";
import type { SinkBackend } from "../sink.ts";
import type { EventMetadata } from "../index.ts";
import {
  extractProtectedFields,
  hasProtectedFields,
  stripProtectedFields,
} from "../privacy.ts";

const EVENTS_FILE = "events.jsonl";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_FILES = 5;

export class LocalEventBackend implements SinkBackend {
  readonly name = "local";
  readonly stripProtected = false;

  private dir: string;
  private filePath: string;
  private dirCreated = false;
  /** 串行化写入,避免并发 append 交错 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private sessionId: string,
    dir: string = sidPaths.telemetry(),
  ) {
    this.dir = dir;
    this.filePath = join(dir, EVENTS_FILE);
  }

  accepts(_eventName: string): boolean {
    return true;
  }

  send(eventName: string, metadata: EventMetadata): void {
    // P1-7：_PROTECTED_ 双通道此前只有「剥离」这一半在用（sink 对非特权后端调
    // stripProtectedFields），「提取」与「检测」两个函数零消费者。本后端是**特权**
    // 后端（stripProtected=false），正是双通道设计里该拿到完整数据的那一侧——
    // 把受保护字段提取到独立的 `protected` 段，而不是与普通字段混在一个平铺对象里。
    //
    // 为什么值得分段而不是原样落盘：下游消费方（digest / 聚合脚本 / 未来的远程转发）
    // 需要能**一眼区分**哪些字段是敏感的。混在一起时，任何新加的消费方都得自己重新
    // 实现一遍前缀判断才知道什么不能外传——而漏掉这层判断是静默的。分段后
    // 「不要外传 protected 段」是结构性约束，不依赖每个消费方各自记得。
    const hasProtected = hasProtectedFields(metadata);
    const record: Record<string, unknown> = {
      eventName,
      sessionId: this.sessionId,
      timestamp: Date.now(),
    };
    if (hasProtected) {
      // 普通字段用剥离版（去掉 _PROTECTED_*），敏感字段去前缀后单独成段
      record.metadata = stripProtectedFields(metadata);
      record.protected = extractProtectedFields(metadata);
    } else {
      // 零拷贝快路径：绝大多数事件不含受保护字段
      record.metadata = metadata;
    }

    const line = JSON.stringify(record) + "\n";

    // 串行追加,错误静默(遥测旁路)
    this.writeChain = this.writeChain
      .then(() => this.write(line))
      .catch(() => {});
  }

  async shutdown(): Promise<void> {
    // 等待挂起的写入完成
    await this.writeChain.catch(() => {});
  }

  private async write(line: string): Promise<void> {
    if (!this.dirCreated) {
      await mkdir(this.dir, { recursive: true });
      this.dirCreated = true;
    }
    await appendFile(this.filePath, line, "utf-8");
    await this.rotateIfNeeded();
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.filePath);
      if (info.size < MAX_FILE_SIZE) return;
    } catch {
      return;
    }
    const prefix = "events";
    const oldest = join(this.dir, `${prefix}.${MAX_FILES}.jsonl`);
    try { await unlink(oldest); } catch {}
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = join(this.dir, `${prefix}.${i}.jsonl`);
      const to = join(this.dir, `${prefix}.${i + 1}.jsonl`);
      try { await rename(from, to); } catch {}
    }
    try { await rename(this.filePath, join(this.dir, `${prefix}.1.jsonl`)); } catch {}
  }
}
