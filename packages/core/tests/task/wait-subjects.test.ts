/**
 * R1：等待对象签名（subject）的统一抽取入口。
 *
 * ## 用例来源
 *
 * 前 5 条是**取证会话的原始输入**，逐字抄录，不加工：
 * - `20261112-180157-b0aa0f1e`：`bash /tmp/wait-pr-779.sh`，两版脚本
 *   （`fixtures/wait-scripts/b0aa0f1e-wait-pr-779-v{1,2}.sh`）
 * - `20261112-175603-ca8d7e5c`：内联 for 循环等 PR #780 合并 / 等 run 43203650726 完成
 * - `20261112-000247-8b8d721f`：`chmod +x /tmp/wait-pr757.sh && bash …`，两版脚本
 *   （`fixtures/wait-scripts/8b8d721f-wait-pr757{,-merge}.sh`）
 *
 * 这五条在改造前**全部抽不出 subject**（`matchStatusQuery` 返回 null、
 * 旧 `extractWaitSubjects` 只认自然语言），所以它们既是验收也是回归：
 * 断言的是「真实现场能抽出来」，不是「实现自洽」。
 *
 * ## 为什么断言精确相等而不是 `toContain`
 *
 * 多余 subject 会让两个不相干的对象互相去重（R2）——所以抽到「不止一个」也是缺陷。
 * 只有脚本用例放宽到 `toContain`：脚本正文里的 shell 片段会带出噪声，而那些噪声
 * 也在同一把尺子下，不值得为它写死。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_SCRIPT_BODY_BYTES,
  collectWaitCommandFamilies,
  collectWaitSubjects,
  extractNaturalLanguageSubjects,
  extractScriptPaths,
  hashScriptBodies,
  normalizeWaitCommand,
  readWaitScriptBodies,
} from "../../src/task/wait-subjects.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "wait-scripts");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/**
 * ca8d7e5c / sg36n1dwy：逐字抄自轨迹（单行，含 `case` / `esac` / `exit`）。
 *
 * 这三个词命令表一个都不认，所以整条命令跑 `matchStatusQuery` 是 null ——
 * 必须靠候选片段切分把 `$(gh pr view 780 …)` 摘出来。
 */
const INLINE_FOR_PR_780 = `cd /Users/zhourusheng/Code/person/sid-code/.sid-code/worktrees/tool-input-unknown-keys && for i in $(seq 1 90); do s=$(gh pr view 780 --json state,mergeStateStatus -q '.state + "|" + .mergeStateStatus' 2>/dev/null); echo "[$i] $s"; case "$s" in MERGED*) echo "PR780_MERGED"; exit 0;; CLOSED*) echo "PR780_CLOSED"; exit 1;; esac; sleep 20; done; echo "PR780_TIMEOUT"; exit 2`;

/** ca8d7e5c / s90axlqm0：逐字抄自轨迹（等 run，然后抓失败日志）。 */
const INLINE_FOR_RUN_43203650726 = `cd /Users/zhourusheng/Code/person/sid-code/.sid-code/worktrees/tool-input-unknown-keys && for i in $(seq 1 60); do st=$(gh run view 43203650726 --json status -q .status 2>/dev/null); if [ "$st" = "completed" ]; then break; fi; sleep 20; done; gh run view --job 131133417920 --log-failed > /tmp/t2-macos-fail.log 2>&1; echo "FETCH_EXIT=$?"; wc -l /tmp/t2-macos-fail.log`;

