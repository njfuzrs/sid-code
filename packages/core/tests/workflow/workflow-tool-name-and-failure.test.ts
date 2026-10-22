/**
 * WorkflowTool：按名复用落盘脚本（C2）+ 失败时回传 resume 标识（C3）
 *
 * 用不调 agent() 的脚本驱动真实 WorkflowTool.execute——SubAgentRunner 只构造不运行，
 * 所以 providerRegistry/toolRegistry 给空壳即可，不打 LLM。
 * 落盘（scripts/journals）全部经 SID_CONFIG_DIR 重定向到 tmpdir。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkflowTool, resolveSavedScriptPath } from "@sid-code/core/tool/workflow.ts";
import { clearAllTasks } from "@sid-code/core/task/registry.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";

let home: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.SID_CONFIG_DIR;
  home = mkdtempSync(join(tmpdir(), "sid-wf-tool-"));
  process.env.SID_CONFIG_DIR = home;
});

afterEach(async () => {
  clearAllTasks();
  dequeuePendingNotifications();
  await new Promise((r) => setTimeout(r, 0));
  if (prev === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prev;
  rmSync(home, { recursive: true, force: true });
});

function makeTool(): WorkflowTool {
  // 脚本不调 agent()，两个 registry 不会被触达
  return new WorkflowTool({} as never, {} as never);
}

const okScript = (name: string, ret: string) =>
  `export const meta = { name: "${name}", description: "d" };\nreturn "${ret}";\n`;

const scriptsDir = () => join(home, "workflows", "scripts");

describe("C2 resolveSavedScriptPath", () => {
  test("精确 <name>.js 优先于自动落盘文件", () => {
    const dir = scriptsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "audit.js"), "manual");
    writeFileSync(join(dir, "audit-wf_aaaaaaaaaaaa.js"), "auto");
    const r = resolveSavedScriptPath("audit", dir);
    expect("path" in r && r.path).toBe(join(dir, "audit.js"));
  });

  test("无精确文件时取 mtime 最新的 <name>-wf_*.js，且不串到前缀相同的别名", () => {
    const dir = scriptsDir();
    mkdirSync(dir, { recursive: true });
    const older = join(dir, "audit-wf_111111111111.js");
    const newer = join(dir, "audit-wf_222222222222.js");
    const other = join(dir, "audit-x-wf_333333333333.js"); // 另一个 workflow「audit-x」
    writeFileSync(older, "1");
    writeFileSync(newer, "2");
    writeFileSync(other, "3");
    utimesSync(older, new Date(2000), new Date(2000));
    utimesSync(newer, new Date(3000), new Date(3000));
    utimesSync(other, new Date(9000), new Date(9000));
    const r = resolveSavedScriptPath("audit", dir);
    expect("path" in r && r.path).toBe(newer);
  });

  test("都没有时报错并给出两种期望路径", () => {
    const r = resolveSavedScriptPath("nope", scriptsDir());
    expect("error" in r && r.error).toContain("nope-wf_*.js");
  });
});

describe("C2 端到端：跑过的脚本不改名即可按 {name} 复用", () => {
  test("{script} 跑一次 → {name:meta.name} 加载到同一脚本", async () => {
    const tool = makeTool();
    const first = await tool.execute({ script: okScript("reuse-me", "v1") });
    expect(first.isError).toBe(false);
    expect(readdirSync(scriptsDir()).some((f) => /^reuse-me-wf_[0-9a-f]{12}\.js$/.test(f))).toBe(
      true,
    );

    const second = await tool.execute({ name: "reuse-me" });
    expect(second.isError).toBe(false);
    expect(second.output).toContain('"result": "v1"');
  });

  test('内联 workflow("name") 同样能加载自动落盘的脚本', async () => {
    const tool = makeTool();
    await tool.execute({ script: okScript("child-wf", "from-child") });
    const parent = `export const meta = { name: "parent-wf", description: "d" };\nreturn await workflow("child-wf");\n`;
    const r = await tool.execute({ script: parent });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('"result": "from-child"');
  });
});

describe("C3 失败时回传 runId / script_path", () => {
  test("工具输出含 runId 与 script_path，可直接拼 resume 调用", async () => {
    const tool = makeTool();
    const bad = `export const meta = { name: "will-fail", description: "d" };\nthrow new Error("boom");\n`;
    const r = await tool.execute({ script: bad });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("boom");
    const runId = /"runId": "(wf_[0-9a-f]{12})"/.exec(r.output)?.[1];
    expect(runId).toBeDefined();
    const scriptPath = /"script_path": "([^"]+)"/.exec(r.output)?.[1];
    expect(scriptPath).toBe(join(scriptsDir(), `will-fail-${runId}.js`));
    expect(r.output).toContain(`resume_from_run_id:"${runId}"`);
  });

  test("失败通知里带 runId", async () => {
    const tool = makeTool();
    const bad = `export const meta = { name: "notif-fail", description: "d" };\nthrow new Error("x");\n`;
    const r = await tool.execute({ script: bad });
    const runId = /"runId": "(wf_[0-9a-f]{12})"/.exec(r.output)?.[1];
    expect(runId).toBeDefined();
    const joined = dequeuePendingNotifications()
      .map((n) => n.content)
      .join("");
    expect(joined).toContain(runId ?? "<missing-runId>");
  });
});
