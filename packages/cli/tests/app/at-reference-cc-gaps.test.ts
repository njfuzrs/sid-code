/**
 * @ 提及对齐 CC 的剩余缺口（#409 之后的 4 项）
 *
 * 1. 左边界锚点：`@` 前是 \w（邮箱 `foo@bar.com` 等）时不再进入文件解析
 * 2. 多文件总预算：单文件上限防不住数量
 * 4. 行范围 `@f.ts#L10-20` + 未改动文件不重复注入
 * 5. 目录注入条目列表（不递归、上限 1000）
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandAtReferences, type AtDedupContext } from "@sid-code/cli/app.ts";

let root: string;
let originalCwd: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "atref-gaps-"));
  // 与邮箱域名 / npm scope 同名的文件：没有左边界锚点时它们会被误注入
  writeFileSync(join(root, "bar.com"), "EMAIL_DOMAIN_FILE\n");
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, "scope", "pkg"), "SCOPE_PKG_FILE\n");
  writeFileSync(join(root, "ok.md"), "OK_CONTENT\n");
  writeFileSync(
    join(root, "lines.ts"),
    Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n"),
  );
  // 总预算：5 个 90KB 文件（各自低于 100KB 单文件上限），合计 450KB
  mkdirSync(join(root, "many"));
  for (let i = 0; i < 5; i++) writeFileSync(join(root, "many", `f${i}.txt`), "x".repeat(90 * 1024));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "A");
  mkdirSync(join(root, "src", "sub"));
  writeFileSync(join(root, "src", "sub", "deep.ts"), "DEEP");
  mkdirSync(join(root, "huge"));
  for (let i = 0; i < 1005; i++)
    writeFileSync(join(root, "huge", `e${String(i).padStart(4, "0")}`), "");
  originalCwd = process.cwd();
  process.chdir(root);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("1. 左边界锚点", () => {
  test("@ 紧贴在前一个字符后（邮箱、装饰器式写法）不当作文件引用", async () => {
    const r = await expandAtReferences("邮件 foo@bar.com，再看 x@scope/pkg");
    expect(r.injectedContent ?? "").not.toContain("EMAIL_DOMAIN_FILE");
    expect(r.injectedContent ?? "").not.toContain("SCOPE_PKG_FILE");
  });

  // 锚点的边界（与 CC 一致）：空白后的 `@scope/pkg` 仍然匹配，因为它和 `@src/a.ts` 在语法上
  // 区分不开。只有当前目录恰好有同名路径时才会注入，否则 stat 不命中、静默跳过。
  test("空白后的 npm scope 包名仍会匹配：无同名路径时不注入", async () => {
    const r = await expandAtReferences("npm i @nosuch-scope/pkg");
    expect(r.injectedContent).toBeNull();
  });

  // 与输入框 @ 补全（useAtCompletion extractAtPattern）判据一致：只有 `@` 前是 \w 才不认。
  // 若展开要求空白而补全不要求，用户在中文后选了补全项，文件却不会注入。
  test("@ 紧贴中文前文仍生效（与 @ 补全判据一致）", async () => {
    const r = await expandAtReferences("看下@ok.md");
    expect(r.injectedContent).toContain("OK_CONTENT");
  });

  test("行首、空白后、引号形态照常生效", async () => {
    expect((await expandAtReferences("@ok.md")).injectedContent).toContain("OK_CONTENT");
    expect((await expandAtReferences("看下 @ok.md")).injectedContent).toContain("OK_CONTENT");
    expect((await expandAtReferences('看下\n@"ok.md"')).injectedContent).toContain("OK_CONTENT");
  });
});

describe("2. 多文件总预算", () => {
  test("合计超过总预算时按顺序跳过超出部分，并告知模型", async () => {
    const input = [0, 1, 2, 3, 4].map((i) => `@many/f${i}.txt`).join(" ");
    const r = await expandAtReferences(input);
    const injected = r.injectedContent ?? "";
    // 256KB 预算只放得下前 2 个 90KB 文件
    expect(injected.length).toBeLessThan(256 * 1024 + 4096);
    expect(r.skippedPaths?.map((s) => s.path)).toEqual([
      "many/f2.txt",
      "many/f3.txt",
      "many/f4.txt",
    ]);
    expect(r.skippedPaths?.[0]?.reason).toContain("内联总量超过");
    expect(injected).toContain("未注入");
  });
});

describe("4. 行范围与去重", () => {
  test("@f.ts#L10-20 只注入第 10-20 行", async () => {
    const r = await expandAtReferences("看下 @lines.ts#L10-20");
    const injected = r.injectedContent ?? "";
    expect(injected).toContain("第 10-20 行");
    expect(injected).toContain("line10\n");
    expect(injected).toContain("line20\n");
    expect(injected).not.toContain("line9\n");
    expect(injected).not.toContain("line21");
  });

  test("单行 #L5 与越界范围", async () => {
    const one = await expandAtReferences("@lines.ts#L5");
    expect(one.injectedContent).toContain("line5\n");
    expect(one.injectedContent).not.toContain("line6");
    const out = await expandAtReferences("@lines.ts#L99-100");
    expect(out.skippedPaths?.[0]?.reason).toContain("超出文件总行数");
  });

  test("未改动且仍在上下文里时不重复注入；内容被移出上下文或文件改动后重新注入", async () => {
    let context = "";
    const dedup: AtDedupContext = {
      inlined: new Map(),
      hasInContext: (marker) => context.includes(marker),
    };
    const first = await expandAtReferences("看下 @ok.md", undefined, null, dedup);
    expect(first.injectedContent).toContain("OK_CONTENT");
    context = first.injectedContent!;

    const second = await expandAtReferences("再看 @ok.md", undefined, null, dedup);
    expect(second.injectedContent).not.toContain("OK_CONTENT");
    expect(second.dedupedPaths).toEqual(["ok.md"]);
    expect(second.injectedContent).toContain("未重复注入");

    // 压缩 / 清理把原注入拿掉：必须重新注入，否则模型以为看过、实际看不到
    context = "";
    const third = await expandAtReferences("再看 @ok.md", undefined, null, dedup);
    expect(third.injectedContent).toContain("OK_CONTENT");
    context = third.injectedContent!;

    // 文件改动（mtime 变）：重新注入
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, "ok.md"), future, future);
    const fourth = await expandAtReferences("再看 @ok.md", undefined, null, dedup);
    expect(fourth.injectedContent).toContain("OK_CONTENT");
  });
});

describe("5. 目录引用", () => {
  test("@src/ 注入条目名，不递归", async () => {
    const r = await expandAtReferences("看下 @src/");
    const injected = r.injectedContent ?? "";
    expect(injected).toContain("- a.ts");
    expect(injected).toContain("- sub/");
    expect(injected).not.toContain("deep.ts");
    expect(injected).not.toContain("DEEP");
  });

  test("超过 1000 条时截断并附剩余数量", async () => {
    const r = await expandAtReferences("看下 @huge");
    const injected = r.injectedContent ?? "";
    expect(injected).toContain("共 1005 项");
    expect(injected).toContain("另有 5 项未列出");
    expect(injected).toContain("e0999");
    expect(injected).not.toContain("e1000");
  });

  test("包名形态撞上同名目录时注入列表（体积受上限约束）", async () => {
    const r = await expandAtReferences("看下 @scope/ 的导出");
    expect(r.injectedContent).toContain("- pkg");
    expect(r.injectedContent).not.toContain("SCOPE_PKG_FILE");
  });
});
