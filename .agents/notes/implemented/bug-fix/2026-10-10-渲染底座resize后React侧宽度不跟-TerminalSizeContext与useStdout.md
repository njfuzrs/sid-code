---
Status: implemented
Date: 2026-10-10
---
# 渲染底座 resize 后把新尺寸推给 React：底座提供 TerminalSizeContext，端口 useStdout 订阅它

## 决定了什么

T8.1d 人工矩阵里维护者发现：渲染底座上拖窄窗口文字被截断，拖宽内容不跟。

根因有两处，必须一起修：

1. `render-port/next/hooks.ts` 的 `TerminalSizeContext` 是端口自己 `createContext(null)` 造的，**没有任何地方 Provide**。CLI 的 `TerminalContext` 读到 null，回落到 `stdout.columns`。
2. 渲染底座的 `useStdout` 直接导出上游 hook，返回的是裸 stdout。13 个 CLI 组件读 `useStdout().stdout.columns`（Composer / InputArea / MessageItemRenderer…），而 resize 时 React 侧没有任何值变化，**这些组件不重渲**。根 Box 用 `width={termWidth}` 定死，就永远停在启动宽度。

改法（值由底座在 render 时提供，resize 时换新对象并重渲最近一次的 node）：

- 新增 `packages/tui/src/components/TerminalSizeContext.ts`，`ink.tsx` 在 render 时包一层 Provider。
- `resized` 只记下新尺寸。重渲放进合并后的 `renderAfterResize`，且只在尺寸对象和上次提交的不同时才提交。
- `next/hooks.ts` 的 `useStdout` 改为响应式：用 Proxy 把 `columns/rows` 指向 Context。订阅了 Context，resize 时调用方就会重渲。

## 放弃了什么（以及为什么不选）

- **在 `resized` 里当场 `render(currentNode)`**：第一版就是这样写的，结果 `frame-vectors` 的 4 条、E8 / E9、M1、R14、S6 一起红了。同 tick 连续三次 resize 出了三帧 full reset，R7 的同 tick 合并被打破。`packages/tui` 的出帧调度（`resizeScheduler`）会合并同 tick 的 resize，所以重渲必须放进合并后的那一帧里做。
- **只修 Context、不改 `useStdout`**（或者反过来）：变异实测，两边任意还原一处，新测试都是 3/3 红。两处都是必要的。
- **把 13 个 CLI 组件改成读 `TerminalContext`**：会改动 CLI 侧大量文件，违背「端口面不变、底座去适配」的原则。冻结行为基线要求 `useStdout` 是响应式的，那就是要对齐的契约。

## 拿什么证明它生效了

- 新测试 `packages/cli/tests/render-port/terminal-size-resize.test.tsx`，3 条：Context 随 resize 更新；`useStdout().columns` 随 resize 更新并触发重渲；`width={columns}` 的根 Box 从 60 列拖到 20 列后，36 字符长行的尾段 `UVWXYZ` 完整出现（不修就被裁掉）。修复后 3/3。变异：还原 `next/hooks.ts` → 3 fail；还原 `ink.tsx` → 3 fail。
- `bun test ./packages/cli/tests/render-port/ ./packages/tui/tests/`：1406 pass / 0 fail（第一版写法下渲染底座有 9 fail，见上一段）。
- `bun run affected-tests:run`：3167 pass / 1 fail。失败的是 `render-cache.test.tsx` 的 P3，单跑 2 轮都绿，判为满载下的 flake。
- `make build` rc=0，没有 `will always be undefined` 警告。lint / format:check / lint:boundary / tui:similarity 都通过。
- ⚠️ 真实终端里还没复验。需要维护者用 `sc-dev` 在 iTerm2 里按 T8.1d 步骤 3 再拖一次窗口。
