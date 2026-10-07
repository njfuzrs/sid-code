/**
 * JSONL 文件导出器
 * 零依赖、零配置、零成本的本地持久化方案
 * 支持日志轮转（默认 50MB，保留 5 个文件）
 *
 * ⚠️ 轮转后数据分布在 `traces.jsonl` + `traces.1.jsonl` … `traces.N.jsonl`，
 * 离线消费方**必须**用 {@link listJsonlGenerations} 读全部代，只读固定名会在轮转后
 * 静默少数据且不报错（缺陷 20，20260927 可观测性审计）。
 */

import { appendFile, mkdir, stat, rename, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { sidPaths } from "../../config/paths.ts";
import type { SpanData, MetricPoint, TelemetryExporter } from "../types.ts";

export interface JsonlExporterOptions {
  /** 输出目录，默认 ~/.sid-code/telemetry/ */
  outputDir: string;
  /**
   * 单文件最大大小（字节），默认 50MB。**写前检查**：本批写入会越线就先轮转再写，
   * 所以只有「单批本身就超过上限」时文件才会超限（缺陷 20：曾是写后检查，
   * 峰值 = 上限 + 单批大小，配置名读起来却像硬上限）。
   */
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
    const lines = spans.map((s) => JSON.stringify(s)).join("\n") + "\n";
    await this.rotateIfNeeded(this.spanFile, "traces", Buffer.byteLength(lines, "utf-8"));
    await appendFile(this.spanFile, lines, "utf-8");
  }

  async exportMetrics(metrics: MetricPoint[]): Promise<void> {
    if (metrics.length === 0) return;
    await this.ensureDir();
    const lines = metrics.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await this.rotateIfNeeded(this.metricFile, "metrics", Buffer.byteLength(lines, "utf-8"));
    await appendFile(this.metricFile, lines, "utf-8");
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

  /**
   * 写前检查：现有大小 + 即将写入的字节数超过阈值时先轮转。
   * 现有文件为空（或不存在）时不轮转 —— 单批本身超限也只能整批写进新文件，切不出更小的。
   */
  private async rotateIfNeeded(
    filePath: string,
    prefix: string,
    incomingBytes: number,
  ): Promise<void> {
    try {
      const info = await stat(filePath);
      if (info.size === 0 || info.size + incomingBytes <= this.options.maxFileSize) return;
    } catch {
      return; // 文件不存在
    }

    // 轮转：traces.jsonl → traces.1.jsonl → traces.2.jsonl → ...
    // 删除最旧的
    const oldest = join(this.options.outputDir, `${prefix}.${this.options.maxFiles}.jsonl`);
    try {
      await unlink(oldest);
    } catch {}

    // 依次重命名
    for (let i = this.options.maxFiles - 1; i >= 1; i--) {
      const from = join(this.options.outputDir, `${prefix}.${i}.jsonl`);
      const to = join(this.options.outputDir, `${prefix}.${i + 1}.jsonl`);
      try {
        await rename(from, to);
      } catch {}
    }

    // 当前文件 → .1
    const first = join(this.options.outputDir, `${prefix}.1.jsonl`);
    try {
      await rename(filePath, first);
    } catch {}
  }
}

/**
 * 列出某个 JSONL 导出文件的全部轮转代，**从旧到新**：
 * `prefix.N.jsonl` … `prefix.1.jsonl`, `prefix.jsonl`（只返回存在的）。
 *
 * 缺陷 20：轮转与消费方曾无约定 —— 按固定名 `traces.jsonl` 读的离线复算
 * 在轮转后只看得到轮转之后的数据，数字偏小且不报错。读 OTel 本地落盘一律走这里。
 * `maxGenerations` 与导出器 `maxFiles` 同义；扫描到第一个缺号即止（轮转是连续改名）。
 */
export function listJsonlGenerations(
  dir: string,
  prefix: "traces" | "metrics",
  maxGenerations = 50,
): string[] {
  const out: string[] = [];
  for (let i = 1; i <= maxGenerations; i++) {
    const p = join(dir, `${prefix}.${i}.jsonl`);
    if (!existsSync(p)) break;
    out.push(p);
  }
  out.reverse();
  const current = join(dir, `${prefix}.jsonl`);
  if (existsSync(current)) out.push(current);
  return out;
}
