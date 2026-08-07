#!/usr/bin/env bun
/**
 * B4 探针 · `bash` 写入目标提取的形态覆盖
 *
 * 直调生产函数 `bashWriteTargets`。表里分三类：
 *   - `fix`  ：本次要修的形态（改动前 `[]`，改动后必须提取到目标）
 *   - `keep` ：已支持，不得回归
 *   - `never`：**刻意不支持**（设计取舍，见方案 §2.4）。它们期望 `[]`，
 *              但这是断言不是遗漏 —— 未来有人「顺手」加 `rm` 支持时这里会红。
 *
 * 跑法：bun scripts/probe/jit-boundary-b4.ts
 */

import { bashWriteTargets } from "../../src/tool/jit-affected-paths.ts";

type Kind = "fix" | "keep" | "never";
const CASES: Array<[Kind, string, string[]]> = [
  // 已支持，不得回归
  ["keep", "cat > src/ui/Badge.tsx <<EOF", ["src/ui/Badge.tsx"]],
  ["keep", "sed -i '' 's/a/b/' src/ui/F.tsx", ["src/ui/F.tsx"]],
  ["keep", "echo hi | tee -a src/api/log.txt", ["src/api/log.txt"]],
  // 本次要修
  ["fix", "cp src/a.ts src/ui/b.ts", ["src/ui/b.ts"]],
  ["fix", "cp -r src/a src/ui/", ["src/ui/"]],
  ["fix", "cp a.ts b.ts src/ui/", ["src/ui/"]],
  ["fix", "mv src/a.ts src/ui/b.ts", ["src/ui/b.ts"]],
  ["fix", "touch src/ui/New.tsx", ["src/ui/New.tsx"]],
  ["fix", "mkdir -p src/ui/sub", ["src/ui/sub"]],
  ["fix", "install -m 644 a.conf src/etc/a.conf", ["src/etc/a.conf"]],
  // 过滤链必须继续生效（新增动词不得绕过 push 的过滤）
  ["never", "cp src/a.ts $DEST", []],
  ["never", "mv a /tmp/x", []],
  ["never", "cp src/*.ts src/ui/", ["src/ui/"]], // 源含通配、目标干净 → 仍提取
  // 刻意永久不支持
  ["never", "rm src/ui/Old.tsx", []],
  ["never", "python src/ui/gen.py", []],
  ["never", "echo x > $OUT", []],
  ["never", "echo x > /dev/null", []],
];

let failed = 0;
let fixPending = 0;
const lines: string[] = [];
for (const [kind, cmd, expect] of CASES) {
  const got = bashWriteTargets(cmd);
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) {
    failed++;
    if (kind === "fix") fixPending++;
  }
  lines.push(
    `${ok ? "✔" : "✘"} [${kind.padEnd(5)}] ${JSON.stringify(got).padEnd(24)} ← ${cmd}`,
  );
}

const fixTotal = CASES.filter((c) => c[0] === "fix").length;
console.log("=== B4 · bash 写入目标提取 ===");
console.log(lines.join("\n"));
console.log(`\n未达期望：${failed} / ${CASES.length}   其中待修形态：${fixPending} / ${fixTotal}`);
process.exit(failed === 0 ? 0 : 1);
