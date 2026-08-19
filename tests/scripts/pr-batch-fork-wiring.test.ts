/**
 * pr-batch.sh 的分叉闭环接线门禁。
 *
 * ## 治的是什么
 *
 * `pr-batch-derived.test.ts` 测的是**计算对不对**；这份测的是**它有没有被接上**。
 * 两者必须都有 —— 本仓的反复教训是「函数写好了、导出了、测试全绿，
 * 但生产路径上没人调它」（见记忆里 background-task-panel-never-clears、
 * subagent-hook-wiring-order 那两类）。分叉闭环有三个接线点，
 * 每一个断掉都不会有任何报错：
 *
 *   ① `open` 不再附加 fork-protocol.md → agent 回到「记下来告诉我」那个死路
 *   ② `prepare` 不再跑派生守卫          → 带着过期分层结果开工，静默
 *   ③ `list` 不再显示派生问题摘要        → 「我还有什么没做」再次只存在于 GitHub
 *
 * 三个都是**删掉之后一切照常工作**的形态，所以必须有哨兵钉住。
 *
 * ⚠️ 这份门禁只断言「接线在」，不断言「行为对」——
 * 行为由 pr-batch-derived.test.ts 的变异自证负责。别在这里重复。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "pr-batch.sh");
const PROTOCOL = join(REPO_ROOT, "scripts", "pr-batch", "fork-protocol.md");
const LIB = join(REPO_ROOT, "scripts", "lib", "pr-batch-derived.ts");

const script = (): string => readFileSync(SCRIPT, "utf-8");

describe("分叉闭环的三个接线点", () => {
  test("三个文件都在（协议本体必须入库，否则 worktree 里的人无法 review 它）", () => {
    // 入库这件事本身是 G7 那条通则的应用：worktree 只继承 main 上已有的东西。
    // 协议若只活在主仓工作区，worktree 里的 agent 看不到 —— 而它正是给 agent 的。
    expect(existsSync(SCRIPT)).toBe(true);
    expect(existsSync(PROTOCOL)).toBe(true);
    expect(existsSync(LIB)).toBe(true);
  });

  test("① open 把 fork-protocol.md 拼进 prompt，且缺文件时 hard-stop", () => {
    const s = script();
    expect(s).toContain('fork_protocol="$REPO_ROOT/scripts/pr-batch/fork-protocol.md"');
    // 拼接：新开会话那一支必须 cat 协议
    expect(s).toMatch(/exec claude[\s\S]{0,600}cat "\$fork_protocol"/);
    // hard-stop：缺协议不许降级成「少附加一段」继续跑 ——
    // 那样会静默回到死路，而人以为流程还在。
    expect(s).toMatch(/\[\[ -f "\$fork_protocol" \]\] \|\| \{[\s\S]{0,200}exit 1/);
  });

  test("① 续接分支（-c）也要提醒协议仍生效", () => {
    // 续接时刻意不重贴整份协议（重复长文本会让模型重做已完成的部分），
    // 但一句提醒不能省 —— 否则续上的会话又回到死路。
    const s = script();
    const contBranch = s.slice(s.indexOf('exec claude "${perm_args[@]}" -c'));
    expect(contBranch.slice(0, 900)).toContain("分叉处置协议");
  });

  test("② prepare 跑派生守卫，且是 exit 1 的 hard-stop", () => {
    const s = script();
    const prepareBlock = s.slice(s.indexOf("prepare) # prepare"), s.indexOf("open) # open"));
    expect(prepareBlock).toContain("$DERIVED_LIB");
    expect(prepareBlock).toContain("--json");
    // 必须是拒绝，不是打印警告后继续 —— 警告会被当噪声跳过，防线成死功能。
    expect(prepareBlock).toContain("⛔ 拒绝 prepare");
    expect(prepareBlock).toMatch(/PR_BATCH_IGNORE_DERIVED[\s\S]{0,80}exit 1/);
  });

  test("② 守卫只在「还开着的 issue」上拦（关掉的说明已处置）", () => {
    const prepareBlock = script().slice(
      script().indexOf("prepare) # prepare"),
      script().indexOf("open) # open"),
    );
    expect(prepareBlock).toContain('select(.state == "OPEN")');
  });

  test("③ list 显示派生问题摘要，含未闭环数", () => {
    const s = script();
    const listBlock = s.slice(s.indexOf("list|sync)"), s.indexOf("check-gen)"));
    expect(listBlock).toContain("派生问题");
    expect(listBlock).toContain("分层需重算");
    expect(listBlock).toContain("$DERIVED_LIB");
  });

  test("③ list 的计数锚定 ⚠️ 前缀 —— 裸搜关键词会把处置说明也数进去", () => {
    // 实测踩过：3 条真明细被数成 4，因为报告末尾的处置说明里也有「分层需重算」。
    // 这类「分子多算一」看不出来，因为数字本身合理。
    const listBlock = script().slice(
      script().indexOf("list|sync)"),
      script().indexOf("check-gen)"),
    );
    expect(listBlock).toContain("grep -c '⚠️ 分层需重算'");
    expect(listBlock).not.toMatch(/grep -c '分层需重算'/);
  });

  test("derived / reflow 两个子命令都在 case 里、也都在 usage 里", () => {
    const s = script();
    for (const cmd of ["derived)", "reflow)"]) expect(s).toContain(cmd);
    // usage 漏写 = 功能存在但没人知道，等于不存在（G8 的同一形态）。
    const usage = s.slice(s.indexOf("usage() {"), s.indexOf("# slug 的模糊匹配"));
    expect(usage).toContain("derived");
    expect(usage).toContain("reflow");
  });
});

describe("fork-protocol.md 的内容契约", () => {
  const proto = (): string => readFileSync(PROTOCOL, "utf-8");

  test("给出三分法判据，而不是只说「记下来告诉我」", () => {
    const p = proto();
    // 这三行是原来那个死路的替代品：判完之后每一档都有明确的下一步。
    expect(p).toContain("就在本 PR 里修");
    expect(p).toContain("开 issue");
    expect(p).toContain("停下来问人");
    // 死路措辞不许作为**指令**回来。
    // ⚠️ 不能裸搜「记下来告诉我」—— 协议开头正是在引用并批判这句旧措辞，
    //    裸搜会把那段解释本身判成违规（实测：这条断言第一版就这么红的）。
    //    锚定「记下来告诉我，」这个指令形态（原 prompt 里它后面跟的是逗号+下一句要求），
    //    引用时它出现在「只说「…记下来告诉我」——」里，被引号和破折号包着。
    expect(p).not.toMatch(/记下来告诉我，/);
  });

  test("标记格式与解析器认的四个键完全一致", () => {
    // 协议里写一套、解析器认另一套 = agent 照协议写了但编排读不到，
    // 且**不会报错**（退化成正文 grep，只降置信度）。这是最隐蔽的一种脱节。
    const p = proto();
    const lib = readFileSync(LIB, "utf-8");
    for (const key of ["from", "pr", "files", "plan-doc-correction"]) {
      expect(p).toContain(`${key}=`);
    }
    expect(p).toContain("<!-- pr-batch:");
    expect(lib).toContain("pr-batch:");
    for (const key of ["from", "pr", "files", "plan-doc-correction"]) {
      expect(lib).toContain(`case "${key}"`);
    }
  });

  test("明确说 files 只写「会改的」，不写对照用的", () => {
    // 这条是假阳性的唯一防线。实测：不写标记时正文 grep 把 #64 的对照文件
    // model-capabilities.ts 也捞出来，凭空多报一条与 PR1 的冲突。
    expect(proto()).toContain("不要把对照用的");
  });

  test("要求 agent 不自己改方案文档（它在仓库外）", () => {
    expect(proto()).toContain("不要自己去改方案文档");
  });
});

describe("plan.json 的派生问题登记（若存在则必须自洽）", () => {
  const PLAN = join(REPO_ROOT, ".pr-batch", "plan.json");

  test("每条 item 都有 issue / files / collides_with / layering 四个字段", () => {
    if (!existsSync(PLAN)) return; // .pr-batch 是本机状态，CI 上没有
    const plan = JSON.parse(readFileSync(PLAN, "utf-8"));
    const items = plan.derived_issues?.items;
    if (!items) return;
    for (const it of items) {
      expect(typeof it.issue).toBe("number");
      expect(Array.isArray(it.files)).toBe(true);
      expect(Array.isArray(it.collides_with)).toBe(true);
      // layering 必须显式写，"未算" 也是一种合法且诚实的取值
      expect(typeof it.layering).toBe("string");
    }
  });

  test("collides_with 非空时，layering 不许写成 C1/C2/C3 除非有行号说明", () => {
    // 铁律：判据输入是 grep -n 的行号。没取行号就填一个 C 级，
    // 是伪造判据输入 —— 比不判更糟，因为它让人以为算过。
    if (!existsSync(PLAN)) return;
    const plan = JSON.parse(readFileSync(PLAN, "utf-8"));
    for (const it of plan.derived_issues?.items ?? []) {
      if (/^C[1-4]$/.test(it.layering)) {
        expect(typeof it.layering_note).toBe("string");
        expect(it.layering_note).toMatch(/:\d+/); // 至少要有一个 file:line 形态的行号
      }
    }
  });
});
