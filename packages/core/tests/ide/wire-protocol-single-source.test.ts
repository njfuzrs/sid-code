/**
 * 门禁：IDE wire 协议字符串只允许有一个事实源（protocol.ts）
 *
 * 这道门禁防的是 **D2 + D4 那个组合**，而不只是那两行代码：
 *   - D2：实现里把 IDE 私有通知写成了 `notifications/selection_changed`
 *     （顺手补了 MCP 标准前缀）→ 订阅永久匹配不上，且**完全静默**。
 *   - D4：测试用**同一个错误字符串**触发通知 → 测试与实现互相自证，
 *     测试对这个 bug 完全免疫，还把它焊死（只改实现会让 11 处测试变红，
 *     而"改了代码测试就红了"是一个极强的"快回退"信号）。
 *
 * 所以判据不是"字符串对不对"（那只能拦住已知的这一次），而是
 * **"wire 字符串有没有第二个来源"** —— 只要实现与测试 import 同一个常量，
 * 下次拼错就是编译错误而不是静默失配。
 *
 * ⚠️ 这道门禁**读代码、不读注释**（本仓 `gate-assertions-must-read-code-not-comments`
 * 记的就是"我写的注释骗过了我写的门禁"这件事）：protocol.ts 与 selection.ts 的注释里
 * 刻意保留了错误形态作为教训记录，扫描必须先剥掉注释行，否则门禁会红在文档上。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { IDE_NOTIFY, AGENT_NOTIFY, DIFF_STATUS } from "@sid-code/core/ide/protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const IDE_SRC = join(REPO, "packages/core/src/ide");
const IDE_TESTS = join(REPO, "packages/core/tests/ide");

/** 剥掉行注释与块注释，只留真正会被执行的代码 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/^\s*\/\/.*$/gm, ""); // 整行行注释
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

describe("IDE wire 协议单一事实源", () => {
  test("常量值本身不带 notifications/ 前缀（D2 的正确形态）", () => {
    // IDE 的这两个通知是扩展私有约定，**不是** MCP 标准通知，不该有标准前缀。
    // 依据：CC 扩展 useIdeSelection.ts 的 z.literal('selection_changed')
    // 与 useIdeAtMentioned.ts 的 NOTIFICATION_METHOD = 'at_mentioned'。
    expect(IDE_NOTIFY.selectionChanged).toBe("selection_changed");
    expect(IDE_NOTIFY.atMentioned).toBe("at_mentioned");
    for (const v of Object.values(IDE_NOTIFY)) {
      expect(v.startsWith("notifications/")).toBe(false);
    }
  });

  test("src/ 与 tests/ 里没有第二处 wire 字符串字面量（D4）", () => {
    const wireLiterals = [
      ...Object.values(IDE_NOTIFY),
      ...Object.values(AGENT_NOTIFY),
      ...Object.values(DIFF_STATUS),
      // IDE_RPC 的值是工具名，openDiff / closeAllDiffTabs 这类驼峰词
      // 在别处（函数名 showDiffInIDE、closeAllDiffTabs 自身）会自然出现，
      // 不适合做字面量扫描 —— 它们由类型系统而非本扫描保护。
    ];

    const offenders: string[] = [];

    for (const file of [...tsFiles(IDE_SRC), ...tsFiles(IDE_TESTS)]) {
      // protocol.ts 是唯一允许出现这些字面量的地方（它就是事实源）
      if (file.endsWith("/protocol.ts")) continue;
      // 本门禁自己要写出这些字符串来做断言
      if (file.endsWith("/wire-protocol-single-source.test.ts")) continue;

      const code = stripComments(readFileSync(file, "utf-8"));
      for (const lit of wireLiterals) {
        // 只匹配带引号的字面量，避免命中 `IDE_NOTIFY.selectionChanged` 这类引用
        for (const quoted of [`"${lit}"`, `'${lit}'`, `\`${lit}\``]) {
          if (code.includes(quoted)) {
            offenders.push(`${file.replace(REPO + "/", "")} 里出现字面量 ${quoted}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("selection.ts / mention.ts 确实 import 了共享常量（而不是各写一份）", () => {
    for (const f of ["selection.ts", "mention.ts"]) {
      const code = stripComments(readFileSync(join(IDE_SRC, f), "utf-8"));
      expect(code).toContain('from "./protocol.ts"');
      expect(code).toContain("IDE_NOTIFY.");
    }
  });

  test("diff.ts 用的是 CC 扩展的 snake_case 参数名（D3）", () => {
    const code = stripComments(readFileSync(join(IDE_SRC, "diff.ts"), "utf-8"));
    for (const p of ["old_file_path", "new_file_path", "new_file_contents", "tab_name"]) {
      expect(code).toContain(p);
    }
    // 旧的自造 camelCase 参数名不许再出现在**代码**里
    for (const stale of ["oldContent,", "newContent,\n      tabId"]) {
      expect(code.includes(stale)).toBe(false);
    }
  });
});
