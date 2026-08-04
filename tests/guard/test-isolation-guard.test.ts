/**
 * 测试隔离门禁测试（建议3）
 *
 * 背景：审计文档 P1-5 发现 uploader.test.ts 传了 outputDir:tmpDir 以为隔离了，
 * 实际 retryQueuePath 硬编码在全局 sidPaths.uploadQueue()，每跑一次测试就往
 * 真实 HOME 追加条目（实测 1216 条 test-sess-001 垃圾）。结合仓库里已有的
 * "计费测试未隔离 SID_CONFIG_DIR"问题，建议加一道门禁：
 *
 *   测试进程内若 sidHomePath() 解析到真实 $HOME，直接 fail。
 *
 * 本测试验证 tests/helpers/assert-isolated.ts 提供的可复用工具函数 assertIsolated()
 * 行为正确，供其他需要在 beforeEach 里调用的测试参考。
 *
 * ⚠ 订正（2026-08-04 实测）：原注释称"bun test 每文件独立进程，无法做跨文件自动守卫"，
 * **这是错的**。bun test 同一批多个文件跑在**同一个进程**里，env 会跨文件泄漏——
 * 实测 `bun test tests/permission` 单跑 delta=0，而 `bun test tests/migrations tests/permission`
 * 同批跑 delta=84（migrations 里无条件 `delete process.env.SID_CONFIG_DIR`，
 * 把隔离抹掉后 permission 的审计日志就写进了真实 HOME）。
 * 正因为同进程，全局 preload 是可行的，见 tests/preload-isolate-sid-home.ts。
 * 这个错误认知本身就是那道兜底长期缺失的原因。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { assertIsolated } from "../helpers/assert-isolated.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

const savedEnv = process.env.SID_CONFIG_DIR;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedEnv;
});

describe("assertIsolated 门禁工具（建议3）", () => {
  test("SID_CONFIG_DIR 未设置时 throw", () => {
    delete process.env.SID_CONFIG_DIR;
    expect(() => assertIsolated()).toThrow(/SID_CONFIG_DIR 未设置/);
  });

  test("SID_CONFIG_DIR 为空字符串时 throw", () => {
    process.env.SID_CONFIG_DIR = "";
    expect(() => assertIsolated()).toThrow(/SID_CONFIG_DIR 未设置/);
  });

  test("SID_CONFIG_DIR 指向真实 HOME 时 throw", () => {
    process.env.SID_CONFIG_DIR = join(homedir(), ".sid-code");
    expect(() => assertIsolated()).toThrow(/指向了真实 HOME/);
  });

  test("SID_CONFIG_DIR 指向 tmp 目录时不 throw", () => {
    process.env.SID_CONFIG_DIR = join(tmpdir(), "sid-code-test-isolated");
    expect(() => assertIsolated()).not.toThrow();
  });
});
