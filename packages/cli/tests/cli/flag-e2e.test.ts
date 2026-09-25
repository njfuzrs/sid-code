/**
 * CLI flag / 子命令 端到端行为测试（§7-7 缺口补齐）
 *
 * parseCLIArgs 内部走 process.exit，无法在进程内单测，故用 Bun.spawn 直接跑
 * src/entrypoints/bootstrap.ts（免 make build，始终测最新源码），断言：
 *   - 组合约束（P2-1 / P2-2）在非法组合下 exit=1 且给出中文报错
 *   - 非法 flag 值（--effort / --session-id / --input-format / --max-budget-usd）exit=1
 *   - 新子命令（agents / mcp / auth）正常路由并产出预期输出
 *   - --agent 指向不存在代理时 exit=1 且列出候选
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const BOOTSTRAP = resolve(import.meta.dir, "../../../../packages/cli/src/entrypoints/bootstrap.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 自带最小可用配置的隔离配置目录。
 *
 * 原实现让子进程继承环境直接读**用户真实的 ~/.sid-code/settings.json**，
 * 于是这些用例只在"本机恰好配好了模型"时才通过——换 CI、换新机器，
 * `loadConfig` 会先抛"未配置任何模型"，断言拿到的 stderr 根本不是被测的那条报错。
 * 这里给一份最小 availableModels，让配置加载能过，测试真正测的是 flag 解析行为。
 */
let CONFIG_DIR: string;

beforeAll(() => {
  CONFIG_DIR = mkdtempSync(join(tmpdir(), "sid-flag-e2e-"));
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
      // debugLogFile 的默认值是**字面量** "~/.sid-code/debug.log"
      // （src/config/config.ts:757、app-config.ts:134），不走 getSidHome()，
      // 所以 SID_CONFIG_DIR 管不到它——子进程会去截断用户真实的 debug.log
      // （实测每跑一次本文件，真实 debug.log 缩小 56 字节）。显式改指隔离目录。
      debug_log_file: join(CONFIG_DIR, "debug.log"),
    }),
  );
});

afterAll(() => {
  try {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** spawn bootstrap.ts，喂空 stdin 避免无头模式挂起等待输入。 */
async function run(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", BOOTSTRAP, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SID_CODE_DISABLE_PROJECT_RULES: "1",
      // 显式隔离：不读用户真实配置，也不写用户真实 ~/.sid-code
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

describe("组合约束 P2-1 / P2-2", () => {
  test("--input-format stream-json 缺 --output-format → exit=1 + 报错", async () => {
    const r = await run(["--input-format", "stream-json", "-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--input-format stream-json");
    expect(r.stderr).toContain("--output-format stream-json");
  });

  test("--input-format stream-json + --output-format stream-json → 不因组合校验退出", async () => {
    // 成对出现时不应命中 P2-1 报错。合法组合会进入无头会话循环（不会自行退出），
    // 故短暂运行后主动 kill，只断言启动早期没有吐出该特定组合校验报错。
    const proc = Bun.spawn(
      [
        "bun",
        BOOTSTRAP,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "-p",
        "hi",
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SID_CODE_DISABLE_PROJECT_RULES: "1" },
      },
    );
    await Bun.sleep(1500);
    proc.kill();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    expect(stderr).not.toContain("双向流式必须成对");
  });

  test("--include-partial-messages 缺 --print → exit=1 + 报错", async () => {
    const r = await run(["--include-partial-messages", "--output-format", "stream-json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--include-partial-messages");
  });

  test("--output-format stream-json 缺 --verbose → exit=1（G2）", async () => {
    const r = await run(["-p", "--output-format", "stream-json", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--verbose");
  });

  test("--output-format 非法值 → exit=1 且列出合法值（G1）", async () => {
    const r = await run(["-p", "--output-format", "jsonl", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("text / json / stream-json");
    expect(r.stderr).toContain("jsonl");
  });

  test("--output-format 不带 -p → 告警但不退出（G1）", async () => {
    // 不带 -p 会进入交互 TUI，不会自行退出。只看启动早期有没有那句告警，
    // 然后主动 kill——告警必须在进 TUI 之前打到 stderr。
    const proc = Bun.spawn(["bun", BOOTSTRAP, "--output-format", "json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SID_CODE_DISABLE_PROJECT_RULES: "1", SID_CONFIG_DIR: CONFIG_DIR },
    });
    await Bun.sleep(1500);
    proc.kill();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    expect(stderr).toContain("--output-format 只在 --print 下生效");
  });

  test("--max-budget-usd 不带 -p → 告警但不退出（B2）", async () => {
    const proc = Bun.spawn(["bun", BOOTSTRAP, "--max-budget-usd", "1"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SID_CODE_DISABLE_PROJECT_RULES: "1", SID_CONFIG_DIR: CONFIG_DIR },
    });
    await Bun.sleep(1500);
    proc.kill();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    expect(stderr).toContain("--max-budget-usd 只在 --print 下生效");
  });

  test("--no-session-persistence 不再是未知选项（bun allowNegative）", async () => {
    // 声明名若带 no- 前缀，bun 的 parseArgs 在 allowNegative 下直接抛未知选项，
    // 而 node 不抛——所以这条必须跑真实入口，不能只看源码里有没有这个字符串。
    // 带 -p 但无 prompt：应走到「需要提示词」，而不是停在「未知选项」。
    const r = await run(["-p", "--no-session-persistence"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("未知选项");
    expect(r.stderr).toContain("提示词");
  });
});

describe("非法 flag 值", () => {
  test("--effort 非法档位 → exit=1", async () => {
    const r = await run(["--effort", "ultra", "-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--effort");
  });

  test("--session-id 非 UUID → exit=1", async () => {
    const r = await run(["--session-id", "not-a-uuid", "-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--session-id");
  });

  test("--session-id 合法但与 -c 同用缺 --fork-session → exit=1", async () => {
    const r = await run(["--session-id", "550e8400-e29b-41d4-a716-446655440000", "-c", "-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--fork-session");
  });

  test("--input-format 非法值 → exit=1", async () => {
    const r = await run(["--input-format", "xml", "-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--input-format");
  });

  test("--max-budget-usd 非正数 → exit=1", async () => {
    const r = await run(["--max-budget-usd", "-5", "-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--max-budget-usd");
  });

  test("--setting-sources 含非法源 → exit=1", async () => {
    const r = await run(["--setting-sources", "user,bogus", "-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--setting-sources");
  });
});

describe("--agent（单数）", () => {
  test("不存在的代理 → exit=1 且列出候选", async () => {
    const r = await run(["--agent", "nonexistent", "-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nonexistent");
    expect(r.stderr).toContain("explore"); // 候选里应含内置代理
  });
});

describe("子命令路由", () => {
  test("agents --json → 输出内置代理数组", async () => {
    const r = await run(["agents", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    const names = parsed.map((a: any) => a.name);
    expect(names).toContain("explore");
    expect(names).toContain("general-purpose");
  });

  test("mcp list → exit=0（有无服务器都不报错）", async () => {
    const r = await run(["mcp", "list"]);
    expect(r.code).toBe(0);
  });

  test("mcp 未知子命令 → exit=1 + 用法提示", async () => {
    const r = await run(["mcp", "frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("未知 mcp 子命令");
  });

  test("auth status --json → 输出含 provider 字段", async () => {
    const r = await run(["auth", "status", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveProperty("provider");
    expect(parsed).toHaveProperty("apiKeyConfigured");
  });

  test("auth login → exit=1（不适用）", async () => {
    const r = await run(["auth", "login"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("不适用");
  });
});
