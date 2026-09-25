/**
 * /ide 在一个 lockfile 都没有时的提示。
 *
 * 两条文案的下一步完全不同：IDE 开着但扩展没装，该指向 /ide install；
 * 什么都没检测到，只能说「未发现」。
 *
 * 文案函数故意不导出。命令体系门禁（scripts/command-system-gate.ts 的 G1）
 * 把「零生产调用的导出」算死代码，而它的唯一消费者就在同一个文件里，
 * 导出会让死导出基线 +1。基线注释里有先例：没有外部消费者的符号改为不导出，
 * 而不是加进豁免名单。
 *
 * 也不用 mock.module 把进程检测换掉：bun 的模块 mock 是进程级的，
 * 同批跑会盖掉 packages/core/tests/ide/ 里对真实检测的测试。
 *
 * 所以分成两半锁：
 *   - 行为：真实跑 /ide，无 lockfile 时返回的消息一定指向 /ide install，
 *     且必然是两条文案之一。走哪条取决于这台机器上有没有 IDE 进程，
 *     测试环境决定不了，所以不断言具体哪条。
 *   - 拼接：点名那条把检测结果原样拼进文案、并指向 /ide install，
 *     检测为空时退回「未发现」。这些是源码里的字面量，改了这里就红。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { IDECommand } from "@sid-code/cli/command/ide.ts";
import { resetIDEIntegration } from "@sid-code/core/ide/integration.ts";
import type { AppContext } from "@sid-code/cli/command/types.ts";

const IDE_COMMAND_SOURCE = join(import.meta.dir, "../../src/command/ide.ts");

let dir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ide-msg-"));
  savedConfigDir = process.env.SID_CONFIG_DIR;
  process.env.SID_CONFIG_DIR = dir;
  delete process.env.SID_CODE_SSE_PORT;
  resetIDEIntegration();
});

afterEach(() => {
  resetIDEIntegration();
  if (savedConfigDir === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("/ide 没有 lockfile 时的提示", () => {
  test("无 lockfile 时的消息指向 /ide install，且是两条文案之一", async () => {
    const ctx = { mcpManager: {} } as unknown as AppContext;
    const result = await new IDECommand().execute("status", ctx);

    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toContain("/ide install");
    const namedBranch = result.message.includes("正在运行");
    const genericBranch = result.message.includes("未发现可用 IDE");
    expect(namedBranch || genericBranch).toBe(true);
    // 两条是互斥的：点名了一个 IDE 就不应再说「未发现」
    expect(namedBranch && genericBranch).toBe(false);
  });

  test("点名文案拼进检测结果并指向安装，检测为空时退回「未发现」", () => {
    const source = readFileSync(IDE_COMMAND_SOURCE, "utf-8");
    // 名字来自检测结果的拼接，而不是写死的某个 IDE
    expect(source).toContain("running.join(");
    expect(source).toContain("正在运行，但没有发现 sid-code 扩展");
    expect(source).toContain("使用 /ide install 安装扩展");
    expect(source).toContain("未发现可用 IDE");
  });
});
