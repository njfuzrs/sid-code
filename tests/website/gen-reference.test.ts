/**
 * 参考页生成器的反漂移测试（T-3.6 / T-3.6b / T-3.6c，设计见 §4.5.2 问题 B）。
 *
 * 分工要说清：`--check` 解决的是**问题 A（同源性）**——生成物与源码是否一致；
 * 它证明不了**问题 B（提取正确性）**——生成器有没有读错/漏读源码。
 * `--check` 对一个「只读到 3 个工具」的生成器同样会给绿灯：生成物与它自己的
 * 错误认知一致。所以本文件的核心是问题 B：
 *
 *   ① 计数断言   —— 生成的表格行数 == 运行时真值的成员数（漏读一类就失败）
 *   ② 抽样断言   —— 已知条目必须在表里且描述正确（读错位置就失败）
 *   ③ 非空断言   —— 不允许空描述（提取路径悄悄失配时，通常表现为整列空白）
 *   ④ 双源对账   —— cli.ts parseArgs × help.ts 两类真缺陷基线归零（§4.5.5）
 *   ⑤ --check 自洽 —— 干净状态退 0
 *
 * ⚠ 计数断言刻意**不写死数字**（不写 "== 44"）：写死的话每次加一个工具都要改测试，
 * 改测试的手会顺手把数字改对，断言就退化成摆设。改为「生成物 == 运行时真值」的
 * 关系断言——两边同源但路径不同（一边过生成器，一边直接 import），漏读才抓得住。
 * 这一点由 T-3.6b（故意让生成器漏读 → 断言必须失败）反向验证。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  reconcileCli,
  extractParseArgsFlags,
  extractHelpFlags,
  spliceAutoGen,
  findStalePages,
  checkNarrativeCoverage,
  __coverageInternals,
  HELP_ONLY_WHITELIST,
  HIDDEN_FLAGS,
  MARKER_START,
  MARKER_END,
} from "../../scripts/docs-gen-reference.ts";

const ROOT = resolve(import.meta.dir, "..", "..");

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * 取 AUTO-GEN 标记内的自动区内容（标记外是人工内容，不参与计数）。
 * 用生成器导出的完整标记常量匹配——页面提示语里有字面 `<!-- AUTO-GEN:START -->`，
 * 用前缀匹配会命中它，取到的“自动区”其实是提示语，所有计数断言都会错。
 */
function autoGenBody(page: string): string {
  const src = read(`website/ref/${page}.md`);
  const s = src.indexOf(MARKER_START);
  expect(s, `${page}.md 应含完整 AUTO-GEN:START 标记`).toBeGreaterThanOrEqual(0);
  const e = src.indexOf(MARKER_END, s + MARKER_START.length);
  expect(e, `${page}.md 应在 START 之后含 AUTO-GEN:END 标记`).toBeGreaterThan(s);
  return src.slice(s, e);
}

/** 数表格数据行（跳过表头与分隔行），返回首列去掉 backtick/反斜杠的名字 */
function tableRowKeys(body: string): string[] {
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 2) continue;
    const first = cells[0].trim();
    if (!first || /^-+$/.test(first) || !first.startsWith("`")) continue;
    keys.push(first.replace(/`/g, "").replace(/\\/g, "").replace(/\s*⚠$/, "").trim());
  }
  return keys;
}

/**
 * 各页「描述列」的下标。不能统一取最后一列——tools/slash-commands 的最后一列是
 * 参数列，那里 `—`（无可选参数）和 backtick 包裹的 `<type>` 都是合法内容，
 * 拿它做非空/裸尖括号断言会误报。
 */
const DESC_COL: Record<string, number> = {
  tools: 1, // 工具名 | 用途 | 必填参数 | 可选参数
  "slash-commands": 1, // 命令 | 说明 | 别名 | 参数
  hooks: 1, // 事件名 | 触发时机
  settings: 3, // 字段 | 类型 | 取值/约束 | 说明
  cli: 1, // 参数 | 说明
  env: 1, // 变量 | 说明
};

/** 表格数据行（每行按列切好），供描述列断言使用 */
function tableRows(body: string): Array<string[]> {
  const rows: Array<string[]> = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2 || /^-+$/.test(cells[0]) || !cells[0].startsWith("`")) continue;
    rows.push(cells);
  }
  return rows;
}

