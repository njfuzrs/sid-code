---
Status: implemented
Date: 2026-11-07
---
# G2 用例 A8-fallback-ask：守住「ask 档在无头下 auto 兜底并把降级模型提升为主模型」

## 决定了什么

新增 `tests/smoke/cases/A8-fallback-ask`，与 `A8-fallback-auto` 配对，覆盖台账 A8 的 ask 档（生产默认档）。构造方式与 auto 档相同：主模型连接被拒端口，降级模型走 replay，重试压到 1 次。区别有两处：`fallbackSwitchMode: "ask"`；夹具是多轮。

判据取自触发清单 A8「讲的时候留余地 (b)」的对照会话 `20261105-202417-64949629`。ask 档在 `-p` 下没有交互通道，走 `autoFallback` → `promoteToPrimary`，所以：

- `ModelSwitch` 恰好 1 条，`reason="smoke-primary 降级"`，`trigger=fallback`；
- 只有第 1 轮的 `BeforeModel.model` 是主模型，后续各轮都是降级模型。

## 放弃了什么（以及为什么不选）

- **断言 read 的次数**：不选。2026-11-07 实测 read 了 3 次，夹具里只有 2 次。原因是第 1 轮降级用的是 `buildFallbackProvider` 新建的 ReplayProvider，提升后主循环从 registry 拿到的是另一个实例，两个实例都从夹具第 1 行开始回放。这是回放器的实例语义，不是降级链的行为，断言它等于锁死一个实现细节。
- **断言 `BilledRequest.model`**：不选，原因同 auto 档。这条路径上没有 BilledRequest（见 A8-fallback-auto 的注释）。

## 拿什么证明它生效了

- `make build && bun run smoke -- A8-fallback-ask A8-fallback-auto`：两条都通过。
- `bun run smoke:mutate -- A8-fallback-ask`：1/1 killed。把 `app.ts` 里的 `promoteToPrimary(def);` 改成 `void def;`（只换当次调用、不提升主模型）后，带 reason 的 `ModelSwitch` 期望 1 条、实际 0 条。
- 第一版断言写的是 read 恰好 2 次，实跑红了（3 次）。翻轨迹确认 `BeforeModel` 序列是 primary → fallback ×3，降级链行为正确，所以改的是断言口径，不是代码。
