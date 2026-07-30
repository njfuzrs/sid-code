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

import { join, basename } from "node:path";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { getLogger } from "../debug/logger.ts";
import { sidPaths } from "../config/paths.ts";
import type { TraceUploaderInterface } from "./collector.ts";

// ─── 接口定义 ───

export interface UploadOptions {
  /** trajectory-platform URL，含路径前缀，如 http://<your-server>/traj */
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
  /**
   * 上传成功后是否删除本地文件（默认 false = 保留本地全量副本）。
   * false: 云端 + 本地各保留一份完整数据（开发调试阶段推荐）。
   * true: 上传确认后清理本地数据文件（仅保留 metadata snapshot + .uploaded 标记）。
   */
  deleteAfterUpload?: boolean;
  /**
   * §6.4:上传前是否据 events.jsonl 重算校正 traj cost。默认 true。
   * 修复前的历史会话 cost=0,上传到远端也是 0——开启后在上传前从 events.jsonl 的
   * AfterModelRaw.usage 重算 cost 并补写 traj,再上传校正后的值。
   */
  recomputeCostBeforeUpload?: boolean;
  /**
   * §6.4:重算 cost 所需的模型定价列表(携带权威 pricing/provider)。
   * 不传时只能走 model-registry 内置定价表。
   */
  availableModels?: import("../api/cost-tracker.ts").PricingModelEntry[];
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
      outputDir: sidPaths.trajectories(),
      deleteAfterUpload: false,
      recomputeCostBeforeUpload: true,
      availableModels: [],
      ...options,
    };
    // P1-5：队列文件从 outputDir 派生，而非全局 sidPaths.uploadQueue()。
    // 否则测试传 outputDir:tmpDir 以为隔离了，实际每跑一次就往真实 HOME 追加条目
    // （实测 ~/.sid-code/trajectories/.upload_queue.jsonl 里 1216 条 test-sess-001 垃圾）。
    this.retryQueuePath = join(this.opts.outputDir, ".upload_queue.jsonl");
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
    // §6.4：上传前据 events.jsonl 重算校正 traj cost（修复前历史会话 cost=0 / 中断会话偏低）。
    // best-effort：失败只告警不阻断上传。
    this.recomputeCostIfNeeded(sessionDir);

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

    // 所有文件都确认后，按配置决定是否清理本地。
    // deleteAfterUpload=false（默认）：保留本地全量副本，云端 + 本地各一份。
    // deleteAfterUpload=true：上传确认后清理本地数据文件（保留 metadata snapshot + .uploaded 标记）。
    if (allConfirmed) {
      if (this.opts.deleteAfterUpload) {
        this.cleanupLocal(sessionDir, sessionId);
      } else {
        // 不删本地，但仍写 .uploaded 标记 + metadata snapshot，供 wrapper/评测识别"已上传"
        this.markUploadedKeepLocal(sessionDir, sessionId);
      }
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

  // ─── §6.4 上传前 cost 校正 ───

  /**
   * §6.4：据 events.jsonl 的 AfterModelRaw.usage 重算 cost，在 traj 缺失/cost 偏低时补写。
   *
   * 调用时机：uploadSession 上传前、processRetryQueue 重传 traj 前。
   * 幂等：backfillTrajCost 内部用 metadata.cost_recomputed_from_events 标记去重。
   * best-effort：任何异常只告警，绝不阻断上传主流程。
   */
  private recomputeCostIfNeeded(sessionDir: string): void {
    if (!this.opts.recomputeCostBeforeUpload) return;
    try {
      // 同步 require 形式动态加载，避免上传器与 cost-recompute 形成顶层循环依赖
      const { backfillTrajCost } = require("./cost-recompute.ts") as typeof import("./cost-recompute.ts");
      const result = backfillTrajCost(sessionDir, this.opts.availableModels);
      if (result.backfilled) {
        getLogger().info(
          "TRACE",
          `§6.4 上传前 cost 校正: ${sessionDir} ${result.reason}（$${(result.oldCost ?? 0).toFixed(4)} → $${(result.recomputedCost ?? 0).toFixed(4)}）`,
        );
      }
    } catch (err) {
      getLogger().warn("TRACE", `§6.4 上传前 cost 校正失败（不阻断上传）: ${err}`);
    }
  }

  // ─── 持久化重试队列 ───

  /**
   * 追加条目到持久化重试队列
   * 文件：{outputDir}/.upload_queue.jsonl
   * 进程重启后能恢复未完成的上传
   *
   * P1-6：去重——同一 (session_id, file) 已在队列且仍 pending 时跳过，
   * 不追加新行。原先纯 appendFileSync，同一文件反复失败就反复追加，
   * 队列里同一条目可以有几十份副本。
   */
  private appendToRetryQueue(sessionId: string, fileName: string): void {
    try {
      // P1-6：去重——检查是否已有同 (session_id, file) 的 pending 条目
      if (existsSync(this.retryQueuePath)) {
        const existing = readFileSync(this.retryQueuePath, "utf-8");
        const key = `${sessionId}\u0000${fileName}`;
        for (const line of existing.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as QueueEntry;
            if (`${entry.session_id}\u0000${entry.file}` === key && entry.status !== "failed") {
              return; // 已在队列中，跳过
            }
          } catch { /* 损坏行跳过 */ }
        }
      }
      const entry: QueueEntry = {
        session_id: sessionId,
        file: fileName,
        added_at: new Date().toISOString(),
        attempts: 0,
        last_error: "",
        status: "pending",
      };
      // P1-5：目录从 outputDir 派生，与 retryQueuePath 保持一致
      const dir = this.opts.outputDir;
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

        // §6.4：重传 traj 前先据 events.jsonl 校正 cost（历史队列里的 cost=0 会话）
        if (fileType === "traj") {
          this.recomputeCostIfNeeded(sessionDir);
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

    // P1-6：队列条目封顶——超限丢最旧（队列是 append 的，前面的更旧）。
    // 审计文档实测：attempts>=50 的 failed 条目永久保留无封顶，队列只增不减。
    // 此处 5000 条上限约覆盖 5000 个 (session_id,file) 组合，超限按 FIFO 丢弃最旧条目。
    const MAX_QUEUE_ENTRIES = 5000;
    let finalRemaining = remaining;
    if (remaining.length > MAX_QUEUE_ENTRIES) {
      const dropped = remaining.length - MAX_QUEUE_ENTRIES;
      finalRemaining = remaining.slice(remaining.length - MAX_QUEUE_ENTRIES);
      getLogger().warn(
        "TRACE",
        `重试队列超限（${remaining.length} > ${MAX_QUEUE_ENTRIES}），丢弃最旧 ${dropped} 条`,
      );
    }

    // 重写队列文件
    try {
      const newContent = finalRemaining.length
        ? finalRemaining.join("\n") + "\n"
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
   *
   * 注：在删除 session.traj 之前，把核心 metadata（exit_status / tools_used /
   * total_steps / total_tokens 等）抽出来写到 metadata.json，供 wrapper /
   * 评测脚本继续读取——否则 SessionEnd 上传成功后本地清空，下游评测拿不到 metadata，
   * 会让 tool_compliance / efficiency / cost 维度全部判误（详见 case_002/005 0.6 问题分析）。
   */
  private cleanupLocal(sessionDir: string, sessionId: string): void {
    try {
      // 上传成功 + 删本地之前，先备份精简 metadata，给评测/wrapper 继续读
      this.persistMetadataSnapshot(sessionDir);

      // 写标记文件
      const marker = join(sessionDir, ".uploaded");
      writeFileSync(
        marker,
        JSON.stringify({
          confirmed_at: new Date().toISOString(),
          session_id: sessionId,
        }),
      );
      // 删除数据文件（保留目录、标记 + metadata snapshot）
      for (const [, fileName] of FILE_TYPE_MAP) {
        const fp = join(sessionDir, fileName);
        if (existsSync(fp)) unlinkSync(fp);
      }
    } catch (err) {
      getLogger().warn("TRACE", `清理本地文件失败: ${err}`);
    }
  }

  /**
   * 标记"已上传"但保留本地全量数据文件（deleteAfterUpload=false 时调用）。
   * 写 .uploaded 标记 + metadata snapshot，供 wrapper/评测识别该会话已同步到云端，
   * 但不删除 session.traj / raw.jsonl / events.jsonl 等数据文件——本地继续可读。
   */
  private markUploadedKeepLocal(sessionDir: string, sessionId: string): void {
    try {
      this.persistMetadataSnapshot(sessionDir);
      const marker = join(sessionDir, ".uploaded");
      writeFileSync(
        marker,
        JSON.stringify({
          confirmed_at: new Date().toISOString(),
          session_id: sessionId,
          kept_local: true,
        }),
      );
    } catch (err) {
      getLogger().warn("TRACE", `写入 .uploaded 标记失败: ${err}`);
    }
  }

  /** 把 session.traj 的 metadata 字段单独存一份，让评测/wrapper 在 cleanup 后仍能读到 */
  private persistMetadataSnapshot(sessionDir: string): void {
    try {
      const trajPath = join(sessionDir, "session.traj");
      if (!existsSync(trajPath)) return;
      const content = readFileSync(trajPath, "utf-8");
      const obj = JSON.parse(content);
      const md = obj?.metadata;
      if (!md) return;
      // 只保留评测/wrapper 真正需要的字段，避免文件膨胀
      const snapshot = {
        session_id: md.session_id,
        model: md.model,
        // ★§6.4：/model 切换后归因对照（仅 session.traj 里存在时才带；未切换则无此字段）。
        ...(md.model_at_start ? { model_at_start: md.model_at_start } : {}),
        start_time: md.start_time,
        end_time: md.end_time,
        total_steps: md.total_steps,
        total_api_calls: md.total_api_calls,
        total_tokens: md.total_tokens,
        total_cost_usd: md.total_cost_usd,
        exit_status: md.exit_status,
        end_source: md.end_source,
        tools_used: md.tools_used,
        files_edited: md.files_edited,
        error: md.error,
      };
      writeFileSync(join(sessionDir, "metadata.json"), JSON.stringify(snapshot, null, 2));
    } catch (err) {
      getLogger().warn("TRACE", `备份 metadata snapshot 失败: ${err}`);
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

  /** 获取上传平台 URL（/debug 显示用） */
  getBaseUrl(): string { return this.opts.baseUrl; }

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
