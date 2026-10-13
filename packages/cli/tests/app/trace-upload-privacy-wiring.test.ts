/**
 * PR-A2 接线反漂移（P0-3 / P2-1 / P1-11）
 *
 * 这几处接线删掉任何一条，单元测试都照样绿（被测函数本身没变），
 * 只有用户链路静默退化——所以用源码断言把它们钉住。
 * 产物级行为（水位迁移 / 新目标 / resume / --include-history）已在 PR 描述里用构建产物实测。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");
const CLI = read("packages/cli/src/cli.ts");
const UPLOADER = read("packages/core/src/trace/uploader.ts");
const PREFETCH = read("packages/cli/src/entrypoints/deferred-prefetch.ts");
const PRECONNECT = read("packages/cli/src/entrypoints/preconnect.ts");
const APP_TSX = read("packages/cli/src/ui/App.tsx");

function handleUploadTracesBody(): string {
  const start = CLI.indexOf("async function handleUploadTraces(");
  const end = CLI.indexOf("\n}\n", start);
  return CLI.slice(start, end);
}

describe("P2-1：--upload-traces 受隐私级别约束", () => {
  test("在构建 UploadManager 之前检查 essential-traffic 并退出", () => {
    const body = handleUploadTracesBody();
    const gate = body.indexOf("isEssentialTrafficOnly()");
    const mgr = body.indexOf("new UploadManager(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(mgr);
    // 配置文件的 privacy_level 必须先注入，否则只有环境变量能拦
    expect(body.indexOf("setConfiguredPrivacyLevel")).toBeLessThan(gate);
  });
});

describe("P0-3：补传水位接线", () => {
  test("启动时无条件建立水位基线（不只在配了上传时）", () => {
    expect(CLI).toContain("ensureUploadWatermarks(");
    // essential-traffic 下不登记目标，避免把未授权目标当成迁移
    expect(CLI).toMatch(/willUpload = [^;]*!isEssentialTrafficOnly\(\)/);
  });

  test("uploader 补传默认带水位，只有 includeHistory 才跳过", () => {
    expect(UPLOADER).toContain("getUploadWatermark(this.opts.baseUrl");
    expect(UPLOADER).toContain("watermarkMs: includeHistory ? undefined : watermarkMs");
  });

  test("--include-history 只经 --upload-traces 传入", () => {
    expect(CLI).toContain('"include-history": { type: "boolean" }');
    expect(handleUploadTracesBody()).toContain("includeHistory: opts.includeHistory === true");
  });
});

describe("P1-11：预连接取址", () => {
  test("不再有 api.anthropic.com 兜底", () => {
    expect(PRECONNECT).not.toContain('api.anthropic.com"');
    expect(PRECONNECT).not.toContain("DEFAULT_ANTHROPIC_BASE");
  });

  test("取址来自已解析 config，而不是只读环境变量", () => {
    expect(PREFETCH).not.toContain("preconnectApi(process.env.SID_CODE_LLM_BASE_URL)");
    expect(APP_TSX).toContain("startDeferredPrefetches(true, callbacks.config?.baseURL)");
  });
});
