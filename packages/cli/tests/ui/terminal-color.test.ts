/**
 * 2026-10-18 回归：sid-code 不得把 FORCE_COLOR 写进 process.env。
 *
 * 写进 env 会被 bash / 后台任务 / hook / MCP / LSP / 子代理全部继承，让 bun / vite 这类
 * 工具往文件和管道里吐 ANSI——后台任务 `.output` 因此被 read 判成二进制。
 * 颜色级别只允许改进程内的 chalk 实例（见 packages/cli/src/ui/terminal-color.ts）。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import chalk from "chalk";
import {
  resolveTerminalColorLevel,
  applyTerminalColorLevel,
  colorEnvForTuiRenderedChild,
  isTerminalColorForced,
  __resetTerminalColorForTest,
} from "@sid-code/cli/ui/terminal-color.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");

const savedLevel = chalk.level;
afterEach(() => {
  chalk.level = savedLevel;
  __resetTerminalColorForTest();
});

describe("resolveTerminalColorLevel", () => {
  test("TTY + 用户未设颜色变量 → 真彩（与旧入口 FORCE_COLOR=3 同值）", () => {
    expect(resolveTerminalColorLevel({ TERM: "xterm-256color" }, true)).toBe(3);
  });

  test("tmux 下按 tui 规则降到 256 色（与旧版 FORCE_COLOR=3 + adjustColorLevel 一致）", () => {
    expect(resolveTerminalColorLevel({ TMUX: "/tmp/tmux" }, true)).toBe(2);
    expect(
      resolveTerminalColorLevel({ TMUX: "/tmp/tmux", SID_CODE_TMUX_TRUECOLOR: "1" }, true),
    ).toBe(3);
  });

  test("非 TTY（管道 / 文件）不干预——不再把 0 抬到 3", () => {
    expect(resolveTerminalColorLevel({}, false)).toBeNull();
  });

  test("用户显式设了 FORCE_COLOR / NO_COLOR → 不干预，交给 chalk 自己读", () => {
    expect(resolveTerminalColorLevel({ FORCE_COLOR: "1" }, true)).toBeNull();
    expect(resolveTerminalColorLevel({ NO_COLOR: "1" }, true)).toBeNull();
  });
});

describe("applyTerminalColorLevel 只改 chalk、不改 env", () => {
  test("TTY 下设好 chalk.level，传入的 env 原样不动", () => {
    const env: Record<string, string | undefined> = { TERM: "xterm-256color" };
    applyTerminalColorLevel(env, true);
    expect(chalk.level).toBe(3);
    expect(isTerminalColorForced()).toBe(true);
    expect(env).toEqual({ TERM: "xterm-256color" });
  });

  test("非 TTY 下什么都不做", () => {
    chalk.level = 0;
    applyTerminalColorLevel({}, false);
    expect(chalk.level).toBe(0);
    expect(isTerminalColorForced()).toBe(false);
  });
});

describe("colorEnvForTuiRenderedChild（只给状态栏这类输出进 TUI 的子进程）", () => {
  test("未强制颜色时返回空对象", () => {
    expect(colorEnvForTuiRenderedChild({})).toEqual({});
  });

  test("强制颜色后按当前 chalk 级别给 FORCE_COLOR", () => {
    applyTerminalColorLevel({ TMUX: "x" }, true);
    expect(colorEnvForTuiRenderedChild({})).toEqual({ FORCE_COLOR: "2" });
  });

  test("用户自己设了 FORCE_COLOR / NO_COLOR 时不覆盖", () => {
    applyTerminalColorLevel({}, true);
    expect(colorEnvForTuiRenderedChild({ FORCE_COLOR: "1" })).toEqual({});
    expect(colorEnvForTuiRenderedChild({ NO_COLOR: "1" })).toEqual({});
  });
});

describe("端到端：加载 CLI 入口后，子进程看不到 sid-code 注入的 FORCE_COLOR", () => {
  test("import cli.ts 之后 process.env.FORCE_COLOR 仍未设置，shell 子进程也读不到", () => {
    // 子进程里 import 真实入口（只求值模块，不调 main），再按两条真实泄漏路径 spawn shell：
    // - bash 前台：Bun.spawn 显式传 env: process.env（tool/bash.ts）
    // - 后台任务：node:child_process.spawn 默认继承（task/shell-task.ts）
    // ⚠ 不能用不传 env 的 Bun.spawnSync：它不继承运行时对 process.env 的修改，恒为 <unset>，
    //   测不出泄漏（2026-10-18 写这条测试时实测踩到）。
    const code = `
      await import(${JSON.stringify(join(REPO_ROOT, "packages/cli/src/cli.ts"))});
      const { spawnSync } = await import("node:child_process");
      const sh = ["-c", 'printf "%s" "\${FORCE_COLOR-<unset>}"'];
      const bunChild = Bun.spawnSync(["sh", ...sh], { env: process.env }).stdout.toString();
      const nodeChild = spawnSync("sh", sh).stdout.toString();
      process.stdout.write(JSON.stringify({ env: process.env.FORCE_COLOR ?? "<unset>", bunChild, nodeChild }));
    `;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "FORCE_COLOR" && k !== "NO_COLOR") env[k] = v;
    }
    const r = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: REPO_ROOT });
    const line = r.stdout.toString().trim().split("\n").pop() ?? "";
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(JSON.parse(line)).toEqual({ env: "<unset>", bunChild: "<unset>", nodeChild: "<unset>" });
  }, 30000);

  test("用户自己设的 FORCE_COLOR 原样透传给子进程", () => {
    const code = `
      await import(${JSON.stringify(join(REPO_ROOT, "packages/cli/src/cli.ts"))});
      const { spawnSync } = await import("node:child_process");
      process.stdout.write(spawnSync("sh", ["-c", 'printf "%s" "$FORCE_COLOR"']).stdout.toString());
    `;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.FORCE_COLOR = "1";
    const r = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: REPO_ROOT });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(r.stdout.toString().trim().split("\n").pop()).toBe("1");
  }, 30000);
});

describe("静态门禁：源码里不得给 process.env.FORCE_COLOR 赋值", () => {
  test("packages/*/src 中零处写入", () => {
    // 匹配 `process.env.FORCE_COLOR = …` / `process.env["FORCE_COLOR"] = …`，排除 == / ===
    const WRITE = /process\.env(?:\.FORCE_COLOR|\[\s*["'`]FORCE_COLOR["'`]\s*\])\s*=(?!=)/;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              // 注释里引用旧代码（解释为什么不能这么写）不算写入
              const t = line.trimStart();
              if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
              if (WRITE.test(line)) hits.push(`${relative(REPO_ROOT, p)}:${i + 1}`);
            });
        }
      }
    };
    const pkgs = join(REPO_ROOT, "packages");
    let scanned = 0;
    for (const pkg of readdirSync(pkgs)) {
      const src = join(pkgs, pkg, "src");
      try {
        if (statSync(src).isDirectory()) {
          walk(src);
          scanned++;
        }
      } catch {
        /* 无 src 的包跳过 */
      }
    }
    // 防「扫了个空目录然后全绿」
    expect(scanned).toBeGreaterThanOrEqual(4);
    expect(hits).toEqual([]);
  });
});
