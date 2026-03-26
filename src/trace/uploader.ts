/**
 * 上传管理器
 * 企业级可靠上传，对齐 data-reliability-plan：
 * - 5 次指数退避重试（2s→4s→8s→16s→32s）
 * - 持久化重试队列（~/.sid-code/.upload_queue.jsonl），进程重启后恢复
 * - 服务端心跳检测，不可达时直接入队不等超时
 * - SHA256 端到端校验（客户端计算 + 服务端二次校验）
 * - 所有文件确认后才清理本地 + 写 .uploaded 标记（原子清理）
 *
 * 实现 TraceUploaderInterface，可直接注入 TraceCollector。
 */

import { homedir } from "node:os";
import { join, basename } from "node:path";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { getLogger } from "../debug/logger.ts";
import type { TraceUploaderInterface } from "./collector.ts";

// ─── 接口定义 ───

export interface UploadOptions {
  /** trajectory-platform URL，含路径前缀，如 http://121.196.144.227/traj */
  baseUrl: string;
  /** X-Upload-Token 认证 token */
  token: string;
  /** 工具来源标识，默认 "sid-code" */
  toolSource?: string;
  /** 单文件最大重试次数，默认 5（对齐 data-reliability-plan） */
  maxRetries?: number;
  /** 指数退避基数毫秒，默认 2000（即 2s→4s→8s→16s→32s） */
  retryBaseMs?: number;
  /** 是否 gzip 压缩后上传，默认 true */
  compress?: boolean;
  /** 用户标识（多用户场景区分来源） */
  userId?: string;
  /** 设备标识 */
  deviceId?: string;
  /**
   * 本地输出基础目录（用于重试队列中路径解析）
   * 默认 ~/.sid-code/trajectories
   */
  outputDir?: string;
}

export interface FileUploadResult {
  fileType: "traj" | "raw" | "events";
  status: "uploaded" | "skipped" | "failed";
  sha256?: string;
  reason?: string;
}

export interface UploadResult {
  sessionId: string;
  files: FileUploadResult[];
  /** 所有文件都上传成功（uploaded 或 skipped） */
  allConfirmed: boolean;
}

/** 持久化重试队列中的条目 */
interface QueueEntry {
  session_id: string;
  /** 文件名，如 "session.traj" */
  file: string;
  added_at: string;
  attempts: number;
  last_error: string;
  status: "pending" | "failed";
}

/** 文件类型与文件名的映射（处理顺序：traj → raw → events） */
const FILE_TYPE_MAP: Array<["traj" | "raw" | "events", string]> = [
  ["traj", "session.traj"],
  ["raw", "raw.jsonl"],
  ["events", "events.jsonl"],
];

// ─── 主类 ───

export class UploadManager implements TraceUploaderInterface {
  private readonly opts: Required<UploadOptions>;
  /** 服务端是否可达（由心跳检测维护） */
  private serverReachable = true;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** 持久化重试队列文件路径 */
  private readonly retryQueuePath: string;

  constructor(options: UploadOptions) {
    this.opts = {
      toolSource: "sid-code",
      maxRetries: 5,
      retryBaseMs: 2000,
      compress: true,
      userId: "",
      deviceId: "",
      outputDir: join(homedir(), ".sid-code", "trajectories"),
      ...options,
    };
    this.retryQueuePath = join(homedir(), ".sid-code", ".upload_queue.jsonl");
  }

  // ─── 服务端心跳检测 ───