describe("R1 统一对象签名：真实取证输入", () => {
  test("b0aa0f1e 两版 /tmp/wait-pr-779.sh 都抽出等 PR #779", () => {
    for (const name of ["b0aa0f1e-wait-pr-779-v1.sh", "b0aa0f1e-wait-pr-779-v2.sh"]) {
      const subjects = collectWaitSubjects({ scriptBodies: [fixture(name)] });
      expect({ name, subjects: subjects.includes("gh:pr:779") }).toEqual({ name, subjects: true });
    }
  });

  test("8b8d721f 两版脚本都抽出等 PR #757", () => {
    for (const name of ["8b8d721f-wait-pr757.sh", "8b8d721f-wait-pr757-merge.sh"]) {
      const subjects = collectWaitSubjects({ scriptBodies: [fixture(name)] });
      expect({ name, subjects: subjects.includes("gh:pr:757") }).toEqual({ name, subjects: true });
    }
  });

  test("ca8d7e5c 内联 for 循环抽出等 PR #780（精确相等）", () => {
    expect(collectWaitSubjects({ command: INLINE_FOR_PR_780 })).toEqual(["gh:pr:780"]);
  });

  test("ca8d7e5c 内联 for 循环抽出等 run 43203650726（精确相等）", () => {
    expect(collectWaitSubjects({ command: INLINE_FOR_RUN_43203650726 })).toEqual([
      "gh:run:43203650726",
    ]);
  });

  test("同一个等待的两类来源（命令 + 脚本正文）会合并去重", () => {
    // 真实现场就是这样：命令是 `bash /tmp/wait-pr-779.sh`，对象在文件里
    const subjects = collectWaitSubjects({
      command: "bash /tmp/wait-pr-779.sh",
      scriptBodies: [fixture("b0aa0f1e-wait-pr-779-v1.sh")],
    });
    expect(subjects).toContain("gh:pr:779");
  });
});

describe("R1 统一对象签名：反例（不能被认成等某个 PR）", () => {
  test("重定向到文件 + 单元测试命令 → []", () => {
    // a7d1c888 的测试任务常写成这样；把它认成「等 PR」会让去重误杀真实等待
    expect(collectWaitSubjects({ command: "bun test > /tmp/x.log" })).toEqual([]);
  });

  test("smoke:mutate → []", () => {
    expect(collectWaitSubjects({ command: "bun run smoke:mutate --case hook-block" })).toEqual([]);
  });

  test("普通后台命令（echo / sleep / printf）→ []", () => {
    for (const command of ["echo ready", "sleep 60", "printf abc", "true"]) {
      expect({ command, subjects: collectWaitSubjects({ command }) }).toEqual({
        command,
        subjects: [],
      });
    }
  });

  test("echo 一个查询串不算在查（旧 monitor 私有正则在这里是假阳性）", () => {
    // ⚠️ 这一条是**有意收窄**，不是回归：`echo "gh pr view 780"` 只是打印这行文本，
    // 没有任何对象在变。旧 extractMonitorSubjects 的 `\bgh\s+pr\s+…` 会抽出
    // gh:pr:780，于是「同对象监控」提示会误报。命令表判 echo 不是查询，正是修正它。
    expect(collectWaitSubjects({ command: 'echo "gh pr view 780"' })).toEqual([]);
  });
});

describe("R1 对象签名：命令表口径（与 P1 同一把尺子）", () => {
  test("gh pr checks / view / status 与 gh run view / watch", () => {
    expect(collectWaitSubjects({ command: "gh pr checks 662" })).toEqual(["gh:pr:662"]);
    expect(collectWaitSubjects({ command: "gh pr view 780 --json state" })).toEqual(["gh:pr:780"]);
    expect(collectWaitSubjects({ command: "gh run view 43203650726 --json status" })).toEqual([
      "gh:run:43203650726",
    ]);
  });

  test("命令替换里藏着的查询也要抽出来", () => {
    expect(collectWaitSubjects({ command: 's=$(gh pr checks 662); echo "$s"' })).toEqual([
      "gh:pr:662",
    ]);
  });

  test("自然语言规则保留原三条（唤醒 prompt 的唯一来源）", () => {
    expect(extractNaturalLanguageSubjects("等 PR #780 的 CI")).toEqual(["gh:pr:780"]);
    expect(extractNaturalLanguageSubjects("看 pull/780")).toEqual(["gh:pr:780"]);
    expect(extractNaturalLanguageSubjects("run 43203650726 完成")).toEqual(["gh:run:43203650726"]);
  });

  test("命令族与 subject 同一批文本：内联 for 循环认得 gh_pr_view", () => {
    expect(collectWaitCommandFamilies({ command: INLINE_FOR_PR_780 })).toEqual(["gh_pr_view"]);
  });
});

