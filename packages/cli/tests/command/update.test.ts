/**
 * sid-code update 子命令契约测试
 *
 * 仅验证 dispatch 接线 + 帮助文本契约，不真跑 curl|bash（不发真实网络请求）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE_TS = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "cli",
  "src",
  "command",
  "update.ts",
);
const BOOTSTRAP_TS = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "cli",
  "src",
  "entrypoints",
  "bootstrap.ts",
);

describe("sid-code update 子命令 - 文件契约", () => {
  test("src/command/update.ts 存在", () => {
    expect(existsSync(UPDATE_TS)).toBe(true);
  });

  test("update.ts 导出 handleUpdateCommand", async () => {
    const mod = await import("@sid-code/cli/command/update.ts");
    expect(typeof mod.handleUpdateCommand).toBe("function");
  });

  test("bootstrap.ts 含 update 子命令快速路径", () => {
    const content = readFileSync(BOOTSTRAP_TS, "utf-8");
    expect(content).toMatch(/args\[0\]\s*===\s*"update"/);
    expect(content).toMatch(/handleUpdateCommand/);
    expect(content).toMatch(/command\/update\.ts/);
  });

  test("update 快速路径在 daemon 快速路径之后、CLI 兜底加载之前", () => {
    const content = readFileSync(BOOTSTRAP_TS, "utf-8");
    const daemonIdx = content.indexOf('args[0] === "daemon"');
    const updateIdx = content.indexOf('args[0] === "update"');
    const fallbackIdx = content.indexOf("startCapturingEarlyInput");
    expect(daemonIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(daemonIdx);
    expect(fallbackIdx).toBeGreaterThan(updateIdx);
  });
});

describe("sid-code update 子命令 - 行为契约", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });
  test("update.ts 通过 curl|bash 复用 install.sh，不重新实现下载/校验逻辑", () => {
    const content = readFileSync(UPDATE_TS, "utf-8");
    expect(content).toMatch(/execFileSync/);
    expect(content).toMatch(/curl -fsSL/);
    expect(content).toMatch(/install\.sh/);
  });

  test("update.ts 通过参数化 URL 调用 curl，避免 shell 注入", () => {
    const content = readFileSync(UPDATE_TS, "utf-8");
    expect(content).toContain('curl -fsSL "$1" | bash');
    expect(content).not.toMatch(/curl -fsSL \$\{INSTALL_URL\}/);
  });

  test("--version 参数校验并传入环境变量", async () => {
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => {
      calls.push(args);
      return Buffer.from("");
    };
    const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
    await handleUpdateCommand(["--version", "0.1.602"], execute as never);
    expect(calls).toHaveLength(1);
    const options = calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.SID_CODE_VERSION).toBe("0.1.602");
  });

  test("非法 --version、--list 和未知参数拒绝执行安装", async () => {
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => {
      calls.push(args);
      return Buffer.from("");
    };
    const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
    await expect(handleUpdateCommand(["--version", "invalid"], execute as never)).rejects.toThrow(
      "版本号非法",
    );
    await expect(handleUpdateCommand(["--list"], execute as never)).rejects.toThrow(
      "不支持 --list",
    );
    await expect(handleUpdateCommand(["--unknown"], execute as never)).rejects.toThrow("未知参数");
    expect(calls).toHaveLength(0);
  });
  test("update.ts 含 --help / -h 帮助处理，且不发起网络请求", async () => {
    const content = readFileSync(UPDATE_TS, "utf-8");
    expect(content).toMatch(/printHelp|--help|"-h"/);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
      await handleUpdateCommand(["--help"]);
    } finally {
      console.log = originalLog;
    }
    expect(logs.join("\n")).toMatch(/sid-code update/);
  });
});
