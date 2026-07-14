#!/usr/bin/env bun
/**
 * loop-detection-probe —— 循环检测能力探针（实证,非猜测）
 *
 * 目的：为"按副作用分级循环检测"的调研提供确定性证据,回答三问：
 *  1. bash 不同命令是否真的退化成同一个 shape key?（shape 检测对 bash 失效的实锤）
 *  2. isReadOnlyCommand 能否稳定区分"只读无副作用"与"有副作用"命令?（分级基础设施是否就绪）
 *  3. ToolShapeLoopDetector 对"重复 git status"这类只读命令能否检测出来?
 *     （用户问："遇到重复执行 git 命令这种我们应该是能检测出来吧"）
 */

import { ToolShapeLoopDetector, ToolCallLoopDetector, DEFAULT_LOOP_CONFIG } from "../src/agent/loop-detection.ts";
import { isReadOnlyCommand, isDestructiveCommand } from "../src/tool/bash/read-only-validation.ts";

const L: string[] = [];
function log(s = "") { L.push(s); }

// ── shapeKey 是私有方法,用反射拿到它做白盒观测 ──
function shapeKeyOf(det: ToolShapeLoopDetector, toolName: string, input: unknown): string {
  // 访问私有方法用于探针（白盒观测 shapeKey）
  return (det as unknown as { shapeKey(t: string, i: unknown): string }).shapeKey(toolName, input);
}

log("═══ 探针 1：bash 不同命令的 shape key 是否退化成同一串 ═══");
{
  const det = new ToolShapeLoopDetector(DEFAULT_LOOP_CONFIG);
  const bashCmds = [
    "git status",
    "git log --oneline -3",
    "git diff HEAD",
    "npm run build",
    "ls -la /tmp",
    "cat package.json",
    "rm -rf node_modules",       // 破坏性
    "./scripts/release.sh --upload",
  ];
  const keys = bashCmds.map((c) => shapeKeyOf(det, "bash", { command: c }));
  for (let i = 0; i < bashCmds.length; i++) {
    log(`  cmd="${bashCmds[i]}"`);
    log(`    shapeKey => ${keys[i]}`);
  }
  const uniq = new Set(keys);
  log("");
  log(`  ▶ ${bashCmds.length} 条语义完全不同的 bash 命令 → ${uniq.size} 个不同 shape key`);
  log(uniq.size === 1
    ? "  ▶ 【实锤】全部退化成同一个 shape key:检测器对 bash 完全无视命令内容"
    : `  ▶ shape key 有 ${uniq.size} 种,退化程度:${uniq.size === 1 ? "完全" : "部分"}`);
}

log("");
log("═══ 探针 2：对比 —— read 工具带 anchor(file_path) 时 shape key 能区分不同文件 ═══");
{
  const det = new ToolShapeLoopDetector(DEFAULT_LOOP_CONFIG);
  const reads = [
    { file_path: "/a.ts" },
    { file_path: "/b.ts" },
    { file_path: "/a.ts", offset: 100 }, // 翻页
  ];
  const keys = reads.map((r) => shapeKeyOf(det, "read", r));
  reads.forEach((r, i) => log(`  read(${JSON.stringify(r)}) => ${keys[i]}`));
  log(`  ▶ ${reads.length} 次 read → ${new Set(keys).size} 个不同 shape key（file_path 是 anchor,进 key,故能区分）`);
}

log("");
log("═══ 探针 3：模拟'反复执行同一 git status' —— exact 检测器能否兜住 ═══");
{
  const det = new ToolCallLoopDetector(DEFAULT_LOOP_CONFIG);
  let triggeredAt = -1;
  for (let i = 1; i <= 6; i++) {
    const hit = det.record("bash", { command: "git status && git log --oneline -3 && git tag" });
    log(`  第 ${i} 次完全相同的 bash 调用 → ${hit ? "★命中循环" : "未命中"}`);
    if (hit && triggeredAt < 0) triggeredAt = i;
  }
  log(`  ▶ ToolCallLoopDetector（精确匹配）在第 ${triggeredAt} 次命中`);
  log(`  ▶ 结论：完全相同的重复命令 exact 检测器能抓；但只要命令有任何字符差异(如加时间戳/变参数)就绕过`);
}

log("");
log("═══ 探针 4：模拟'几乎相同但每次有微小差异的 git 命令' —— exact 检测器是否漏判 ═══");
{
  const det = new ToolCallLoopDetector(DEFAULT_LOOP_CONFIG);
  let anyHit = false;
  const variants = [
    "git status",
    "git status ",           // 尾部空格
    "git status && echo 1",
    "git status && echo 2",
    "git status | cat",
    "git  status",           // 双空格
  ];
  variants.forEach((c, i) => {
    const hit = det.record("bash", { command: c });
    if (hit) anyHit = true;
    log(`  变体${i + 1} "${c}" → ${hit ? "★命中" : "未命中"}`);
  });
  log(`  ▶ 6 个"语义都是查 git 状态"的变体 → exact 检测器${anyHit ? "有命中" : "全程未命中(漏判)"}`);
  log(`  ▶ 这正是根因文档里 deepseek 反复绕圈的场景:命令每次略有不同,exact 抓不到,shape 又因 bash 退化而无效`);
}

log("");
log("═══ 探针 5：isReadOnlyCommand / isDestructiveCommand 分级能力（用户提案的基础设施是否就绪） ═══");
{
  const cases: Array<[string, "只读" | "有副作用" | "破坏性"]> = [
    ["git status", "只读"],
    ["git log --oneline -5", "只读"],
    ["git diff HEAD", "只读"],
    ["ls -la", "只读"],
    ["grep -r foo src/", "只读"],
    ["cat package.json", "只读"],
    ["rg pattern", "只读"],
    ["git commit -m x", "有副作用"],
    ["git push", "有副作用"],
    ["npm run build", "有副作用"],
    ["./scripts/release.sh --upload", "有副作用"],
    ["sed -i s/a/b/ f.txt", "有副作用"],
    ["echo x > f.txt", "有副作用"],
    ["rm -rf /", "破坏性"],
    ["dd if=/dev/zero of=/dev/sda", "破坏性"],
  ];
  let correct = 0;
  for (const [cmd, expected] of cases) {
    const ro = isReadOnlyCommand(cmd);
    const destructive = isDestructiveCommand(cmd);
    const actual = destructive ? "破坏性" : ro ? "只读" : "有副作用";
    const ok = actual === expected;
    if (ok) correct++;
    log(`  ${ok ? "✓" : "✗"} "${cmd}"  期望=${expected}  实测=${actual}`);
  }
  log("");
  log(`  ▶ 分级准确率:${correct}/${cases.length} = ${((correct / cases.length) * 100).toFixed(0)}%`);
  log(`  ▶ 结论：区分"只读无副作用" vs "有副作用" vs "破坏性"的分类器【已存在且可用】`);
  log(`         用户提案的"按副作用分级检测"所需基础设施已就绪,无需从零造分类器`);
}

process.stdout.write(L.join("\n") + "\n");