describe("参考页生成器 · 计数断言（问题 B：生成器有没有漏读源码）", () => {
  test("ref/tools 的行数 == --dump-tools 返回的工具数", () => {
    // 直连运行时真值，与生成器走的是同一个出口但独立一次调用
    const proc = Bun.spawnSync(
      ["bun", "run", join(ROOT, "src/entrypoints/bootstrap.ts"), "--dump-tools"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode, `--dump-tools 应退 0，stderr: ${proc.stderr.toString()}`).toBe(0);
    const defs = JSON.parse(proc.stdout.toString());
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);

    const keys = tableRowKeys(autoGenBody("tools"));
    expect(keys.length).toBe(defs.length);
    // 不只比数量：名字集合必须完全一致（数量对但张冠李戴也是漂移）
    expect(new Set(keys)).toEqual(new Set(defs.map((d: any) => d.name)));
  }, 60_000);

  test("ref/slash-commands 的行数 == loadBuiltinCommands() 的命令数", async () => {
    const { loadBuiltinCommands } = await import("../../src/command/loaders.ts");
    const cmds = await loadBuiltinCommands();
    expect(cmds.length).toBeGreaterThan(0);

    const keys = tableRowKeys(autoGenBody("slash-commands")).map((k) => k.replace(/^\//, ""));
    expect(keys.length).toBe(cmds.length);
    expect(new Set(keys)).toEqual(new Set(cmds.map((c: any) => c.name)));
  }, 30_000);

  test("ref/hooks 的行数 == HookEventName 枚举成员数", async () => {
    const { HookEventName } = await import("../../src/hook/types.ts");
    const members = Object.keys(HookEventName);
    expect(members.length).toBeGreaterThan(0);

    const keys = tableRowKeys(autoGenBody("hooks"));
    expect(keys.length).toBe(members.length);
    expect(new Set(keys)).toEqual(new Set(members));
  });

  test("ref/settings 的行数 == SettingsSchema 字段数 + passthrough 补录数", async () => {
    const { SettingsSchema } = await import("../../src/config/settings/types.ts");
    const schemaKeys = Object.keys(SettingsSchema().shape);
    expect(schemaKeys.length).toBeGreaterThan(0);

    const body = autoGenBody("settings");
    const keys = tableRowKeys(body);
    // schema 声明的字段一个都不能少
    for (const k of schemaKeys) {
      expect(keys, `settings 表缺 schema 字段 ${k}`).toContain(k);
    }
    // passthrough 字段（写了能用但 schema 未声明）也必须在表里，且逐行标了 ⚠。
    // 只数表格行里的 ⚠——导语里也写了一个 ⚠（"11 个标 ⚠ 的字段"），
    // 拿整段 body 数会多算一个。
    const passthroughCount = keys.length - schemaKeys.length;
    expect(passthroughCount).toBeGreaterThan(0);
    const markedRows = tableRows(body).filter((cells) => cells[0].includes("⚠"));
    expect(markedRows.length).toBe(passthroughCount);
    // 且导语声明的数量要与实际标记数一致（导语数字也是生成的，不能对不上）
    expect(body).toContain(`${passthroughCount} 个标 ⚠ 的字段`);
  });

  test("ref/cli 的 parseArgs flag 计数与源码一致", () => {
    const flags = extractParseArgsFlags(read("src/cli.ts"));
    expect(flags.length).toBeGreaterThan(0);
    // 生成页在导语里写了 flag 总数，必须与实际提取值一致
    expect(autoGenBody("cli")).toContain(`共 ${flags.length} 个 flag`);
  });
});

describe("参考页生成器 · 抽样断言（读对了没有，不只是读到了几个）", () => {
  test("tools 表含已知工具且描述非占位", () => {
    const rows = tableRows(autoGenBody("tools"));
    const byName = new Map(rows.map((r) => [r[0].replace(/`/g, ""), r]));
    for (const name of ["bash", "read", "write", "grep"]) {
      const row = byName.get(name);
      expect(row, `tools 表应含 ${name}`).toBeDefined();
      expect(row![1].length).toBeGreaterThan(4);
    }
    // bash 的必填参数就是 command —— 说明 input_schema 的 required 读对了
    expect(byName.get("bash")![2]).toContain("command");
  }, 60_000);

  test("hooks 表把「未接线」事件如实标注，不谎称可用", () => {
    const rows = tableRows(autoGenBody("hooks"));
    const byName = new Map(rows.map((r) => [r[0].replace(/`/g, ""), r[1]]));
    // PreToolUse 是已接线且可 block 的代表
    expect(byName.get("PreToolUse")).toContain("block");
    // 这批事件有 fire 方法但 hook 子系统外无调用者（已 grep 确认），
    // 文档必须说明「配了不会被触发」——参考页谎称有此能力比不写更糟
    for (const unwired of ["Setup", "ConfigChange", "FileChanged", "TaskCreated"]) {
      expect(byName.get(unwired), `hooks 表缺 ${unwired}`).toBeDefined();
      expect(byName.get(unwired), `${unwired} 未标注「预留」`).toContain("预留");
    }
  });

  test("settings 表的类型/枚举取值取自 zod schema 而非猜测", () => {
    const rows = tableRows(autoGenBody("settings"));
    const byName = new Map(rows.map((r) => [r[0].replace(/`/g, "").replace(/\s*⚠$/, ""), r]));

    // language: z.enum(["zh","en"]) → 类型 enum、取值列出两个枚举值
    const lang = byName.get("language");
    expect(lang, "settings 表应含 language").toBeDefined();
    expect(lang![1]).toBe("enum");
    expect(lang![2]).toContain("zh");
    expect(lang![2]).toContain("en");

    // maxTokens: z.number().min(1000) → 约束列体现 ≥1000
    expect(byName.get("maxTokens")![1]).toBe("number");
    expect(byName.get("maxTokens")![2]).toContain("1000");

    // §4.5.6 点名不能缺的字段
    for (const k of ["permissions", "costLimit", "allowedDirectories"]) {
      expect(byName.has(k), `settings 表缺 ${k}`).toBe(true);
    }
  });

  test("cli 表含子命令段与已知参数", () => {
    const body = autoGenBody("cli");
    for (const sub of ["review", "daemon", "mcp", "agents"]) {
      expect(body).toContain(`sid-code ${sub}`);
    }
    expect(body).toContain("--permission-mode");
    expect(body).toContain("--dangerously-skip-permissions");
  });

  test("env 表含已知环境变量", () => {
    const keys = tableRowKeys(autoGenBody("env"));
    for (const v of ["ANTHROPIC_API_KEY", "SID_CONFIG_DIR", "SID_CODE_TRACE", "NO_COLOR"]) {
      expect(keys, `env 表缺 ${v}`).toContain(v);
    }
  });
});

describe("参考页生成器 · 非空断言（提取路径静默失配时通常整列空白）", () => {
  for (const page of ["tools", "slash-commands", "hooks", "settings", "cli", "env"]) {
    test(`ref/${page} 无空描述、无占位文本`, () => {
      const body = autoGenBody(page);
      // 阶段 1 的占位文本必须已被真内容替换
      expect(body).not.toContain("待生成");
      const rows = tableRows(body);
      expect(rows.length).toBeGreaterThan(0);
      for (const cells of rows) {
        const desc = cells[DESC_COL[page]];
        expect(desc?.length, `${page} 的 ${cells[0]} 描述为空`).toBeGreaterThan(0);
        expect(desc, `${page} 的 ${cells[0]} 描述是占位符`).not.toBe("—");
      }
    });
  }
});

describe("参考页生成器 · CLI 双源交叉对账（§4.5.5）", () => {
  const rec = () => reconcileCli(read("src/cli.ts"), read("src/help.ts"));

  test("能用但 help 没写：基线为 0（T-3.4b 已补 --allow-tool/--deny-tool）", () => {
    // 这一类是真缺陷：用户能用的参数没写进文档
    expect(rec().missingInHelp).toEqual([]);
  });

  test("help 写了但顶层 parseArgs 没声明：只允许白名单内的合法差异", () => {
    // 这一类是最坏情况：用户照抄文档会撞「未知选项」
    expect(rec().unknownInHelp).toEqual([]);
  });

  test("白名单每条都有理由，且仍然真实存在于 help 中（防白名单腐烂）", () => {
    const helpFlags = new Set(extractHelpFlags(read("src/help.ts")));
    for (const [flag, reason] of Object.entries(HELP_ONLY_WHITELIST)) {
      expect(reason.length, `白名单 ${flag} 缺理由`).toBeGreaterThan(4);
      // help 里已经删掉的 flag 不该继续挂在白名单上——那会掩盖后续真缺陷
      expect(helpFlags.has(flag), `白名单 ${flag} 已不在 help.ts 中，应移除`).toBe(true);
    }
  });

  test("隐藏 flag 每条都有理由，且确实在 parseArgs 里声明", () => {
    const cliFlags = new Set(extractParseArgsFlags(read("src/cli.ts")));
    for (const [flag, reason] of Object.entries(HIDDEN_FLAGS)) {
      expect(reason.length, `隐藏 flag ${flag} 缺理由`).toBeGreaterThan(4);
      expect(cliFlags.has(flag), `隐藏 flag ${flag} 已不在 parseArgs 中，应移除`).toBe(true);
    }
  });

  test("--dump-tools 属隐藏出口：声明了但刻意不进 help，不该被算作缺陷", () => {
    expect(extractParseArgsFlags(read("src/cli.ts"))).toContain("dump-tools");
    expect(extractHelpFlags(read("src/help.ts"))).not.toContain("dump-tools");
    expect(rec().missingInHelp).not.toContain("dump-tools");
  });
});

describe("参考页生成器 · --check 自洽（问题 A：同源性）", () => {
  test("干净状态下 --check 退 0", () => {
    const proc = Bun.spawnSync(["bun", "run", "scripts/docs-gen-reference.ts", "--check"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(
      proc.exitCode,
      `--check 应退 0；若失败说明工作区参考页与源码不一致，跑 bun run docs:gen-reference。` +
        `stdout: ${proc.stdout.toString()} stderr: ${proc.stderr.toString()}`,
    ).toBe(0);
  }, 120_000);

  test("--stale 只报告不阻塞（退 0），且能识别超期页", () => {
    const proc = Bun.spawnSync(["bun", "run", "scripts/docs-gen-reference.ts", "--stale"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);

    // 阈值逻辑本身用纯函数验：把基准日推到很远的未来，所有有 lastReviewed 的页都该超期
    const far = findStalePages("2099-01-01");
    const near = findStalePages("1971-01-01");
    expect(near.stale.length).toBe(0); // 基准日早于任何 lastReviewed → 不该有超期
    expect(far.stale.length + far.missing.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("叙述覆盖度门禁 · 匹配器准确度（判宽=门禁失效，判严=逼人加豁免）", () => {
  const { mentionsCommand, stripDumpFences, stripLinkTargets, NARRATIVE_EXEMPT } =
    __coverageInternals;

  test("正常提及算覆盖（行首、句中、backtick 包裹、带参数）", () => {
    expect(mentionsCommand("/goal 设定完成条件", "goal")).toBe(true);
    expect(mentionsCommand("用 `/cache --breaks` 查退化", "cache")).toBe(true);
    expect(mentionsCommand("先跑 /doctor 看看", "doctor")).toBe(true);
    expect(mentionsCommand("| `/undo` | 撤销 |", "undo")).toBe(true);
  });

  test("右边界：前缀同名的长命令不算覆盖短命令", () => {
    // 实测风险：/think 被 /thinking 撑住、/co 被 /context 撑住
    expect(mentionsCommand("讲的是 /thinking 这个东西", "think")).toBe(false);
    expect(mentionsCommand("/context 压缩", "co")).toBe(false);
    expect(mentionsCommand("/add-dir-extra", "add-dir")).toBe(false);
  });

  test("左边界：路径片段里的同名段不算覆盖（本轮真实误判之一）", () => {
    // `~/.sid-code/agents/` 曾让 /agents 假覆盖
    expect(mentionsCommand("放到 ~/.sid-code/agents/ 下", "agents")).toBe(false);
    expect(mentionsCommand("mkdir -p /tmp/demo-plugin/commands", "commands")).toBe(false);
    expect(mentionsCommand("见 docs/reference/init.md", "init")).toBe(false);
  });

  test("markdown 链接目标不算覆盖：两种链接形态各由一道机制拦住", () => {
    // 这是本轮真实误判之二：早期实现（无左边界、不剥链接）把 `](/use/permissions)`
    // 算成"提到了 /permissions 命令"，于是一个字介绍都没有的 /permissions 被判已覆盖。
    // 修复后两种链接形态由**不同**机制拦住，分工要测清楚，否则删掉任一都以为安全：

    // ① 多段链接 `](/use/permissions)`：命令名前是 `e`（路径字符）→ 左边界拦住，无需剥离
    const multiSeg = "六种模式见[权限与人工确认](/use/permissions)。";
    expect(mentionsCommand(multiSeg, "permissions"), "左边界应拦住多段链接").toBe(false);

    // ② 单段链接 `](/changelog)`：命令名前是 `(`，**不是**路径字符 → 左边界拦不住，
    //    必须靠剥离链接目标。这一类是站内顶层页链接，一旦有命令与顶层页同名就会假覆盖。
    const singleSeg = "见[更新日志](/changelog)。";
    expect(mentionsCommand(singleSeg, "changelog"), "左边界拦不住单段链接（本回归的前提）").toBe(
      true,
    );
    expect(
      mentionsCommand(stripLinkTargets(singleSeg), "changelog"),
      "剥离链接目标后不应再命中",
    ).toBe(false);

    // 真正的介绍（命令写在正文/表格里）两道机制都不该误伤
    expect(mentionsCommand(stripLinkTargets("跑 `/permissions` 看当前规则"), "permissions")).toBe(
      true,
    );

    // /permissions 已被 use/permissions.md:172 覆盖（commit 1ad35f71 补全 §2.2 八项后下调基线）。
    // 若将来该覆盖又被移除，这条会失败提醒恢复。
    expect(checkNarrativeCoverage(["permissions"]).uncovered).toEqual([]);
  });

  test("清单式代码块不算覆盖（防贴一段 /help 输出就'覆盖'全部命令）", () => {
    const dump = ["```text", "/clear", "/compact", "/context", "/cost", "/doctor", "```"].join("\n");
    const one = ["```text", "/copy        复制最后一条回复", "```"].join("\n");

    // 清单被整块丢弃 → 里面的命令一个都不算覆盖
    expect(mentionsCommand(stripDumpFences(dump), "compact")).toBe(false);
    // 单命令用法示例保留 → 仍算覆盖
    expect(mentionsCommand(stripDumpFences(one), "copy")).toBe(true);
  });

  test("普通用法围栏要保留（否则写在围栏里的 /copy /init 会被误判未覆盖）", () => {
    // /copy 全站只在 use/interactive.md 的代码围栏里出现，是真覆盖
    const r = checkNarrativeCoverage(["copy", "init", "vim"]);
    expect(r.uncovered, "围栏内的真实用法示例应算覆盖").toEqual([]);
  });

  test("豁免必须逐条带理由，且理由非空", () => {
    // 防豁免表退化成"塞进去就不用写文档"的后门
    expect(Object.keys(NARRATIVE_EXEMPT).length).toBeLessThanOrEqual(5);
    for (const [name, reason] of Object.entries(NARRATIVE_EXEMPT)) {
      expect(reason.length, `/${name} 的豁免理由为空`).toBeGreaterThan(8);
    }
  });
});

describe("叙述覆盖度门禁 · 端到端", () => {
  test("--coverage 只告警不阻塞（退 0），且输出未覆盖清单", () => {
    const proc = Bun.spawnSync(["bun", "run", "scripts/docs-gen-reference.ts", "--coverage"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("个内置命令");
  }, 60_000);

  test("覆盖统计自洽：covered + uncovered + exempt == 命令总数", () => {
    const keys = tableRowKeys(autoGenBody("slash-commands")).map((k) => k.replace(/^\//, ""));
    const r = checkNarrativeCoverage(keys);
    expect(r.covered.size + r.uncovered.length + r.exempt.length).toBe(keys.length);
    expect(r.total).toBe(keys.length);
  });

  test("存量基线只减不增（改动不得让未覆盖命令变多）", () => {
    // 基线随存量清理下调；这条断言的作用是防"新增命令又不写文档"把数字顶回去。
    // 2026-07 核对时为 18。清到 0 后把 pre-commit 换成 --coverage-strict。
    const BASELINE = 18;
    const keys = tableRowKeys(autoGenBody("slash-commands")).map((k) => k.replace(/^\//, ""));
    const { uncovered } = checkNarrativeCoverage(keys);
    expect(
      uncovered.length,
      `未覆盖命令数升到 ${uncovered.length}（基线 ${BASELINE}）：${uncovered.join(" ")}\n` +
        `新增命令请同时在 start/use/extend/team 下补一段说明；` +
        `若确为存量清理导致下降，请同步下调 BASELINE。`,
    ).toBeLessThanOrEqual(BASELINE);
  });
});

describe("参考页生成器 · AUTO-GEN 标记语义（T-3.6c）", () => {
  test("标记外的人工内容在重新生成后保留", () => {
    const original = read("website/ref/tools.md");
    const next = spliceAutoGen(original, "生成内容占位", "tools.md");
    // 标记外的 frontmatter / 标题 / 警示块必须原样保留
    expect(next).toContain("title: 内置工具");
    expect(next).toContain("# 内置工具");
    expect(next).toContain("本页由脚本生成，请勿手工编辑");
    expect(next).toContain("生成内容占位");
  });

  test("标记内的手改会被覆盖（不残留）", () => {
    const src = read("website/ref/tools.md");
    const s = src.indexOf(MARKER_START);
    const e = src.indexOf(MARKER_END, s + MARKER_START.length);
    const tampered =
      src.slice(0, s) + MARKER_START + "\n\n手工塞进来的假内容\n\n" + src.slice(e);
    expect(tampered).toContain("手工塞进来的假内容");

    const regenerated = spliceAutoGen(tampered, "真内容", "tools.md");
    expect(regenerated).not.toContain("手工塞进来的假内容");
    expect(regenerated).toContain("真内容");
  });

  test("END 标记的定位从 START 之后开始（防命中 START 前的字面标记）", () => {
    // spliceAutoGen 必须从 START 之后找 END，不能用裸 indexOf(END)：
    // 早期实现撞过一个 bug——文件里在真 START 标记之前字面出现了 `<!-- AUTO-GEN:END -->`
    // （历史版本各参考页的「请勿手工编辑」提示语里就给人看地写着这两个标记串），
    // 裸 indexOf(END) 会命中那个、拿到比 START 更小的下标，splice 出的文件把提示语
    // 后半段和正文一起吃掉。
    //
    // 现在提示语已改为 HTML 注释（不渲染给终端用户），真实页面文件里不再有字面 END 标记；
    // 但 spliceAutoGen 的实现仍须防这个回归。改用合成输入直接验证被测函数的行为——
    // 不再依赖真实页面文件必须包含字面标记这个脆弱前提（提示语形式是会变的）。
    const fake = [
      "前置说明：这里字面写着 END 标记（给人看的，不是真标记）",
      MARKER_END,
      "（这段应被保留，不能被 splice 吃掉）",
      MARKER_START,
      "",
      "旧的自动区内容",
      "",
      MARKER_END,
      "",
    ].join("\n");
    // 前提：字面 END 出现在真 START 之前（这正是会触发裸 indexOf bug 的布局）
    expect(fake.indexOf(MARKER_END), "合成输入里字面 END 须在真 START 之前").toBeLessThan(
      fake.indexOf(MARKER_START),
    );

    const out = spliceAutoGen(fake, "生成内容标记", "fake.md");
    // START 前的字面说明须原样保留（没被误当真标记吃掉）
    expect(out).toContain("前置说明");
    expect(out).toContain("（这段应被保留");
    // 旧的自动区内容被覆盖（不残留）
    expect(out).not.toContain("旧的自动区内容");
    // 只写入了一处生成内容
    expect((out.match(/生成内容标记/g) ?? []).length).toBe(1);
  });

  test("缺标记对时报错而非静默跳过", () => {
    expect(() => spliceAutoGen("# 没有标记的文件\n", "X", "fake.md")).toThrow(/AUTO-GEN/);
  });
});

describe("参考页生成器 · 产物可被 VitePress 安全渲染", () => {
  test("描述列不含裸 < 或 {{（会被 Vue 编译器当标签/插值，整站构建失败）", () => {
    // 实测撞过：/loop 的描述含 `<任务>`，未转义导致 "Element is missing end tag" 构建失败。
    for (const page of ["tools", "slash-commands", "hooks", "settings", "cli", "env"]) {
      for (const cells of tableRows(autoGenBody(page))) {
        const desc = cells[DESC_COL[page]] ?? "";
        // backtick 包裹的代码片段由 markdown-it 自行转义，此处只查非代码描述
        const outsideCode = desc.replace(/`[^`]*`/g, "");
        expect(outsideCode, `${page} 的 ${cells[0]} 描述含裸 <`).not.toMatch(/<[a-zA-Z/]/);
        expect(outsideCode, `${page} 的 ${cells[0]} 描述含裸 {{`).not.toContain("{{");
      }
    }
  });

  test("llms.txt 存在、含全站页面清单且链接为 cleanUrls 形态", () => {
    const llms = read("website/public/llms.txt");
    expect(llms).toContain("# sid-code");
    expect(llms).toContain("/ref/cli");
    expect(llms).toContain("/start/install");
    // cleanUrls: true —— 不该出现 .html 或 .md 后缀
    expect(llms).not.toMatch(/\.html\)/);
    expect(llms).not.toMatch(/\.md\)/);
    // 页面数量应与站内 md 文件数一致
    const declared = Number(llms.match(/共 (\d+) 页/)?.[1] ?? 0);
    const actual = [...new Bun.Glob("**/*.md").scanSync(join(ROOT, "website"))].filter(
      (f) => !f.startsWith("node_modules") && !f.startsWith(".vitepress"),
    ).length;
    expect(declared).toBe(actual);
  });
});
