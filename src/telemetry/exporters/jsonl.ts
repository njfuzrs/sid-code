/**
 * JSONL 文件导出器
 * 零依赖、零配置、零成本的本地持久化方案
 * 支持日志轮转（默认 50MB，保留 5 个文件）
 */

import { appendFile, mkdir, stat, rename, unlink } from "fs/promises";
import { join, dirname } from "path";
import { sidPaths } from "../../config/paths.ts";
import type { SpanData, MetricPoint, TelemetryExporter } from "../types.ts";

export interface JsonlExporterOptions {
  /** 输出目录，默认 ~/.sid-code/telemetry/ */
  outputDir: string;
  /** 单文件最大大小（字节），超出后轮转，默认 50MB */
  maxFileSize: number;
  /** 最多保留几个轮转文件，默认 5 */
  maxFiles: number;
}

/** 默认配置（outputDir 运行时解析，响应 SID_CONFIG_DIR 切换） */
function defaultOptions(): JsonlExporterOptions {
  return {
    outputDir: sidPaths.telemetry(),
    maxFileSize: 50 * 1024 * 1024, // 50MB
    maxFiles: 5,
  };
}

export class JsonlExporter implements TelemetryExporter {
  readonly name = "jsonl";
  private options: JsonlExporterOptions;
  private spanFile: string;
  private metricFile: string;
  private _dirCreated = false;

  constructor(options?: Partial<JsonlExporterOptions>) {
    this.options = { ...defaultOptions(), ...options };
    this.spanFile = join(this.options.outputDir, "traces.jsonl");
    this.metricFile = join(this.options.outputDir, "metrics.jsonl");
  }

  async exportSpans(spans: SpanData[]): Promise<void> {
    // 空批次直接返回（与 otlp.ts 对齐）：`[].join("\n") + "\n"` 会写下一个裸换行符，
    // 上游一旦出空批次就会静默堆积垃圾字节（曾累积 190MB 纯 \n）。
    if (spans.length === 0) return;
    await this.ensureDir();
    const lines = spans.map(s => JSON.stringify(s)).join("\n") + "\n";
    await appendFile(this.spanFile, lines, "utf-8");
    await this.rotateIfNeeded(this.spanFile, "traces");
  }

  async exportMetrics(metrics: MetricPoint[]): Promise<void> {
    if (metrics.length === 0) return;
    await this.ensureDir();
    const lines = metrics.map(m => JSON.stringify(m)).join("\n") + "\n";
    await appendFile(this.metricFile, lines, "utf-8");
    await this.rotateIfNeeded(this.metricFile, "metrics");
  }

  async shutdown(): Promise<void> {
    // JSONL 是追加写入，无需特殊关闭
  }

  /** 获取 traces 文件路径（供外部查询） */
  getSpanFilePath(): string {
    return this.spanFile;
  }

  private async ensureDir(): Promise<void> {
    if (this._dirCreated) return;
    await mkdir(dirname(this.spanFile), { recursive: true });
    this._dirCreated = true;
  }

  /** 检查文件大小，超出阈值时轮转 */
  private async rotateIfNeeded(filePath: string, prefix: string): Promise<void> {
    try {
      const info = await stat(filePath);
      if (info.size < this.options.maxFileSize) return;
    } catch {
      return; // 文件不存在
    }

    // 轮转：traces.jsonl → traces.1.jsonl → traces.2.jsonl → ...
    // 删除最旧的
    const oldest = join(this.options.outputDir, `${prefix}.${this.options.maxFiles}.jsonl`);
    try { await unlink(oldest); } catch {}

    // 依次重命名
    for (let i = this.options.maxFiles - 1; i >= 1; i--) {
      const from = join(this.options.outputDir, `${prefix}.${i}.jsonl`);
      const to = join(this.options.outputDir, `${prefix}.${i + 1}.jsonl`);
      try { await rename(from, to); } catch {}
    }

    // 当前文件 → .1
    const first = join(this.options.outputDir, `${prefix}.1.jsonl`);
    try { await rename(filePath, first); } catch {}
  }
}
