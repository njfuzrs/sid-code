/**
 * initTraceCollector 的两道上传闸（轨迹上传文档核对时发现的两处「配了不生效」）
 *
 * 1. `analytics.privacy_level: "essential-traffic"` 写在 settings.json 里时拦不住轨迹上传：
 *    配置级隐私等级原本只在 initTelemetrySystem 里注入，而它在 initTraceCollector 之后才跑。
 * 2. `trace.upload.auto_upload: false` 原本无人读取，照样启动心跳 / 队列扫描定时器。
 *
 * 用「是否 log 了某条 TRACE 行」之外的可观测量断言：collector 的 getUploadUrl()
 * 只有 uploader 存在时才有值；essential-traffic 下必须为 undefined。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initTraceCollector } from "@sid-code/core/query/init-helpers.ts";
import { setConfiguredPrivacyLevel } from "@sid-code/core/analytics/privacy-level.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";

const ENV_KEYS = ["SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "SID_CODE_DISABLE_TELEMETRY"];

describe("initTraceCollector 上传闸", () => {
  let outDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "sid-trace-gate-"));
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    setConfiguredPrivacyLevel(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setConfiguredPrivacyLevel(null);
    rmSync(outDir, { recursive: true, force: true });
  });

  function makeConfig(extra: Record<string, unknown> = {}, upload: Record<string, unknown> = {}) {
    return {
      trace: {
        enabled: true,
        outputDir: outDir,
        upload: { url: "http://127.0.0.1:9/traj", token: "t", ...upload },
      },
      ...extra,
    } as any;
  }

  test("配置文件 privacy_level=essential-traffic（无环境变量）也禁用上传", async () => {
    const c = await initTraceCollector(
      makeConfig({ analytics: { privacyLevel: "essential-traffic" } }),
      new HookSystem(),
    );
    expect(c).not.toBeNull();
    expect(c!.getUploadUrl()).toBeUndefined();
  });

  test("默认隐私级别：配了 url+token 即挂上 uploader", async () => {
    const c = await initTraceCollector(makeConfig(), new HookSystem());
    expect(c!.getUploadUrl()).toBe("http://127.0.0.1:9/traj");
  });
});
