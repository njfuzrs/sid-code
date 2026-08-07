/**
 * `@import` 提取的标点边界（B1）
 *
 * 背景：`extractImportsFromLine` 的 token 字符类原本是 `[^\s\\]+`，只把空白当终止符。
 * 中文标点不是空白，于是 `见 @NOTE.md，然后继续` 把「，然后继续」一起吞进路径。
 * 原实现有一句事后 strip（`replace(/[…]+$/g, "")`），但它**方向就是错的**：
 * 真实形态是 `（已脱离 @NOTE.md）。**后续` —— 标点后面还有非标点字符，
 * `$` 锚定的正则永远匹配不上。**清洗输出治不了输入端的过度接纳。**
 *
 * 实测 8 种形态 6 种失效（顿号 / 全角引号 / 感叹号是原先未被记录的）。
 *
 * 本文件走 `processImports`（导出的生产入口）而非私有的提取函数 ——
 * 断言的是「正文真的被展开了」，而不是「提取函数返回了什么」。
 * 后者证明不了端到端接线；这个函数同时被主加载路径（`rules.ts:loadAndParse`）
 * 与 JIT 路径（`jit-context.ts`）消费，任一路径断掉都必须能被这里抓到。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { processImports } from "../../src/config/import-processor.ts";

/** 唯一哨兵串：出现在结果里 ⇔ 导入被展开 */
const BODY = "NOTE_BODY_SENTINEL_7f3a";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "import-punct-"));
  writeFileSync(join(root, "NOTE.md"), BODY);
  writeFileSync(join(root, "a.b.md"), BODY);
  mkdirSync(join(root, "文档"), { recursive: true });
  writeFileSync(join(root, "文档", "说明.md"), BODY);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function expand(line: string): Promise<string> {
  return processImports(line, join(root, "CLAUDE.md"), {
    allowedDirectories: [root],
    projectRoot: root,
  });
}

/** 提取结果的可观测代理：展开成功 ⇔ 路径提取正确（错误路径 existsSync 必失败） */
async function didExpand(line: string): Promise<boolean> {
  return (await expand(line)).includes(BODY);
}

describe("B1 · 中文标点不得吞掉 @import", () => {
  const SHOULD_EXPAND: Array<[string, string]> = [
    ["英文逗号+后续", "see @NOTE.md, then go"],
    ["中文逗号句末", "详见 @NOTE.md，"],
    ["中文逗号+后续", "见 @NOTE.md，然后继续"],
    ["中文句号+后续", "见 @NOTE.md。然后继续"],
    ["括号+句号+强调（事后剥离治不了的那一种）", "（已脱离 @NOTE.md）。**后续"],
    ["中文顿号+后续", "见 @NOTE.md、以及别的"],
    ["全角引号包裹（前导字符类也要放开的哨兵）", "见「@NOTE.md」后续"],
    ["全角双引号包裹", "见 “@NOTE.md”后续"],
    ["感叹号+后续", "见 @NOTE.md！后续"],
    ["问号+后续", "是 @NOTE.md？后续"],
    ["分号+后续", "见 @NOTE.md；后续"],
    ["冒号前置", "参考：@NOTE.md，完"],
    ["#fragment 剥离（借鉴 CC claudemd.ts:466）", "见 @NOTE.md#标题 后续"],
    ["行首独占", "@NOTE.md"],
    ["行首独占+中文句号", "@NOTE.md。"],
  ];

  for (const [desc, line] of SHOULD_EXPAND) {
    test(`展开 · ${desc}`, async () => {
      expect(await didExpand(line)).toBe(true);
    });
  }

  test("哨兵 · 纯中文路径必须可用（不可照抄 CC 的 isValidPath 首字符白名单）", async () => {
    // CC claudemd.ts:477 要求首字符 ^[a-zA-Z0-9._-]，副作用是纯中文路径直接不认。
    // 这个仓库的规则文件全中文，`@文档/说明.md` 是合法形态 —— 照抄会让它静默失效。
    expect(await didExpand("见 @文档/说明.md，后续")).toBe(true);
  });

  test("哨兵 · 路径内的点不得被剥掉（事后剥离不可过度贪婪）", async () => {
    // 若有人把 `.` 加进终止符集合，`a.b.md` 会被截成 `a` —— 这条会变红。
    expect(await didExpand("见 @a.b.md，后续")).toBe(true);
  });

  test("哨兵 · 提取到的相对路径原样保真（不是靠碰巧存在的兜底）", async () => {
    const out = await expand("见 @文档/说明.md，后续");
    // 展开标记里写的是**提取出来的原始 importPath**，所以它能验出「提取结果」本身，
    // 而不只是「最终有没有读到文件」。
    expect(out).toContain("<!-- @import 文档/说明.md -->");
    // 标点不得进入**标记里的路径**。注意不能断言整份输出不含 `说明.md，` ——
    // 原始行是刻意保留的（行内 prose 不破坏），那个逗号本来就在第一行。
    expect(out).not.toContain("@import 文档/说明.md，");
  });
});

describe("B1 · 回归：不得误抓", () => {
  const SHOULD_NOT_EXPAND: Array<[string, string]> = [
    ["邮箱形态（@ 前无空白/标点）", "a@NOTE.md 是邮箱形态"],
    ["行内代码包裹", "见 `@NOTE.md` 行内代码"],
    ["单词中间的 @", "xx@NOTE.md"],
  ];

  for (const [desc, line] of SHOULD_NOT_EXPAND) {
    test(`不展开 · ${desc}`, async () => {
      expect(await didExpand(line)).toBe(false);
    });
  }

  test("代码围栏内不提取", async () => {
    const out = await expand("```\n@NOTE.md\n```");
    expect(out).not.toContain(BODY);
  });

  test("原始行永远保留（行内 prose 不得被破坏）", async () => {
    const line = "见 @NOTE.md，然后继续";
    const out = await expand(line);
    expect(out.split("\n")[0]).toBe(line);
  });

  test("多个导入同行都能提取", async () => {
    const out = await expand("见 @NOTE.md，另见 @a.b.md。完");
    expect(out).toContain("<!-- @import NOTE.md -->");
    expect(out).toContain("<!-- @import a.b.md -->");
  });
});
