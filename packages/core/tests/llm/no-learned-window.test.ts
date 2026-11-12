/**
 * S6 撤销后的反漂移哨兵。
 *
 * 背景：S6「运行时学习已放行输入上限」把「输入 + max_tokens 撞窗口」的 400 误判成
 * 「窗口只有 664k」，落盘 learned-input-ceiling.json 覆盖注册表窗口，Footer 百分比
 * 与压缩 / 遮罩阈值全部按错的分母算。方案文档 §5.2 决定整体撤销，不保留开关。
 *
 * 这道哨兵防的是「下一个 agent 看到网关 400 后没有学习，又把 S6 提议一遍」：
 * 即使磁盘上放着一份格式完全合法、7 天内有效的旧学习文件，窗口也必须只来自
 * 用户声明 / 注册表 / 采集缓存 / 兜底常量这四层静态数据源。
 *
 * 变异自证（2026-11-12 实做）：把读取点（`lookupAdmittedCeiling` + `source: "learned"`）
 * 加回 token-estimator.ts 的 resolveContextLimit，本文件必须变红。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenEstimator } from "@sid-code/core/llm/token-estimator.ts";
import { sidHomePath } from "@sid-code/core/config/paths.ts";

/** 注册表精确命中：contextWindow 1_000_000（model-registry.ts 的 deepseek-v4-1-flash） */
const MODEL = "deepseek-v4-1-flash";
const URL_A = "https://gw-a.example.com/v1";

/** 除「用户声明」「学到的」以外的静态来源——S6 之后只允许这四种 */
const STATIC_SOURCES = ["registry", "catalog", "fuzzy", "fallback"] as const;

let dir: string;
let prevDir: string | undefined;

beforeEach(() => {
  prevDir = process.env.SID_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "sid-no-learned-"));
  process.env.SID_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

/** 写一份「S6 当年会写出」的有效记录：7 天内、已学到 300k */
function writeLegacyLearnedFile(): void {
  const now = Date.now();
  writeFileSync(
    sidHomePath("learned-input-ceiling.json"),
    JSON.stringify({
      schema_version: 1,
      entries: {
        [`${MODEL}@${URL_A}`]: {
          overflows: 2,
          maxAdmitted: 300_000,
          ceiling: 300_000,
          firstOverflowAt: now - 60_000,
          learnedAt: now,
        },
      },
    }),
    "utf8",
  );
}

describe("S6 已撤销：窗口只来自静态数据源，不读运行时学习结果", () => {
  it("磁盘上有有效的旧 learned-input-ceiling.json，resolveContextLimit 仍返回注册表值", () => {
    writeLegacyLearnedFile();
    const est = new TokenEstimator();
    const r = est.resolveContextLimit(MODEL, [{ name: MODEL, baseURL: URL_A }]);

    expect(STATIC_SOURCES as readonly string[]).toContain(r.source);
    expect(r.source).not.toBe("learned");
    // 旧文件学到的是 300k；窗口必须显著大于它，说明没有取 min
    expect(r.value).toBeGreaterThan(300_000);
  });

  it("同一个旧文件不影响 getContextLimit（占位窗口 / 压缩阈值同源）", () => {
    writeLegacyLearnedFile();
    const est = new TokenEstimator();
    expect(est.getContextLimit(MODEL, [{ name: MODEL, baseURL: URL_A }])).toBeGreaterThan(300_000);
    // availableModels 条目不带 baseURL 时也不受影响（S6 曾按 (model, base_url) 查）
    expect(est.getContextLimit(MODEL)).toBeGreaterThan(300_000);
  });

  it("文件不存在时行为不变（不因缺少学习文件而退化）", () => {
    const est = new TokenEstimator();
    const r = est.resolveContextLimit(MODEL, [{ name: MODEL, baseURL: URL_A }]);
    expect(STATIC_SOURCES as readonly string[]).toContain(r.source);
    expect(r.value).toBeGreaterThan(300_000);
  });
});
