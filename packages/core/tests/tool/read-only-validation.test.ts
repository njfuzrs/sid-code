/**
 * 主白名单的断言矩阵（D5）。
 *
 * `read-only-validation.ts` 的 `READ_ONLY_COMMANDS`（54 条）是**安全边界**：
 * 判只读 = 免确认执行。但它此前没有任何直接的断言矩阵——只有分散在
 * 19 个场景测试里的覆盖（git 边界、管道顺序、命令替换位置……）。
 * 后果是：主表加一条命令，没人告诉你哪些写法仍会放行；删一条，也没人告诉你
 * 影响了哪些场景。
 *
 * 三条约定：
 *
 * 1. **期望值来自人工语义判断，不从 `isReadOnlyCommand` 反推。**
 *    判据是「这条命令按 POSIX / 该程序手册的语义会不会产生持久副作用」，
 *    不是「当前实现返回什么」。否则测试只是把实现抄一遍，改坏也绿。
 * 2. **覆盖完整性由源码解析保证**：手写的 `MATRIX` 必须覆盖 `READ_ONLY_COMMANDS`
 *    的每一条，主表新增命令而不更新本表 → 红。
 * 3. **已知缺口用 `test.failing` 钉桩**，断言写的是正确语义。
 *    当前实现不满足 → 标记通过；修好之后该用例会失败，提醒把 `.failing` 去掉。
 *    这样既不让缺口固化成「正确行为」，也不会让测试长期红着被无视。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReadOnlyCommand } from "@sid-code/core/tool/bash/read-only-validation.ts";

/**
 * 主表每条命令的「安全形态」。
 *
 * `null` = 该命令没有任何只读形态（`tee` 恒写文件，由 CONDITIONAL_COMMANDS 判死）。
 * 副作用的形态不写在这里，见下方 `WRITE_FORMS` 与通用重定向组。
 */
const SAFE_FORMS: Record<string, string | null> = {
  // 文件查看
  ls: "ls -la",
  cat: "cat f",
  head: "head -n 5 f",
  tail: "tail -n 5 f",
  wc: "wc -l f",
  file: "file f",
  stat: "stat f",
  du: "du -sh .",
  df: "df -h",
  locate: "locate foo",
  which: "which bun",
  whereis: "whereis ls",
  type: "type ls",
  readlink: "readlink -f f",
  // 搜索
  grep: "grep -n foo f",
  rg: "rg foo",
  ag: "ag foo",
  ack: "ack foo",
  fgrep: "fgrep foo f",
  egrep: "egrep foo f",
  // Git 只读（子命令由 isReadOnlyGit 细化）
  git: "git status",
  // 包管理器（子命令由 CONDITIONAL_COMMANDS 细化）
  npm: "npm view x",
  bun: "bun pm ls",
  // 系统信息
  echo: "echo hi",
  printf: "printf '%s\\n' hi",
  date: "date",
  whoami: "whoami",
  hostname: "hostname",
  uname: "uname -a",
  pwd: "pwd",
  env: "env",
  printenv: "printenv",
  id: "id",
  uptime: "uptime",
  free: "free -m",
  top: "top -b -n 1",
  // 数据处理
  jq: "jq '.a' f",
  yq: "yq '.a' f",
  cut: "cut -d, -f1 f",
  tr: "tr a b",
  sed: "sed -n '1p' f",
  diff: "diff a b",
  comm: "comm a b",
  paste: "paste a b",
  column: "column -t f",
  tee: null,
  // 目录
  tree: "tree",
  basename: "basename /a/b",
  dirname: "dirname /a/b",
  realpath: "realpath f",
  // 网络查询
  ping: "ping -c 1 127.0.0.1",
  dig: "dig example.com",
  nslookup: "nslookup example.com",
  host: "host example.com",
};

/** 命令**专属**的写形态（通用 `> out` 覆盖不到的，见下面的重定向组） */
const WRITE_FORMS: Array<[string, string]> = [
  ["sed", "sed -i s/a/b/ f"],
  ["tee", "tee f"],
  ["git", "git stash"],
  ["npm", "npm install"],
  ["bun", "bun install"],
  ["sort（非主表，条件命令）", "sort -o out a"],
  ["uniq（非主表，条件命令）", "uniq a out"],
  ["find（非主表，条件命令）", "find . -delete"],
  ["awk（非主表，条件命令）", `awk 'BEGIN{system("id")}'`],
  ["curl（非主表，条件命令）", "curl https://example.com"],
  ["wget（非主表，条件命令）", "wget https://example.com"],
];

/**
 * 已知缺口：主表里有写文件能力、但实现判只读的命令。
 *
 * 与 `sed -i` / `sort -o` 完全同型（主表命令 + 写文件参数），只是漏了精细化判定。
 * `yq -i` 与 `tree -o` 普通用户即可写任意文件，是其中影响最大的两条。
 * 修法：把它们移进 `CONDITIONAL_COMMANDS` 按参数判，或直接从主表移出。
 */
const KNOWN_GAPS: Array<[string, string]> = [
  ["yq -i 原地写", "yq -i '.a=1' f"],
  ["tree -o 写文件", "tree -o out.txt"],
  ["file -C -m 写 .mgc", "file -C -m x"],
  ["date -s 改系统时间", "date -s '2020-01-01'"],
  ["hostname 改主机名", "hostname evil"],
];

