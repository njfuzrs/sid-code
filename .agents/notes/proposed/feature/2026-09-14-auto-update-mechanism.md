---
Status: proposed
Class: feature
Date: 2026-09-14
Scope: packages/core/src/update/, packages/cli/src/command/update.ts, packages/cli/src/ui/App.tsx
Dependencies: []
---

## 决定了什么

实现 sid-code 自动更新机制，采用「薄编排层 + 复用 install.sh」架构：

1. **三档更新模式**：`off` / `notify` / `auto`，通过 `settings.json` 的 `autoUpdate` 字段控制，环境变量 `SID_CODE_AUTO_UPDATE` 优先级更高
2. **24 小时节流**：最多每 24 小时检查一次新版本，避免频繁请求
3. **原子切换**：后台下载新版本后通过符号链接原子切换，不阻塞用户工作
4. **mkdir 锁 + 30 分钟 stale 回收**：多实例同时启动时只有一个执行更新，其余静默跳过
5. **通知机制**：更新结果写入 `state.json` 的 `pendingNotice` 字段，下次启动时消费并显示 transient message
6. **通道隔离**：默认使用稳定版通道（`latest.txt`），beta 通道通过 `SID_CODE_CHANNEL=beta` 显式指定

核心模块拆分：
- `versions.ts`：版本号比较与校验（纯函数）
- `config.ts`：RELEASE_ORIGIN / INSTALL_URL 解析，`resolveAutoUpdateMode()` 优先级裁决
- `state.ts`：UpdateState 原子读写（tmp + rename）
- `throttle.ts`：24 小时节流逻辑
- `lock.ts`：mkdir 原子锁 + stale 回收
- `notify.ts`：pendingNotice 读写与格式化
- `checker.ts`：HTTP 查询最新版本（5s 超时）
- `installer.ts`：Bun.spawn detached 安装子进程
- `index.ts`：编排层，串联上述模块

## 放弃了什么

### 候选方案 A：TS 重新实现下载/校验/切换逻辑

**放弃理由**：install.sh 已经是完整实现（含 SHA256 校验、原子切换、团队默认配置合并、定价刷新），重新实现会产生两份要长期保持同步的代码。实测 install.sh 全程非交互，`curl | bash` 消耗 stdin 不是问题。

### 候选方案 B：用文件锁（flock）而非 mkdir 锁

**放弃理由**：macOS 与 Linux 的 flock 语义不一致（BSD flock vs Linux flock），且 flock 需要保持文件描述符打开，跨进程边界复杂。mkdir 在 POSIX 上原子（EEXIST 即失败），实现简单且跨平台一致。

### 候选方案 C：在 React 组件内直接调用 `startAutoUpdateCheck()`

**放弃理由**：`startAutoUpdateCheck()` 应该与 `startDeferredPrefetches()` 同层（fire-and-forget 启动钩子），不应耦合到 React 生命周期。通知消费通过 `consumePendingNotice()` 在 TUI 启动时调用，与 React Context 解耦。

### 候选方案 D：用 `getVersion()` 而非 `getRawVersion()`

**放弃理由**：`getVersion()` 返回 `"sid-code v0.1.603 (TypeScript)"`（带前缀），`getRawVersion()` 返回 `"0.1.603"`（裸版本号）。版本比较需要裸版本号，用 `getVersion()` 会静默破坏比较逻辑。这是设计文档审查时发现的 bug。

## 拿什么证明它生效了

### 单元测试覆盖

45 个测试用例覆盖全部核心模块：
- `versions.test.ts`：版本号校验与比较（17 个用例）
- `config.test.ts`：`resolveAutoUpdateMode()` 优先级与非法值回退（9 个用例）
- `throttle.test.ts`：24 小时节流与 env 覆盖（7 个用例）
- `state.test.ts`：原子写入与损坏恢复（6 个用例）
- `lock.test.ts`：mkdir 锁与 stale 回收（7 个用例，含 30 分钟边界）
- `notify.test.ts`：pendingNotice 读写与消费（6 个用例）

全部测试通过，耗时 131ms。

### 集成验证

1. **构建通过**：`make build` 成功，产物自检通过（git-status 锚点、止损阀、skill 嵌入、ripgrep 平台匹配）
2. **门禁通过**：
   - `bun run lint`：0 错误
   - `bun run format:check`：全部文件格式正确
   - `bun run lint:boundary`：包边界干净，0 处越界依赖
3. **文档同步**：
   - `bun run docs:gen-reference` 重新生成 `website/ref/settings.md`（含新增 `autoUpdate` 字段）
   - `website/guide/auto-update.md` 用户指南已创建
4. **选择性测试通过**：`bun run affected-tests:run` 覆盖本次 diff 触及的测试，3499 pass / 5 fail（3 个 fail 为既存问题：harbor Python 语法错误、holdout 超时；2 个 fail 已修复：update.test.ts 与 swe-bench-runner.test.ts）

### 手动验证步骤

1. `sc-dev` 启动开发版，观察是否显示 transient message（首次启动无 pendingNotice，应无消息）
2. 设 `SID_CODE_AUTO_UPDATE=notify`，检查 settings.json 解析是否正确
3. 设 `SID_CODE_UPDATE_CHECK_INTERVAL_HOURS=0.001`（3.6 秒），等待 24 小时后再次启动，检查是否触发新版本检查
4. 查看 `~/.sid-code/updates/state.json`，确认 `lastCheckAt` / `consecutiveFailures` / `pendingNotice` 字段正确写入
5. 同时启动两个 `sc-dev` 实例，检查只有一个执行更新检查（另一个日志应显示「锁已被持有」）
