/**
 * 测试隔离门禁工具（建议3）
 *
 * 背景：审计文档 P1-5 发现 uploader.test.ts 传了 outputDir:tmpDir 以为隔离了，
 * 实际 retryQueuePath 硬编码在全局 sidPaths.uploadQueue()，每跑一次测试就往
 * 真实 HOME 追加条目（实测 1216 条 test-sess-001 垃圾）。这类污染不只脏数据——
 * 它会误导后续排查，让人在错误方向上花时间。
 *
 * 本模块提供可复用的门禁函数 assertIsolated()，供需要隔离的测试在 beforeEach
 * 调用：如果 sidHomePath() 解析到真实 $HOME，直接 throw——fail 该测试。
 *
 * 用法：
 *   import { assertIsolated } from "../helpers/assert-isolated.ts";
 *   beforeEach(() => {
 *     process.env.SID_CONFIG_DIR = tmpDir;
 *     assertIsolated(); // 不指向真实 HOME 才继续
 *   });
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 断言当前测试进程的 sidHomePath() 不解析到真实 $HOME。
 *
 * 判据：getSidHome() 如果等于 join(homedir(), ".sid-code")，说明
 * SID_CONFIG_DIR 未设置或为空——测试会写真实 HOME，直接 fail。
 *
 * 建议所有涉及 sidPaths / sidHomePath / 文件写入的测试在 beforeEach 调用此函数。
 */
export function assertIsolated(): void {
  const override = process.env.SID_CONFIG_DIR;
  const realHome = join(homedir(), ".sid-code");

  if (!override || override.trim() === "") {
    throw new Error(
      `测试隔离门禁失败：SID_CONFIG_DIR 未设置，sidHomePath() 会解析到真实 ${realHome}。\n` +
        `请在 beforeEach 中设置 process.env.SID_CONFIG_DIR 为临时目录。`,
    );
  }

  if (override === realHome) {
    throw new Error(
      `测试隔离门禁失败：SID_CONFIG_DIR 显式指向了真实 HOME (${realHome})。\n` +
        `请使用 tmpDir 而非真实 HOME。`,
    );
  }
}
