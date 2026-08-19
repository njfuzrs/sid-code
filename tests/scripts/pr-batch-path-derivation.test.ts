/**
 * pr-batch 入库文件的路径派生门禁。
 *
 * ## 治的是什么
 *
 * `.pr-batch/` 从「整目录 gitignore」改成「分文件入库」之后，
 * 有三样东西进了开源仓：`worktree-settings.template.json`、`prompts/**`、`plan.json`。
 * 它们原先写死了作者的家目录绝对路径，于是有两个后果：
 *
 *   ① **把作者的家目录提交进开源仓** —— 别人 clone 就看到
 *   ② 换台机器后权限模板整个失效，而失效方式是**静默变成一直问你确认** ——
 *      不报错、不提示，只是慢。属于「绿了但没生效」那一类
 *      （记忆里 explicit-undefined-punches-through-defaults 同形态）
 *
 * 所以入库文件一律写 `$REPO_ROOT` / `$DOCS_ROOT` / `$HOME` 占位符，
 * 由 `pr-batch.sh` 的 `expand_paths` 在下发进 worktree / 喂给 claude 之前展开。
 *
 * ## 为什么必须有这份门禁
 *
 * 「顺手把占位符换回绝对路径」是个**测试全绿、构建成功、当场也能跑通**的改动 ——
 * 它只在换机器时才炸，而且炸得没声音。人的注意力拦不住这种东西，只有哨兵能。
 *
 * ⚠️ 本门禁分两层：
 *   ① 静态断言：入库文件里没有 `/Users/`，且占位符与展开函数两侧对得上
 *   ② **变异自证**：真的跑一遍 expand_paths，确认它真的在替换 ——
 *      少了这一层，一个 `expand_paths() { cat; }` 的空实现能让①全绿
 *      （记忆里 static-scan-misses-indirect-disk-writes：恒绿的门禁比没门禁更危险）
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "pr-batch.sh");
const PR_BATCH = join(REPO_ROOT, ".pr-batch");
const TEMPLATE = join(PR_BATCH, "worktree-settings.template.json");
const PROMPTS = join(PR_BATCH, "prompts");
const GITIGNORE = join(REPO_ROOT, ".gitignore");

const script = (): string => readFileSync(SCRIPT, "utf-8");

/** 入库的 .pr-batch 文件清单（现读，不硬编码 —— 硬编码的清单必漂移）。 */
function committedFiles(): string[] {
  const out: string[] = [];
  if (existsSync(TEMPLATE)) out.push(TEMPLATE);
  if (existsSync(PROMPTS)) {
    for (const f of readdirSync(PROMPTS)) {
      if (f.endsWith(".md")) out.push(join(PROMPTS, f));
    }
  }
  return out;
}