describe("R1 脚本文件展开：只认命令里字面出现的路径", () => {
  test("解释器 + 路径", () => {
    expect(extractScriptPaths("bash /tmp/wait-pr-779.sh")).toEqual(["/tmp/wait-pr-779.sh"]);
    expect(extractScriptPaths("sh -u ./wait.sh")).toEqual(["./wait.sh"]);
    expect(extractScriptPaths("/bin/bash ../scripts/wait.sh")).toEqual(["../scripts/wait.sh"]);
  });

  test("chmod +x 之后再 bash（8b8d721f 的实际形态）", () => {
    expect(extractScriptPaths("chmod +x /tmp/wait-pr757.sh && bash /tmp/wait-pr757.sh")).toEqual([
      "/tmp/wait-pr757.sh",
    ]);
  });

  test("路径直接执行", () => {
    expect(extractScriptPaths("/tmp/wait-pr757.sh")).toEqual(["/tmp/wait-pr757.sh"]);
    expect(extractScriptPaths("./wait.sh")).toEqual(["./wait.sh"]);
  });

  test("bash -c 后面是命令串不是文件，不能当路径去读", () => {
    expect(extractScriptPaths("bash -c 'gh pr view 780'")).toEqual([]);
    expect(extractScriptPaths("sh -c 'echo hi'")).toEqual([]);
  });

  test("不跟随 source / .（它们常是环境加载或 wrapper）", () => {
    expect(extractScriptPaths("source /tmp/env.sh")).toEqual([]);
    expect(extractScriptPaths(". /tmp/env.sh")).toEqual([]);
  });

  test("PATH 里的普通命令不是文件路径", () => {
    expect(extractScriptPaths("gh pr view 780")).toEqual([]);
    expect(extractScriptPaths("bun test")).toEqual([]);
  });

  test("口径常量是 64KB（读取上限由 bash 侧执行）", () => {
    expect(MAX_SCRIPT_BODY_BYTES).toBe(64 * 1024);
  });

  test("路径名自带 PR 号也会被自然语言规则命中（但它不能当脚本展开生效的证据）", () => {
    // 真实脚本就叫 `wait-pr757.sh`：`pr757` 里 `PR` 后没有分隔符，`\bPR\s*#?\s*(\d+)` 照样命中。
    // 记在这里是因为它是个**测试陷阱**：集成用例若用这个名字，即使把脚本展开整段删掉
    // 也能抽出 gh:pr:757，用例会假通过（2026-11-12 变异自证时实测踩到）。
    // 所以 bash-wait-until.test.ts 的临时脚本名一律叫 `wait.sh`。
    expect(collectWaitSubjects({ command: "bash /tmp/wait-pr757.sh" })).toEqual(["gh:pr:757"]);
  });
});

describe("R2 命令归一化", () => {
  test("去掉 cd / chmod 前缀，合并空白", () => {
    expect(normalizeWaitCommand("cd /tmp && bash wait.sh")).toBe("bash wait.sh");
    expect(normalizeWaitCommand("cd /a && cd /b && bash x.sh")).toBe("bash x.sh");
    expect(normalizeWaitCommand("chmod +x /tmp/wait.sh && bash /tmp/wait.sh")).toBe(
      "bash /tmp/wait.sh",
    );
    expect(normalizeWaitCommand("  gh   pr   checks  779 ")).toBe("gh pr checks 779");
  });

  test("不改写参数顺序与语义（判不出就让它走 replace）", () => {
    expect(normalizeWaitCommand("bash a.sh --flag x")).toBe("bash a.sh --flag x");
    expect(normalizeWaitCommand("bash a.sh --flag x")).not.toBe(
      normalizeWaitCommand("bash a.sh --flag y"),
    );
  });
});

describe("R2 脚本正文哈希", () => {
  test("同内容稳定、不同内容可区分、无脚本为 undefined", () => {
    expect(hashScriptBodies([])).toBeUndefined();
    const a = hashScriptBodies(["pr=779\ngh pr checks 779\n"]);
    expect(a).toBe(hashScriptBodies(["pr=779\ngh pr checks 779\n"]));
    expect(a).not.toBe(hashScriptBodies(["pr=779\ngh pr checks 779 --watch\n"]));
  });
});

