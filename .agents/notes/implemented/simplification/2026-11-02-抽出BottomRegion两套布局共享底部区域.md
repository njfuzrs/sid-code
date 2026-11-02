---
Status: implemented
Date: 2026-11-02
---
# 抽出 BottomRegion，主屏与全屏两套布局共享底部区域

## 决定了什么

- 新增 `packages/cli/src/ui/components/BottomRegion.tsx`，承载两套布局原先各写一份的底部区域：
  Notifications、TodoPanel、ToastDisplay、RetryStatus、ErrorPanel、状态提示、DialogSwitch（Composer 与对话框二选一）、
  ExitWarning、Footer，以及包住它们的 `gap={1}` 留白区。
- `MainScreenLayout`（默认主屏）与 `DefaultAppLayout`（opt-in 全屏）只保留消息区；两边的差异走两个插槽，
  BottomRegion 内部不判断「我是哪种布局」：
  - `leading`：主屏放欢迎屏 + 流式思考/正文，全屏放 Copy Mode 警告；
  - `beforeStatus`：全屏放「已暂停跟随输出」提示。
  插槽传 Fragment，子节点展开成留白区的直接子节点，gap 行为与重构前一致。
- 共享 props 收成 `BottomRegionSharedProps`，两个布局的 props 接口都 `extends` 它，以后加字段只改一处。
- 顺手改正两处与 `config.ts` 默认值（`alternateBuffer: false`）矛盾的过期文案：`App.tsx` staticItems 注释
  （原写「默认走 alt-screen」「inline 是逃生舱」）、`app.ts` 启动日志（原写「主屏 Static 内联（--inline）」）。

## 放弃了什么（以及为什么不选）

- **删掉其中一种渲染模式**：主屏是默认、全屏是 `--alternate-buffer` / `/tui on` 的 opt-in，两边都有用户，删哪个都是行为变更。
- **合并成一个大布局组件、内部 if 分支**：虚拟列表 + 有界视口与 Static 追加写入是两种渲染模型，合并后更难读。
- **把布局签名彻底改成 `scrollable` / `bottom` 插槽（CC 模式）**：方案里标为可选。这次只把底部收口，
  App.tsx 调用点不动，改动面最小；需要时再做。
- **拿 term-bench 当验收**：`component-scenarios.tsx` 渲染的是手写骨架，不 import 这两个真实布局，改坏了照样绿。

## 拿什么证明它生效了

- 先在现状上补了真实布局整帧快照 `packages/cli/tests/ui/components/layout-bottom-region-snapshot.test.tsx`
  （主屏 / 全屏 × 「瞬态块齐全」/「对话框打开」共 4 帧；场景含启动警告、Todo、Toast、降级重试、错误面板、状态提示、
  Ctrl+C 退出警告、命令输出面板），单独提交在重构之前。
- 重构后 4 帧逐字节一致；再把两个布局文件临时换回重构前版本对拍新快照，同样 4 pass。
- 变异自证：在 BottomRegion 里调换 TodoPanel 与 Notifications 顺序 → 两个布局的「瞬态块齐全」都变红（2 fail），恢复后 4 pass。
- 门禁：`format:check` / `lint` / `lint:boundary` / `lint:command-system` 通过，`typecheck:gate` 66/66 无新增，`make build` 自检通过，
  构建输出无 `will always be undefined`。
- `affected-tests:run` 2716 pass / 1 fail：失败的是 `large-data-startup-gate`「首帧差值 < 150ms」（实测 209ms），
  该测试 spawn 独立进程测启动耗时，不 import 本次改动的组件；worktree 内单跑与父仓 main 单跑均 7 pass，
  成因是全量选测期间机器负载抬高启动耗时。
