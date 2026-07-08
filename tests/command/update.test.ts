/**
 * sid-code update 子命令契约测试
 *
 * 仅验证 dispatch 接线 + 帮助文本契约，不真跑 curl|bash（不发真实网络请求）。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE_TS = join(__dirname, "..", "..", "src", "command", "update.ts");
const BOOTSTRAP_TS = join(__dirname, "..", "..", "src", "entrypoints", "bootstrap.ts");

describe("sid-code update 子命令 - 文件契约", () => {
  test("src/command/update.ts 存在", () => {
    expect(existsSync(UPDATE_TS)).toBe(true);
  });

  test("update.ts 导出 handleUpdateCommand", async () => {
    const mod = await import("../../src/command/update.ts");
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
  test("update.ts 通过 curl|bash 复用 install.sh，不重新实现下载/校验逻辑", () => {
    const content = readFileSync(UPDATE_TS, "utf-8");
    expect(content).toMatch(/execFileSync/);
    expect(content).toMatch(/curl -fsSL/);
    expect(content).toMatch(/install\.sh/);
  });

  test("update.ts 支持 SID_CODE_INSTALL_URL 环境变量覆盖安装地址", () => {
    const content = readFileSync(UPDATE_TS, "utf-8");
    expect(content).toMatch(/SID_CODE_INSTALL_URL/);
  });

  test("update.ts 含 --help / -h 帮助处理，且不发起网络请求", async () => {
    const content = readFileSync(UPDATE_TS, "utf-8");
    expect(content).toMatch(/printHelp|--help|"-h"/);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      const { handleUpdateCommand } = await import("../../src/command/update.ts");
      await handleUpdateCommand(["--help"]);
    } finally {
      console.log = originalLog;
    }
    expect(logs.join("\n")).toMatch(/sid-code update/);
  });
});