  /**
   * 启动心跳检测
   * 定时 GET {baseUrl}/api/v1/health，更新 serverReachable 状态
   * @param intervalMs 检测间隔，默认 60 秒
   */
  startHealthCheck(intervalMs = 60_000): void {
    // 立即检测一次
    this.checkHealth();
    const timer = setInterval(() => this.checkHealth(), intervalMs);
    // 不阻塞进程退出
    (timer as any).unref?.();
    this.healthCheckTimer = timer;
  }

  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      const resp = await fetch(`${this.opts.baseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      this.serverReachable = resp.ok;
    } catch {
      this.serverReachable = false;
    }
  }

  // ─── 核心上传逻辑 ───

  /**
   * 上传整个会话（三个文件）
   * - 服务端不可达时，直接进持久化重试队列，不浪费时间等超时
   * - 逐文件独立重试，不因一个失败放弃其他
   * - 所有文件确认后才清理本地（原子性）
   */
  async uploadSession(sessionDir: string, sessionId: string): Promise<UploadResult> {
    // 服务端不可达，直接进重试队列
    if (!this.serverReachable) {
      getLogger().warn("TRACE", "服务端不可达，上传任务进入重试队列");
      for (const [, fileName] of FILE_TYPE_MAP) {
        if (existsSync(join(sessionDir, fileName))) {
          this.appendToRetryQueue(sessionId, fileName);
        }
      }
      return { sessionId, files: [], allConfirmed: false };
    }

    const results: FileUploadResult[] = [];
    let allConfirmed = true;

    for (const [fileType, fileName] of FILE_TYPE_MAP) {
      const filePath = join(sessionDir, fileName);
      if (!existsSync(filePath)) {
        results.push({ fileType, status: "skipped", reason: "文件不存在" });
        continue;
      }

      const result = await this.uploadFileWithRetry(filePath, sessionId, fileType);
      results.push(result);

      if (result.status === "failed") {
        allConfirmed = false;
        this.appendToRetryQueue(sessionId, fileName);
      }
    }

    // 所有文件都确认后才清理本地
    if (allConfirmed) {
      this.cleanupLocal(sessionDir, sessionId);
    }

    return { sessionId, files: results, allConfirmed };
  }

  /**
   * 上传单个文件（5 次指数退避重试 + SHA256 二次校验）
   * 对齐 claude-trace uploader.py 的 _upload_single_file
   */
  async uploadFileWithRetry(
    filePath: string,
    sessionId: string,
    fileType: "traj" | "raw" | "events",
  ): Promise<FileUploadResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.opts.maxRetries; attempt++) {
      try {
        // 读取 + 压缩 + 计算 SHA256（对齐 claude-trace 的 compress_and_hash）
        let content: Uint8Array = await readFile(filePath);
        if (this.opts.compress) {
          content = Bun.gzipSync(content, { level: 6 });
        }
        const sha256 = this.computeSha256(content);

        // 构建 FormData（对齐 claude-trace uploader.py 的 _upload_single_file）
        const formData = new FormData();
        const uploadName = this.opts.compress
          ? `${basename(filePath)}.gz`
          : basename(filePath);
        const contentType = this.opts.compress ? "application/gzip" : "application/octet-stream";
        formData.append("file", new Blob([content], { type: contentType }), uploadName);
        formData.append("session_id", sessionId);
        formData.append("file_type", fileType);
        formData.append("tool_source", this.opts.toolSource);
        if (this.opts.userId) formData.append("user_id", this.opts.userId);
        if (this.opts.deviceId) formData.append("device_id", this.opts.deviceId);

        // 发送请求（30 秒超时）
        const response = await fetch(
          `${this.opts.baseUrl}/api/v1/upload/session-file`,
          {
            method: "POST",
            headers: {
              "X-Upload-Token": this.opts.token,
              "X-Content-SHA256": sha256,
            },
            body: formData,
            signal: AbortSignal.timeout(30_000),
          },
        );

        // ── 响应处理（适配平台实际返回格式） ──
        if (response.ok) {
          // traj: 返回 { status: "created"|"updated", ... }
          // raw/events: 返回 { status: "saved", sha256, oss_key }
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          // 二次校验：服务端返回了非空 sha256 时才校验（与本地一致）
          if (typeof body.sha256 === "string" && body.sha256 !== "" && body.sha256 !== sha256) {
            lastError = new Error(
              `服务端 hash 不一致: local=${sha256}, server=${body.sha256}`,
            );
            continue; // 重试
          }
          return { fileType, status: "uploaded", sha256 };
        }

        if (response.status === 409) {
          // 已存在，跳过（幂等）
          // traj: 409 返回字符串 detail；raw/events: 200 + { status: "skipped" }
          return { fileType, status: "skipped", reason: "already exists" };
        }

        if (response.status === 401) {
          // 认证失败，不重试
          return { fileType, status: "failed", reason: "invalid token" };
        }

        if (response.status === 400) {
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          const detail =
            typeof body.detail === "object" && body.detail !== null
              ? (body.detail as Record<string, unknown>)
              : body;
          if (detail.error === "hash_mismatch") {
            lastError = new Error(
              `hash mismatch: expected=${detail.expected}, actual=${detail.actual}`,
            );
            continue; // 重试
          }
          return {
            fileType,
            status: "failed",
            reason: JSON.stringify(body.detail ?? body),
          };
        }

        // 5xx 及其他服务端错误，重试
        lastError = new Error(`HTTP ${response.status}`);
      } catch (err: any) {
        lastError = err;
      }

      // 指数退避：2s, 4s, 8s, 16s, 32s
      if (attempt < this.opts.maxRetries - 1) {
        const delay = this.opts.retryBaseMs * Math.pow(2, attempt);
        getLogger().warn(
          "TRACE",
          `上传失败 ${sessionId}/${fileType} 第${attempt + 1}次: ${lastError?.message}，${delay / 1000}s 后重试`,
        );
        await sleep(delay);
      }
    }

    return {
      fileType,
      status: "failed",
      reason: lastError?.message ?? "unknown error",
    };
  }

  // ─── 持久化重试队列 ───

  /**
   * 追加条目到持久化重试队列
   * 文件：~/.sid-code/.upload_queue.jsonl
   * 进程重启后能恢复未完成的上传
   */
  private appendToRetryQueue(sessionId: string, fileName: string): void {
    try {
      const entry: QueueEntry = {
        session_id: sessionId,
        file: fileName,
        added_at: new Date().toISOString(),
        attempts: 0,
        last_error: "",
        status: "pending",
      };
      const dir = join(homedir(), ".sid-code");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.retryQueuePath, JSON.stringify(entry) + "\n");
    } catch (err) {
      getLogger().warn("TRACE", `写入重试队列失败: ${err}`);
    }
  }

  /**
   * 扫描持久化重试队列，逐条重试
   * 启动时调用一次，之后定时调用（间隔由外部配置）
   * 最多重试 50 次（覆盖约 24 小时），超过后标记为 failed 保留供人工排查
   */
  async processRetryQueue(): Promise<void> {
    if (!existsSync(this.retryQueuePath)) return;

    let raw: string;
    try {
      raw = await readFile(this.retryQueuePath, "utf-8");
    } catch {
      return;
    }

    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return;

    const remaining: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as QueueEntry;

        // 超过最大重试次数，保留供人工排查
        if (entry.status === "failed" || entry.attempts >= 50) {
          remaining.push(JSON.stringify({ ...entry, status: "failed" }));
          continue;
        }

        // 尝试上传
        const sessionDir = join(this.opts.outputDir, "sessions", entry.session_id);
        const filePath = join(sessionDir, entry.file);

        if (!existsSync(filePath)) {
          // 文件不存在（可能已被清理），直接跳过
          continue;
        }

        const fileType = fileNameToType(entry.file);
        if (!fileType) {
          // 未知文件类型，跳过
          continue;
        }

        const result = await this.uploadFileWithRetry(filePath, entry.session_id, fileType);

        if (result.status === "uploaded" || result.status === "skipped") {
          // 上传成功，不再保留
          continue;
        }

        // 仍然失败，更新重试次数
        remaining.push(
          JSON.stringify({
            ...entry,
            attempts: entry.attempts + 1,
            last_error: result.reason ?? "",
          }),
        );
      } catch {
        // 解析失败，保留原样
        remaining.push(line);
      }
    }

    // 重写队列文件
    try {
      const newContent = remaining.length
        ? remaining.join("\n") + "\n"
        : "";
      await writeFile(this.retryQueuePath, newContent);
    } catch (err) {
      getLogger().warn("TRACE", `重写重试队列失败: ${err}`);
    }
  }

  // ─── 确认后清理本地 ───

  /**
   * 所有文件确认上传后，清理本地临时数据
   * 先写 .uploaded 标记，再删除数据文件（确保不会因中途崩溃丢失标记）
   */
  private cleanupLocal(sessionDir: string, sessionId: string): void {
    try {
      // 写标记文件
      const marker = join(sessionDir, ".uploaded");
      writeFileSync(
        marker,
        JSON.stringify({
          confirmed_at: new Date().toISOString(),
          session_id: sessionId,
        }),
      );
      // 删除数据文件（保留目录和标记）
      for (const [, fileName] of FILE_TYPE_MAP) {
        const fp = join(sessionDir, fileName);
        if (existsSync(fp)) unlinkSync(fp);
      }
    } catch (err) {
      getLogger().warn("TRACE", `清理本地文件失败: ${err}`);
    }
  }

  // ─── 辅助 ───

  private computeSha256(data: Uint8Array): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(data);
    return hasher.digest("hex");
  }

  /** 当前服务端可达性状态（供测试和调试使用） */
  isServerReachable(): boolean {
    return this.serverReachable;
  }

  /** 手动设置服务端可达性（供测试注入） */
  setServerReachable(reachable: boolean): void {
    this.serverReachable = reachable;
  }

  /** 持久化重试队列路径（供测试访问） */
  getRetryQueuePath(): string {
    return this.retryQueuePath;
  }
}

// ─── 辅助函数 ───

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fileNameToType(fileName: string): "traj" | "raw" | "events" | null {
  if (fileName === "session.traj") return "traj";
  if (fileName === "raw.jsonl") return "raw";
  if (fileName === "events.jsonl") return "events";
  return null;
}