describe("B1 — 脚本正文按各自 cd 前缀解析基准目录", () => {
  /**
   * 缺陷形态（20261117）：真实等待命令是 `cd <worktree> && bash w.sh`，而
   * `readWaitScriptBodies` 用**进程启动目录**去解析 `w.sh`。读不到只是退化，
   * **读到启动目录下的同名脚本才是真缺陷** —— 抽出的 subjects 指向另一个对象，
   * R2 会把两个不相干的等待判成重复。
   *
   * 所以这里的夹具刻意在启动目录也放一份同名 `wait.sh`（正文指向 PR 111），
   * 修复前读到的就是它。只测「cd 目录下存在、启动目录下不存在」的话，
   * 修复前后都是「读不到」，用例恒绿，测不出任何东西。
   */
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wait-subjects-b1-")));
  const startDir = join(root, "start");
  const repoDir = join(root, "repo");
  const nestedDir = join(repoDir, "sub");
  mkdirSync(startDir, { recursive: true });
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(startDir, "wait.sh"), "gh pr checks 111\n");
  writeFileSync(join(repoDir, "wait.sh"), "gh pr checks 222\n");
  writeFileSync(join(nestedDir, "wait.sh"), "gh pr checks 333\n");
  writeFileSync(join(startDir, "a.sh"), "gh pr checks 444\n");
  writeFileSync(join(repoDir, "b.sh"), "gh pr checks 555\n");

  test("cd <绝对路径> && bash wait.sh → 读 cd 后的目录，不是启动目录", () => {
    const bodies = readWaitScriptBodies(`cd ${repoDir} && bash wait.sh`, startDir);
    expect(bodies).toEqual(["gh pr checks 222\n"]);
    // 直接锁住缺陷后果：抽到的对象必须是 222，绝不能是启动目录里的 111。
    expect(
      collectWaitSubjects({ command: `cd ${repoDir} && bash wait.sh`, scriptBodies: bodies }),
    ).toEqual(["gh:pr:222"]);
  });

  test("cd <相对路径> → 相对启动目录解析", () => {
    expect(readWaitScriptBodies("cd ../repo && bash wait.sh", startDir)).toEqual([
      "gh pr checks 222\n",
    ]);
  });

  test("多级 cd 链 → 逐段累积（cd a && cd b 的真实语义是 a/b）", () => {
    const bodies = readWaitScriptBodies(`cd ${repoDir} && cd sub && bash wait.sh`, startDir);
    expect(bodies).toEqual(["gh pr checks 333\n"]);
  });

  test("无 cd 前缀 → 既有行为不变（相对启动目录）", () => {
    expect(readWaitScriptBodies("bash wait.sh", startDir)).toEqual(["gh pr checks 111\n"]);
  });

  test("同一命令里两段脚本各有自己的基准目录", () => {
    // 只看「命令开头的 cd」会把 b.sh 也按 startDir 解析（b.sh 只在 repoDir 下）。
    // 逐段跟踪才对。
    const bodies = readWaitScriptBodies(`bash a.sh && cd ${repoDir} && bash b.sh`, startDir);
    expect(bodies).toEqual(["gh pr checks 444\n", "gh pr checks 555\n"]);
  });

  test("cd 目标是变量 / cd - → 解析不出目录，退回调用方给的 cwd（不猜）", () => {
    // 文档 §4.5 B-1 的口径：「解析不出目录时不猜，退回调用方给的 cwd」。
    // 这里刻意断言**退回**而不是「为空」：不猜的标准是「不臆造一个目录去读」，
    // 而不是把整个脚本展开关掉（关掉会让没有 cd 前缀的同类命令一起退化）。
    // 所以 `cd "$DIR" && bash wait.sh` 与 `bash wait.sh` 结果一致。
    expect(readWaitScriptBodies('cd "$DIR" && bash wait.sh', startDir)).toEqual([
      "gh pr checks 111\n",
    ]);
    expect(readWaitScriptBodies("cd - && bash wait.sh", startDir)).toEqual(["gh pr checks 111\n"]);
    // 前提是这两条确实没被当成 cd 目录去解析：若 `$DIR` 被当成字面目录，
    // 结果会是空（startDir/$DIR/wait.sh 不存在），那就成了「猜错」而不是「退回」。
    expect(readWaitScriptBodies('cd "$DIR" && bash wait.sh', startDir)).toEqual(
      readWaitScriptBodies("bash wait.sh", startDir),
    );
  });

  test("cd 到不存在的目录 → 为空（命令本来也不会执行到那一步）", () => {
    expect(readWaitScriptBodies("cd /nonexistent-b1-probe && bash wait.sh", startDir)).toEqual([]);
  });
});
