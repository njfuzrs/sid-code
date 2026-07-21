/**
 * /keybindings（别名 /keys）命令测试（P2-5 / §4.3）
 *
 * 覆盖：无参展示路径+键位表 / init 创建模板 / init 幂等（已存在不覆盖）。
 * 用 SID_CONFIG_DIR 指向临时目录，隔离真实 ~/.sid-code。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import keysCmd from "../../src/command/commands/keybindings/index.ts";
import type { CommandContext, LocalCommand } from "../../src/command/types.ts";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const loadKeys = () => (keysCmd as LocalCommand).load();
const ctx = {} as unknown as CommandContext;

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.SID_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "sc-keys-"));
  process.env.SID_CONFIG_DIR = dir;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SID_CONFIG_DIR;
  else process.env.SID_CONFIG_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("/keybindings 命令", () => {
  test("无参：展示路径 + 用户配置状态 + 键位表", async () => {
    const mod = await loadKeys();
    const r = await mod.call("", ctx);
    const value = (r as { value: string }).value;
    expect(value).toContain("键位绑定");
    expect(value).toContain(dir); // 展示配置路径
    expect(value).toContain("未应用"); // 临时目录无用户配置
  });

  test("init：创建模板文件", async () => {
    const mod = await loadKeys();
    const r = await mod.call("init", ctx);
    expect((r as { value: string }).value).toContain("已创建");
    const path = join(dir, "keybindings.json");
    expect(existsSync(path)).toBe(true);
    // 模板是合法 JSON 且含 bindings 数组
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(Array.isArray(parsed.bindings)).toBe(true);
  });

  test("init 幂等：已存在则不覆盖", async () => {
    const mod = await loadKeys();
    await mod.call("init", ctx);
    const path = join(dir, "keybindings.json");
    const first = readFileSync(path, "utf-8");
    const r = await mod.call("init", ctx);
    expect((r as { value: string }).value).toContain("已存在");
    expect(readFileSync(path, "utf-8")).toBe(first); // 内容未变
  });
});