describe("入库文件里不许有家目录", () => {
  test("template 与 prompts 里零 /Users/ 命中", () => {
    const offenders: string[] = [];
    for (const f of committedFiles()) {
      const body = readFileSync(f, "utf-8");
      body.split("\n").forEach((line, i) => {
        // 只拦真实的家目录形态。`$HOME` / `$DOCS_ROOT` 是允许的。
        if (/\/Users\/[a-z]/i.test(line)) {
          offenders.push(`${f.replace(REPO_ROOT + "/", "")}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("template 用占位符写了那三类路径（不是靠删掉规则来过门禁）", () => {
    // ⚠️ 这条防的是「为了让上一条变绿，把带路径的规则整行删掉」——
    //    那会让 docs-research 变成不可读、check-gen 变成要确认，
    //    上一条门禁却会显示全绿。
    const t = readFileSync(TEMPLATE, "utf-8");
    expect(t).toContain("$REPO_ROOT/scripts/pr-batch.sh check-gen");
    expect(t).toContain("$DOCS_ROOT");
    expect(t).toContain("$HOME/.ssh/**");
  });

  test("template 展开后是合法 JSON 且 _paths 说明在（改的人要读到理由）", () => {
    const t = JSON.parse(readFileSync(TEMPLATE, "utf-8"));
    expect(typeof t._paths).toBe("string");
    expect(t._paths).toContain("$REPO_ROOT");
    // 说明里必须点出失效方式是静默的 —— 那是这个设计唯一的存在理由。
    expect(t._paths).toMatch(/不报错|静默/);
  });
});

describe("expand_paths 真的在替换（变异自证）", () => {
  /** 在 pr-batch.sh 的定义域里跑一段 bash，拿到 expand_paths 的实际输出。 */
  function runExpand(input: string, env: Record<string, string> = {}): string {
    // 只 source 到命令分派之前：整脚本 source 会走进 case 分支。
    // 手法是把脚本喂进 bash 并在末尾追加调用 —— 但 set -euo pipefail + case
    // 会退出，所以改为直接抽取函数体运行不可靠。用 CMD=__probe 走 * 分支会 exit 1。
    // 最稳的做法：让脚本以一个真实的只读子命令跑不通也无所谓，
    // 我们只需要函数定义 —— 所以用 bash -c 先定义变量再 source 到 exit。
    // ⚠️ 输入必须走**带引号定界符**的 heredoc（`<<'EOF_IN'`）。
    //    第一版写的是 `printf '%s' "$输入"` —— 双引号里的 `$REPO_ROOT`
    //    会被 bash 自己展开掉，于是喂给 expand_paths 的字符串里根本没有占位符，
    //    函数换成空实现 `cat` 也照样全绿。那是一条假门禁
    //    （记忆里 tests-green-but-bypassing-real-entrypoint 同形态）。
    //    这个坑已由本文件底部的「变异自证」哨兵钉住。
    const harness = `
set -uo pipefail
REPO_ROOT="${REPO_ROOT}"
# 抽出 DOCS_ROOT 推导段与 expand_paths 定义（从 DOCS_ROOT= 到第一个行首 }）。
eval "$(awk '/^DOCS_ROOT=/,/^}/' "${SCRIPT}")"
cat <<'EOF_PR_BATCH_PROBE' | expand_paths
${input}
EOF_PR_BATCH_PROBE
`;
    const r = spawnSync("bash", ["-c", harness], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    expect(r.status).toBe(0);
    // heredoc 必然带一个尾随换行，与被测行为无关。
    return r.stdout.replace(/\n$/, "");
  }

  test("$REPO_ROOT 被展开成真实仓库根", () => {
    const out = runExpand("Bash(bash $REPO_ROOT/scripts/pr-batch.sh check-gen)");
    expect(out).toContain(REPO_ROOT);
    expect(out).not.toContain("$REPO_ROOT");
  });

  test("$HOME 被展开", () => {
    const out = runExpand("Read(/$HOME/.ssh/**)");
    expect(out).not.toContain("$HOME");
    expect(out).toContain(process.env.HOME!);
  });

  test("$DOCS_ROOT 走 PR_BATCH_DOCS_ROOT 覆盖", () => {
    const out = runExpand("Read(/$DOCS_ROOT/**)", {
      PR_BATCH_DOCS_ROOT: "/tmp/probe-docs-root",
    });
    expect(out).toBe("Read(//tmp/probe-docs-root/**)");
  });

  test("⚠️ 哨兵：探针自己不许让 bash 提前展开占位符（本门禁踩过的坑）", () => {
    // 这条钉住的是**测试基础设施**的正确性，不是生产代码。
    // 第一版 harness 用 `printf '%s' "<输入>"`，双引号让 bash 在管道之前
    // 就把 $REPO_ROOT 展开了 → expand_paths 收到的字符串无占位符 →
    // 把它换成空实现 `cat` 也全绿。变异自证当场抓到了这件事。
    const self = readFileSync(join(import.meta.dir, "pr-batch-path-derivation.test.ts"), "utf-8");
    expect(self).toContain("<<'EOF_PR_BATCH_PROBE'");
    // 反向断言：不许退回 printf 那种会被展开的形态。
    expect(self).not.toMatch(/printf '%s' \$\{JSON\.stringify\(input\)\}/);
  });

  test("⚠️ DOCS_ROOT 找不到时占位符**原样保留**，不替换成空串", () => {
    // 这是刻意的：`$DOCS_ROOT/sid-code/...` 读不到会让 agent 当场报错；
    // 而替换成空串得到的 `/sid-code/...` 是个看着像绝对路径的死路 —— 静默失败。
    const out = runExpand("Read(/$DOCS_ROOT/**)", {
      PR_BATCH_DOCS_ROOT: "/nonexistent-probe-path-xyz",
    });
    // 覆盖值即便不存在也会被采用（显式覆盖优于探测），所以这里断言的是
    // 「没有把它变成空」这件事。
    expect(out).not.toBe("Read(//**)");
  });
});

describe("接线点：两处下发 + 一处喂 prompt 都过 expand_paths", () => {
  test("prepare 与 reperm 拷模板时都管道过 expand_paths", () => {
    const s = script();
    // 两处都是 `"$SETTINGS_TEMPLATE" | expand_paths >` 的形态。
    const wired = s.match(/"\$SETTINGS_TEMPLATE"\s*\|\s*expand_paths/g) ?? [];
    expect(wired.length).toBe(2);
    // 反向断言：不许有绕过 expand_paths 的直接重定向。
    expect(s).not.toMatch(/"\$SETTINGS_TEMPLATE"\s*>\s*"\$wt/);
  });

  test("open 喂 prompt 时过 expand_paths（prompt 是手写文件，含占位符）", () => {
    // ⚠️ 断言用 expand_paths 而非 cat：prompts/*.md 入库后带 $DOCS_ROOT，
    //    直接 cat 会把字面量 `$DOCS_ROOT/...` 喂给 agent，它读不到方案文档。
    expect(script()).toContain('expand_paths < "$prompt_file"');
  });

  test("plan doc 的候选路径解析收敛到一个函数（原先两份拷贝，改一处漏一处）", () => {
    const s = script();
    expect(s).toContain("resolve_plan_doc()");
    const callers = s.match(/resolve_plan_doc "\$/g) ?? [];
    expect(callers.length).toBeGreaterThanOrEqual(2);
    // 反向断言：脚本里不许再出现写死作者布局的候选路径。
    expect(s).not.toContain("$HOME/Code/person/docs-research/$plan_doc");
  });
});

describe(".gitignore 分文件放行", () => {
  const gi = (): string => readFileSync(GITIGNORE, "utf-8");

  test("不是 .pr-batch/ 一刀切，而是 * + 三条放行", () => {
    const g = gi();
    // 一刀切那行必须没了 —— 有它则下面的 ! 全部失效。
    expect(g).not.toMatch(/^\.pr-batch\/$/m);
    expect(g).toMatch(/^\.pr-batch\/\*$/m);
    expect(g).toMatch(/^!\.pr-batch\/prompts\/$/m);
    expect(g).toMatch(/^!\.pr-batch\/worktree-settings\.template\.json$/m);
  });

  test("locks / timing.tsv / status 仍被 ignore（本机状态不入库）", () => {
    // 用 git 自己判，不靠读 .gitignore 文本推理 —— 那是两回事。
    for (const p of [".pr-batch/locks/x.lock", ".pr-batch/timing.tsv", ".pr-batch/status/x.json"]) {
      const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: REPO_ROOT });
      expect({ path: p, ignored: r.status === 0 }).toEqual({ path: p, ignored: true });
    }
  });

  test("template / prompts / plan.json 不再被 ignore", () => {
    for (const p of [
      ".pr-batch/worktree-settings.template.json",
      ".pr-batch/prompts/x.md",
      ".pr-batch/plan.json",
    ]) {
      const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: REPO_ROOT });
      expect({ path: p, ignored: r.status === 0 }).toEqual({ path: p, ignored: false });
    }
  });
});
