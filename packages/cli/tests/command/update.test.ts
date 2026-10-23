/**
 * sid-code update 子命令契约测试
 *
 * 仅验证 dispatch 接线 + 帮助文本契约，不真跑 curl|bash（不发真实网络请求）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  // 显式传一个不存在的安装目录：默认值指向真实 ~/.local，本地快速路径命中会切掉本机软链。
  const noLocal = {
    versionsDir: join(tmpdir(), "sid-update-no-local", "versions"),
    binSymlink: join(tmpdir(), "sid-update-no-local", "bin", "sid-code"),
  };

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
    await handleUpdateCommand(
      ["--version", "0.1.602"],
      execute as never,
      () => "stable",
      noIndex,
      noLocal,
    );
    expect(calls).toHaveLength(1);
    const options = calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.SID_CODE_VERSION).toBe("0.1.602");
  });

  // ── B46 P5：--list / --version 查清单 ──
  const noIndex = async () => ({
    manifestUrl: "https://x/versions.json",
    manifest: null,
    latest: null,
    beta: null,
  });
  const index = async () => ({
    manifestUrl: "https://x/versions.json",
    latest: "0.1.606",
    beta: "0.1.607",
    manifest: {
      schema: 1 as const,
      generated_at: "",
      archive_since: "0.1.602",
      versions: [
        { version: "0.1.607", provenance: "original" as const, platforms: {} },
        { version: "0.1.606", provenance: "original" as const, platforms: {} },
        {
          version: "0.1.590",
          provenance: "rebuilt" as const,
          platforms: {},
          known_issues: ["self-update-broken"],
        },
      ],
      lost: [{ version: "0.1.585", reason: "已丢失" }],
    },
  });

  async function capture(fn: () => Promise<void>) {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await fn();
    } finally {
      console.log = originalLog;
    }
    return logs.join("\n");
  }

  test("--list 列出清单版本并标注通道 / 重建 / 已知问题，不执行安装", async () => {
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => (calls.push(args), Buffer.from(""));
    const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
    const out = await capture(() =>
      handleUpdateCommand(["--list"], execute as never, () => "stable", index),
    );
    expect(calls).toHaveLength(0);
    const rows = out.split("\n").filter((l) => /^\s+0\.1\.\d+/.test(l));
    expect(rows.map((l) => l.trim().split(/\s+/)[0])).toEqual(["0.1.607", "0.1.606", "0.1.590"]);
    expect(rows[0]).toContain("beta");
    expect(rows[1]).toContain("stable");
    expect(rows[2]).toContain("(重建)");
    expect(rows[2]).toContain("self-update-broken");
    expect(out).toContain("0.1.585");
    expect(out).toContain('"autoUpdate": "off"');
  });

  test("--list 拉不到清单 → 报错并给出 --version 的退路", async () => {
    const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
    await expect(
      handleUpdateCommand(["--list"], (() => Buffer.from("")) as never, () => "stable", noIndex),
    ).rejects.toThrow("拉取版本清单失败");
  });

  test("--version 不在清单里 → 报不存在并提示 --list，不执行安装", async () => {
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => (calls.push(args), Buffer.from(""));
    const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
    await expect(
      handleUpdateCommand(["--version", "9.9.9"], execute as never, () => "stable", index, noLocal),
    ).rejects.toThrow("sid-code update --list");
    await expect(
      handleUpdateCommand(
        ["--version", "0.1.585"],
        execute as never,
        () => "stable",
        index,
        noLocal,
      ),
    ).rejects.toThrow("已丢失");
    expect(calls).toHaveLength(0);
  });

  test("--version 在清单里且有已知问题 → 打印提示后照常安装", async () => {
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => (calls.push(args), Buffer.from(""));
    const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
    const out = await capture(() =>
      handleUpdateCommand(
        ["--version", "0.1.590"],
        execute as never,
        () => "stable",
        index,
        noLocal,
      ),
    );
    expect(out).toContain("self-update-broken");
    expect(calls).toHaveLength(1);
  });

  test("清单拉不到 → --version 不拒绝、不降级，直接交给 install.sh", async () => {
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => (calls.push(args), Buffer.from(""));
    const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
    await capture(() =>
      handleUpdateCommand(
        ["--version", "9.9.9"],
        execute as never,
        () => "stable",
        noIndex,
        noLocal,
      ),
    );
    expect(calls).toHaveLength(1);
    const options = calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(options.env.SID_CODE_VERSION).toBe("9.9.9");
  });

  // ── T4：sid-code update 缺省沿用当前安装的通道 ──
  async function runUpdate(installed: "stable" | "beta" | "dev", explicit?: string) {
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => {
      calls.push(args);
      return Buffer.from("");
    };
    if (explicit === undefined) delete process.env.SID_CODE_CHANNEL;
    else process.env.SID_CODE_CHANNEL = explicit;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
      await handleUpdateCommand([], execute as never, () => installed, undefined, noLocal);
    } finally {
      console.log = originalLog;
    }
    const options = calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    return { env: options.env, logs: logs.join("\n") };
  }

  test("无变量 + 当前装的是 beta → 传 beta 并提示如何切回", async () => {
    const { env, logs } = await runUpdate("beta");
    expect(env.SID_CODE_CHANNEL).toBe("beta");
    expect(logs).toContain("沿用当前通道 beta");
    expect(logs).toContain("SID_CODE_CHANNEL=stable sid-code update");
  });

  test("显式 SID_CODE_CHANNEL=stable 覆盖 .channel=beta", async () => {
    const { env, logs } = await runUpdate("beta", "stable");
    expect(env.SID_CODE_CHANNEL).toBe("stable");
    expect(logs).not.toContain("沿用当前通道");
  });

  test("stable / dev 安装无变量时不设通道（install.sh 缺省 stable，行为不变）", async () => {
    expect((await runUpdate("stable")).env.SID_CODE_CHANNEL).toBeUndefined();
    expect((await runUpdate("dev")).env.SID_CODE_CHANNEL).toBeUndefined();
  });

  // B46 P5 起 --list 是合法参数（契约有意变更），这里改测 --list 与 --version 互斥
  test("非法 --version、--list 与 --version 混用、未知参数拒绝执行安装", async () => {
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => {
      calls.push(args);
      return Buffer.from("");
    };
    const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
    await expect(handleUpdateCommand(["--version", "invalid"], execute as never)).rejects.toThrow(
      "版本号非法",
    );
    await expect(
      handleUpdateCommand(["--list", "--version", "0.1.602"], execute as never),
    ).rejects.toThrow("不能同时使用");
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

  // ── 回滚离线可用：本地已有版本目录时直接切软链，不跑 curl|bash ──
  function makeLocalInstall(version: string) {
    const root = mkdtempSync(join(tmpdir(), "sid-update-local-"));
    const paths = {
      versionsDir: join(root, "versions"),
      binSymlink: join(root, "bin", "sid-code"),
    };
    mkdirSync(join(paths.versionsDir, version), { recursive: true });
    mkdirSync(join(root, "bin"));
    writeFileSync(join(paths.versionsDir, version, "sid-code"), "");
    return { root, paths, bin: join(paths.versionsDir, version, "sid-code") };
  }

  test("--version 命中本地目录且二进制能跑 → 切软链，不查清单、不跑 install.sh", async () => {
    const { root, paths, bin } = makeLocalInstall("0.1.602");
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => (calls.push(args), Buffer.from(""));
    let indexLoaded = false;
    const loadIndex = async () => ((indexLoaded = true), await noIndex());
    try {
      delete process.env.SID_CODE_CHANNEL;
      const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
      const out = await capture(() =>
        handleUpdateCommand(
          ["--version", "0.1.602"],
          execute as never,
          () => "stable",
          loadIndex,
          paths,
        ),
      );
      expect(out).toContain("未联网");
      expect(readlinkSync(paths.binSymlink)).toBe(bin);
      expect(readFileSync(join(paths.versionsDir, "0.1.602", ".channel"), "utf8").trim()).toBe(
        "stable",
      );
      expect(indexLoaded).toBe(false);
      // 唯一一次 execute 是冒烟 --version，没有 bash -c curl
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(bin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("本地二进制跑不通 → 不切软链，交回 install.sh 重装", async () => {
    const { root, paths, bin } = makeLocalInstall("0.1.602");
    const calls: unknown[][] = [];
    const execute = (...args: unknown[]) => {
      calls.push(args);
      if (args[0] === bin) throw new Error("broken");
      return Buffer.from("");
    };
    try {
      const { handleUpdateCommand } = await import("@sid-code/cli/command/update.ts");
      await capture(() =>
        handleUpdateCommand(
          ["--version", "0.1.602"],
          execute as never,
          () => "stable",
          noIndex,
          paths,
        ),
      );
      expect(existsSync(paths.binSymlink)).toBe(false);
      expect(calls.at(-1)![0]).toBe("bash");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
