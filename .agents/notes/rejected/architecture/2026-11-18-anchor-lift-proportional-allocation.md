---
Status: rejected
Date: 2026-11-18
Source: /context 面板取数不准与信息缺失 — 修复与验收方案（2026-11-17）R1
---
# 不把锚点抬升按比例摊进各分类

## 决定了什么

`/context` 面板的「已用」总量由三部分组成：
`total = max(0, grossTokens + anchorLiftTokens − freed.tokens)`。
其中 `anchorLiftTokens`（实测下界高于校准估算的部分）**单列一行**「实测校正 +N」，
**不**按各分类的占比摊回去。

## 放弃了什么（以及为什么不选）

**放弃的方案**：把 `anchorLiftTokens` 摊进各分类（`c_i += lift × raw_i / rawTotal`），
这样面板上没有「实测校正」这一行，看起来更干净，且「Σ 分类 === total」也能成立。

**否决理由**：差额来自哪一类块被低估，我们**并不知道**。按比例摊派等于**伪造归因**——
用户会看到「工具结果」凭空涨了一截，然后去做错误的清理（比如误以为工具输出真的那么大，
去清理本来没问题的历史）。这与本项目「每个指标必须能指到源字段」的口径直接冲突。

单列一行虽然多占一行屏幕，但让账目可核对：用户能看到「估算 88,900 + 实测校正 3,612
− 本地释放 100 = 92,412」，每一笔都有来源，而不是一个混算后的总数。

## 拿什么证明它生效了

- `packages/core/tests/context/breakdown-same-source.test.ts` 的状态 3 专门造出
  `anchorLiftTokens > 0`（连续两次 `recordActualTokens`，比值 1.15 → 1.5，EMA 后 1.255），
  并断言 `total === max(0, grossTokens + anchorLiftTokens − freed.tokens)` 严格相等。
- 变异自证：把 `total` 改回 `Σ categories`，状态 3 立刻红：
  `Expected: 5036, Received: 4214`，差值 822 正好等于该状态的 `anchorLiftTokens`。
