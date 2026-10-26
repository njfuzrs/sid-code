/**
 * `--add-dir` / `/add-dir` 的「追加」语义回归测试
 *
 * 缺陷：白名单一旦非空，判据从「工作区 ∪ 白名单」变成「白名单」，
 * 于是加一个目录就把工作区挤出了可访问集合 —— 工作区路径在第 2 步被硬拒
 * （needsConfirmation 未设，不转确认），交互里敲一次 /add-dir 会让下一轮
 * 连自己的仓库都读不了。
 *
 * 语义口径（对标 claude-code filesystem.ts 的 allWorkingDirectories）：
 *   工作目录集合 = 启动工作区 ∪ 追加目录，工作区永远在里面。
 *
 * ⚠️ fixture 一律用 `fs.realpathSync(os.tmpdir())` 派生：
 * macOS 上 `/tmp → /private/tmp`、`/var → /private/var`，而 PathValidator 的
 * workspacePath 走 realpath。测试路径若停在未解析的 `/var/...` 前缀，
 * `isWithinWorkspace` 恒为 false、第 4 步 symlink 逃逸检测整体跳过 ——
 * 断言会绿，但验的不是目标行为。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PathValidator } from "@sid-code/core/permission/path-validator.ts";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 工作区 */
let ws: string;
/** 追加目录（等价于 --add-dir 给的目录） */
let extra: string;
/** 集合外的第三个目录 */
let other: string;
let base: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "add-dir-additive-")));
  ws = path.join(base, "ws");
  extra = path.join(base, "extra");
  other = path.join(base, "other");
  for (const d of [ws, extra, other]) fs.mkdirSync(d, { recursive: true });

  fs.writeFileSync(path.join(ws, "a.ts"), "// a");
  fs.writeFileSync(path.join(extra, "b.ts"), "// b");
  fs.writeFileSync(path.join(extra, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(other, "c.ts"), "// c");

  // 工作区内指向追加目录的 symlink —— 属于集合内，不该判逃逸
  fs.symlinkSync(extra, path.join(ws, "link-extra"));
  // 追加目录 → 集合外 → 再回到追加目录。链路中间逃到 other，最终 realPath 仍在集合内，
  // 这样第 2 步（白名单判断）放行，能真正走到第 4 步的 symlink 逃逸检测。
  fs.symlinkSync(other, path.join(extra, "esc"));
  fs.symlinkSync(extra, path.join(other, "back"));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("PathValidator：工作目录集合 = 工作区 ∪ 白名单", () => {
  test("白名单非空时，工作区仍可读", () => {
    const v = new PathValidator(ws, [extra]);
    const r = v.validateAccess(path.join(ws, "a.ts"), "read");
    expect(r.allowed).toBe(true);
  });

  test("白名单非空时，工作区仍可写（不被白名单挤出）", () => {
    const v = new PathValidator(ws, [extra]);
    const r = v.validateAccess(path.join(ws, "new.ts"), "write");
    expect(r.allowed).toBe(true);
  });

  test("追加目录可读", () => {
    const v = new PathValidator(ws, [extra]);
    const r = v.validateAccess(path.join(extra, "b.ts"), "read");
    expect(r.allowed).toBe(true);
  });

  test("追加目录可写，不再要求确认（对齐 Claude Code 的 read and edit）", () => {
    const v = new PathValidator(ws, [extra]);
    const r = v.validateAccess(path.join(extra, "new.ts"), "write");
    expect(r.allowed).toBe(true);
    expect(r.needsConfirmation).toBeUndefined();
  });

  test("集合外的目录读仍被拒", () => {
    const v = new PathValidator(ws, [extra]);
    const r = v.validateAccess(path.join(other, "c.ts"), "read");
    expect(r.allowed).toBe(false);
    // reason 文案沿用「不在白名单中」（触发时确实既不在工作区、也不在白名单），
    // 关键是它落在第 2 步而不是第 5 步——追加目录写不再需要确认，别把两者混为一谈。
    expect(r.reason).toContain("不在白名单中");
  });

  test("追加目录内的凭证文件仍硬 deny（白名单不放宽敏感文件）", () => {
    const v = new PathValidator(ws, [extra]);
    const r = v.validateAccess(path.join(extra, ".env"), "read");
    expect(r.allowed).toBe(false);
    expect(r.sensitiveFile).toBe(true);
  });

  test("isWithinWorkingDirectories：工作区与追加目录都在集合内，其它不在", () => {
    const v = new PathValidator(ws, [extra]);
    expect(v.isWithinWorkingDirectories(path.join(ws, "a.ts"))).toBe(true);
    expect(v.isWithinWorkingDirectories(path.join(extra, "b.ts"))).toBe(true);
    expect(v.isWithinWorkingDirectories(path.join(other, "c.ts"))).toBe(false);
    // 白名单是附加集合，不改变 isWithinWorkspace 的「仅工作区」语义
    expect(v.isWithinWorkspace(path.join(extra, "b.ts"))).toBe(false);
  });
});

describe("白名单项为根目录 /（前缀拼接不得拼出 //）", () => {
  test("--add-dir / 真正生效：集合外目录可读", () => {
    const v = new PathValidator(ws, ["/"]);
    const r = v.validateAccess(path.join(other, "c.ts"), "read");
    expect(r.allowed).toBe(true);
  });

  test("白名单含 / 时工作区仍可访问（根目录项不吞掉工作区）", () => {
    const v = new PathValidator(ws, ["/"]);
    expect(v.validateAccess(path.join(ws, "a.ts"), "read").allowed).toBe(true);
  });

  test("--add-dir / 时写 /etc 落在系统目录保护上，而不是白名单拒绝", () => {
    const v = new PathValidator(ws, ["/"]);
    const r = v.validateAccess("/etc/hosts", "write");
    expect(r.allowed).toBe(false);
    // 不能只断言 allowed === false：白名单若因 `//` 前缀失效，第 2 步会以
    // 「不在可访问目录中」拒绝，同样 false —— 那是假绿。
    expect(r.reason).toContain("系统目录写入被拦截");
  });

  test("黑名单项为 / 时同样生效（同源拼接缺陷，fail-closed 方向）", () => {
    const v = new PathValidator(ws, [], ["/"]);
    const r = v.validateAccess(path.join(ws, "a.ts"), "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("目录被禁止访问");
  });
});

describe("symlink 逃逸检测按「工作目录集合」判定", () => {
  test("工作区内指向追加目录的 symlink 不判逃逸", () => {
    const v = new PathValidator(ws, [extra]);
    const r = v.validateAccess(path.join(ws, "link-extra", "b.ts"), "read");
    expect(r.allowed).toBe(true);
  });

  test("从追加目录出发、链路中途逃到集合外，仍判逃逸", () => {
    const v = new PathValidator(ws, [extra]);
    const r = v.validateAccess(path.join(extra, "esc", "back", "b.ts"), "read");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("symlink 逃逸检测");
  });
});

describe("PermissionChecker：/add-dir 运行时追加不锁死工作区", () => {
  test("addAllowedDirectory 前后，读工作区都是 allow", async () => {
    const config = { ...defaultConfig(), allowedDirectories: [] as string[] };
    const checker = new PermissionChecker(config, undefined, ws);

    const before = await checker.check({
      toolName: "read",
      input: { file_path: path.join(ws, "a.ts") },
    });
    expect(before.allowed).toBe(true);

    checker.addAllowedDirectory(extra);

    const after = await checker.check({
      toolName: "read",
      input: { file_path: path.join(ws, "a.ts") },
    });
    expect(after.allowed).toBe(true);

    const extraRead = await checker.check({
      toolName: "read",
      input: { file_path: path.join(extra, "b.ts") },
    });
    expect(extraRead.allowed).toBe(true);
  });

  test("派生子代理 checker 继承白名单后，读工作区仍为 allow", async () => {
    const config = { ...defaultConfig(), allowedDirectories: [] as string[] };
    const checker = new PermissionChecker(config, undefined, ws);
    checker.addAllowedDirectory(extra);

    const derived = checker.deriveWithPermissionMode("default");
    expect(derived.getAllowedDirectories()).toContain(extra);

    const r = await derived.check({
      toolName: "read",
      input: { file_path: path.join(ws, "a.ts") },
    });
    expect(r.allowed).toBe(true);
  });

  test("getWorkspacePath 供命令层展示完整可访问集合", () => {
    const config = { ...defaultConfig(), allowedDirectories: [] as string[] };
    const checker = new PermissionChecker(config, undefined, ws);
    expect(checker.getWorkspacePath()).toBe(fs.realpathSync(ws));
  });
});