/** 从源码里解析主表条目，用于断言 `SAFE_FORMS` 的覆盖完整性 */
function parseMainWhitelist(): string[] {
  const srcPath = join(import.meta.dir, "../../src/tool/bash/read-only-validation.ts");
  const src = readFileSync(srcPath, "utf8");
  const block = src.match(/const READ_ONLY_COMMANDS = new Set\(\[([\s\S]*?)\n\]\);/);
  if (!block?.[1]) throw new Error("未在源码中匹配到 READ_ONLY_COMMANDS，正则需跟着源码格式更新");
  return block[1]
    .split("\n")
    .map((line) => line.trim().match(/^"([a-z0-9_.-]+)",?\s*(?:\/\/.*)?$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1]!);
}

describe("D5 覆盖完整性：手写矩阵必须覆盖主表每一条", () => {
  test("SAFE_FORMS 与 READ_ONLY_COMMANDS 一一对应", () => {
    const fromSource = parseMainWhitelist();
    const fromMatrix = Object.keys(SAFE_FORMS);

    // 主表加了命令但没更新矩阵 → 这里红，提示补一条安全形态 + 写形态
    const missing = fromSource.filter((c) => !fromMatrix.includes(c));
    expect(missing).toEqual([]);

    // 矩阵里有主表没有的命令 → 说明命令被删了，或矩阵写错了名字
    const extra = fromMatrix.filter((c) => !fromSource.includes(c));
    expect(extra).toEqual([]);

    expect(fromSource.length).toBe(54);
  });
});

describe("D5 矩阵一：主表每条命令的安全形态判只读", () => {
  for (const [cmd, form] of Object.entries(SAFE_FORMS)) {
    if (form === null) continue;
    test(`${cmd}：${form}`, () => {
      expect(isReadOnlyCommand(form)).toBe(true);
    });
  }

  test("tee 没有只读形态（恒写文件）", () => {
    expect(isReadOnlyCommand("tee")).toBe(false);
    expect(isReadOnlyCommand("tee f")).toBe(false);
  });
});

describe("D5 矩阵二：写重定向一律判非只读", () => {
  // 覆盖主表各分组，确保重定向提取对各类命令都生效（漏一类就是免确认写文件）
  for (const c of [
    "cat f > out",
    "head -n 5 f > out",
    "grep -n foo f > out",
    "rg foo > out",
    "jq '.a' f > out",
    "yq '.a' f > out",
    "cut -d, -f1 f > out",
    "sed -n '1p' f > out",
    "diff a b > out",
    "tree > out",
    "echo hi > out",
    "printf '%s' hi > out",
    "env > out",
    "top -b -n 1 > out",
    "ping -c 1 x > out",
    "ls -la >> out",
  ]) {
    test(c, () => {
      expect(isReadOnlyCommand(c)).toBe(false);
    });
  }
});

describe("D5 矩阵三：命令专属写形态判非只读", () => {
  for (const [label, c] of WRITE_FORMS) {
    test(`${label}：${c}`, () => {
      expect(isReadOnlyCommand(c)).toBe(false);
    });
  }
});

describe("D5 矩阵四：边界形态", () => {
  test("丢弃型重定向目标判只读", () => {
    // 与 parser.ts 的 DISCARD_TARGETS 同口径：写进去不产生持久副作用
    expect(isReadOnlyCommand("echo hi > /dev/null")).toBe(true);
    expect(isReadOnlyCommand("echo hi > /dev/zero")).toBe(true);
    expect(isReadOnlyCommand("echo hi 2>/dev/null")).toBe(true);
    expect(isReadOnlyCommand("cat f 2>/dev/null")).toBe(true);
  });

  test("形似 /dev/null 的真实文件判非只读", () => {
    // 精确相等而非前缀匹配：/dev/nullo 是一个真实文件
    expect(isReadOnlyCommand("echo hi > /dev/nullo")).toBe(false);
    expect(isReadOnlyCommand("echo hi > /tmp/x")).toBe(false);
    expect(isReadOnlyCommand("echo hi > /dev/shm/x")).toBe(false);
  });

  test("命令替换 / 进程替换判非只读", () => {
    // 解析器不展开它们，逐命令校验看不见里面的命令 → 只能整串拒绝
    expect(isReadOnlyCommand("echo $(date)")).toBe(false);
    expect(isReadOnlyCommand("echo `date`")).toBe(false);
    expect(isReadOnlyCommand("cat <(echo x)")).toBe(false);
  });

  test("列表分隔符与管道", () => {
    expect(isReadOnlyCommand("ls; rm x")).toBe(false);
    expect(isReadOnlyCommand("ls && rm x")).toBe(false);
    expect(isReadOnlyCommand("ls || rm x")).toBe(false);
    expect(isReadOnlyCommand("ls | rm x")).toBe(false);
    expect(isReadOnlyCommand("cat f | tee g")).toBe(false);
  });

  test("全只读的复合命令仍判只读", () => {
    expect(isReadOnlyCommand("cat f | grep x")).toBe(true);
    expect(isReadOnlyCommand("ls && pwd")).toBe(true);
    expect(isReadOnlyCommand("git status; git log")).toBe(true);
  });
});

describe("D5 已知缺口：主表内可写盘但判只读（修好后这些用例会红，届时去掉 .failing）", () => {
  for (const [label, c] of KNOWN_GAPS) {
    test.failing(`${label}：${c}`, () => {
      expect(isReadOnlyCommand(c)).toBe(false);
    });
  }
});
