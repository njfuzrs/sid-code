---
Status: rejected
Date: 2026-08-01
---
# 否决 hypothesis 机制默认开启（A/B 实测：准确率完全持平，input +75%）

## 决定了什么

hypothesis（假设登记 / 反驳 / 裁决）机制**默认关闭，不分模式**，需 `SID_ENABLE_HYPOTHESIS=1` 显式开启。

`isHypothesisEnabled()`（`hypothesis-ledger.ts`）从「默认开 + `SID_DISABLE_HYPOTHESIS=1` 关」
反转为「默认关 + `SID_ENABLE_HYPOTHESIS=1` 开」，与循环检测、裸符号省略规则同范式
（默认关、env 可逆、**代码不删**）。三处判据同步反转：`cli.ts` 工具注册、
`system-prompt.ts` 常驻引导、`loop.ts` turn-1 引导。

**代码不删**是这条决定的一部分：机制本体在受控 fixture 上确实迫使模型翻案过（见下），
被否决的是"默认开启"这个默认值，不是这个能力。

## 放弃了什么（以及为什么不选）

放弃默认开启。依据是受控 A/B（fixture `/tmp/hyp-ab4`：PLAN.md 声称 5 项全实现，
真值 E1/E4 已落地、E2 死代码、E3 从不累加、E5 条件恒 false），gpt-5.6-luna，ON/OFF 各 4 次：

| | 准确率 | 轮数 | input | output | 耗时 |
| --- | --- | --- | --- | --- | --- |
| ON | **5.00/5** | 23.2 | 792,959 | 11,757 | 162s |
| OFF | **5.00/5** | 15.2 | 451,892 | 8,316 | 100s |
| 差 | **0** | +52% | **+75%** | +41% | **+61%** |

ON 臂机制全程活跃（register / challenge / settled 各 6.0 次，交付门禁每次都触发，
纯假设轮 10.0/23.2）。**机制全程在跑，但一道题都没多做对。**

同期成本审计（真实会话 68 轮 / $3.0994）给出同向结论：纯假设轮占 input token 31.4%、
API 耗时 31.1%，26 次 challenge 里 **11 次（42%）是绕一圈回到同一结论**的空转。

也放弃了"先调参再看"这条路 —— 空转的根因是代码级的结清语义缺陷（`confirm` 分支从不清零
`challengedAfterConfirm` → 交付门禁永久武装 → 末尾 4 轮零新增结论的"鬼打墙"），
已单独修掉；但修完之后收益仍不足以支撑默认开启。

## 拿什么证明它生效了

- 早期三组 fixture（`hyp-ab` / `hyp-ab2` / `hyp-ab3`）**全部作废**：ON 臂 11/11 次运行的
  `hypothesis_register` 都收到「权限拒绝: 非交互模式」，ledger 恒空 —— 那三组的 ON 臂根本不是 ON。
  **教训：A/B 必须先验证处理组真的被处理了**（查工具回执，不是只查工具被调用）。
  这是本次最贵的一条经验，第四组才是有效样本。
- 二进制端到端验证：默认不设 env 时模型答「未找到可用的 hypothesis_register 工具」；
  设 `SID_ENABLE_HYPOTHESIS=1` 后正常登记 + 裁决。
- `--dump-tools` 工具数 46 → 44（两个 hypothesis 工具默认不再出现在 `website/ref/tools.md`），
  已重新生成参考页并通过 `--check`。
- 顺带查出一个真 bug 并修掉：`permission/checker.ts` 的 `READ_ONLY_TOOLS` 是**硬编码字符串集**，
  从不读 `Tool.readOnly()` —— 于是两个只读的 hypothesis 工具在无头 / 评测 / CI 全场景被静默拒绝，
  不报错、只在日志留一行。这类"权限层拦死"极易被误判成"模型不调工具"。
  已加入表中 + 6 个回归测试。同类风险仍在（`ask_user_question` / `lsp` / `tool_search` 等 10+ 个
  工具声明 `readOnly(): true` 但不在表里），根治应是让 Step 10 直接查 `Tool.readOnly()`。
