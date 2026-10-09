/**
 * `mcp list` 末尾的待审批提示（D74）。
 *
 * 待审批的项目级 server 不进生效列表（fail-closed），只看 `mcp list` 的人会以为
 * `mcp add` 失败了。这里断言：有待审批项时列表末尾点名 `mcp pending`；
 * 批准之后提示消失、server 出现在列表里；`--json` 输出形状不变。
 *
 * 走 Bun.spawn 跑 bootstrap.ts（cmdList 内部会 process.exit，进程内测不了），
 * SID_CONFIG_DIR 与 cwd 都指向 tmpdir，不碰真实 ~/.sid-code。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const BOOTSTRAP = resolve(import.meta.dir, "../../src/entrypoints/bootstrap.ts");

let ROOT: string;
let CONFIG_DIR: string;
let PROJECT_DIR: string;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "sid-mcp-pending-hint-"));
  CONFIG_DIR = join(ROOT, "cfg");
  PROJECT_DIR = join(ROOT, "repo");
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(
    join(CONFIG_DIR, "settings.json"),
    JSON.stringify({
      model: "test-model",
      availableModels: [
        {
          name: "test-model",
          provider: "openai",
          api_key: "sk-test-not-a-real-key",
          base_url: "https://example.invalid/v1",
        },
      ],
      // 默认值是字面量 ~/.sid-code/debug.log，SID_CONFIG_DIR 管不到，显式改指隔离目录
      debug_log_file: join(CONFIG_DIR, "debug.log"),
    }),
  );
  writeFileSync(
    join(PROJECT_DIR, ".mcp.json"),
    JSON.stringify({
      mcpServers: { fs: { transport: "stdio", command: "npx", args: ["-y", "x", "/tmp"] } },
    }),
  );
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BOOTSTRAP, ...args], {
    cwd: PROJECT_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SID_CODE_DISABLE_PROJECT_RULES: "1",
      SID_CONFIG_DIR: CONFIG_DIR,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("mcp list 待审批提示", () => {
  test("未批准：列表为空，但末尾点名 mcp pending", async () => {
    const r = await run(["mcp", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("未配置任何 MCP 服务器");
    expect(r.stdout).toContain("另有 1 个项目级 MCP 服务器待审批");
    expect(r.stdout).toContain("sid-code mcp pending");
  }, 30_000);

  test("--json 输出形状不变（不混入提示行）", async () => {
    const r = await run(["mcp", "list", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  }, 30_000);

  test("批准后：server 出现在列表里，提示消失", async () => {
    const a = await run(["mcp", "approve", "fs"]);
    expect(a.code).toBe(0);
    const r = await run(["mcp", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fs  [stdio]");
    expect(r.stdout).not.toContain("待审批");
  }, 30_000);
});

/**
 * M1 / M4：CLI 与 TUI 加载共用 loadProjectMcpServers —— 子目录下 `mcp pending` 也能看到
 * 祖先目录 .mcp.json 声明的 server，且能在子目录里审批它（以前报「未在项目 .mcp.json 中声明」）。
 * 变异自证：projectDeclaredServerNames 改回只读 cwd/.mcp.json → reject 那条红。
 */
describe("子目录下 CLI 与加载侧同口径（M1/M4）", () => {
  test("子目录里 pending 能列出祖先 .mcp.json 的 server，并可直接 reject", async () => {
    const sub = join(PROJECT_DIR, "pkg", "deep");
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(PROJECT_DIR, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: { transport: "stdio", command: "npx", args: ["-y", "x", "/tmp"] },
          extra: { transport: "stdio", command: "npx", args: ["-y", "extra"] },
        },
      }),
    );
    const runIn = async (cwd: string, args: string[]) => {
      const proc = Bun.spawn(["bun", BOOTSTRAP, ...args], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SID_CODE_DISABLE_PROJECT_RULES: "1", SID_CONFIG_DIR: CONFIG_DIR },
      });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { stdout, code };
    };
    const p = await runIn(sub, ["mcp", "pending", "--json"]);
    expect(p.code).toBe(0);
    // tmpdir 不是 git 仓库 ⇒ 项目身份退回 cwd，fs 在子目录下也是 pending（CC 同语义）；
    // 这里只关心「祖先 .mcp.json 的 server 在子目录可见」
    expect(JSON.parse(p.stdout).pending).toContain("extra");
    const r = await runIn(sub, ["mcp", "reject", "extra"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已拒绝 1 个");
    const after = await runIn(sub, ["mcp", "pending", "--json"]);
    expect(JSON.parse(after.stdout).pending).not.toContain("extra");
  }, 60_000);
});
