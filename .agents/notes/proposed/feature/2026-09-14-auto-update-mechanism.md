---
Status: proposed
Class: feature
Date: 2026-09-14
Scope: packages/core/src/update/, packages/cli/src/command/update.ts, packages/cli/src/ui/App.tsx
Dependencies: []
---

# 自动更新机制

## 决定了什么

实现 sid-code 自动更新机制，采用「薄编排层 + 复用 install.sh」架构：

1. **三档更新模式**：`off` / `notify` / `auto`，通过 `settings.json` 的 `autoUpdate` 字段控制，环境变量 `SID_CODE_AUTO_UPDATE` 优先级更高
2. **24 小时节流**：最多每 24 小时检查一次新版本，避免频繁请求
3. **原子切换**：后台下载新版本后通过符号链接原子切换，不阻塞用户工作
4. **mkdir 锁 + 30 分钟 stale 回收**：多实例同时启动时只有一个执行更新，其余静默跳过
5. **通知机制**：更新结果写入 `state.json` 的 `pendingNotice` 字段，下次启动时消费并显示 transient message
6. **通道隔离**：默认使用稳定版通道（`latest.txt`），beta 通道通过 `SID_CODE_CHANNEL=beta` 显式指定
7. **手动指定版本**：实现 `sid-code update --version x.y.z`，严格限制为稳定三段版本；拒绝 `--list`，因为发布服务器只有 stable/beta 指针，没有历史版本清单
8. **命令安全**：CLI 和后台 installer 都通过 shell positional parameters 传递 URL、路径和版本数据，避免环境变量进入 shell 代码
9. **自动安装环境净化**：后台安装强制 `SID_CODE_CHANNEL=stable`、`SID_CODE_AUTO_UPDATE=1`，并删除继承的 `SID_CODE_VERSION`

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

**放弃理由**：`getVersion()` 返回带前缀的展示文本，`getRawVersion()` 返回裸版本号。版本比较需要裸版本号，用展示文本会静默破坏比较逻辑。

### 候选方案 E：把 INSTALL_URL 直接插入 `bash -c` 字符串

**放弃理由**：`SID_CODE_INSTALL_URL` 可由用户环境覆盖，直接拼接会让 URL 中的 shell 元字符被解释。改为 `bash -c 'curl -fsSL "$1" | bash' ... URL`，后台 installer 的 URL、路径和版本也统一使用 positional parameters。

## 拿什么证明它生效了

### 自动化测试

- `packages/core/tests/update/`：70 个自动更新相关测试通过，覆盖版本、配置、节流、状态、锁、通知、checker、编排和 detached installer。
- `packages/cli/tests/command/update.test.ts`：CLI 参数校验、指定版本环境变量、拒绝 `--list`/未知参数和 URL 参数化测试通过。
- `tests/update-auto-e2e.test.ts`：离线真实运行 `latest.txt → install-template.sh`，验证 stable/beta 指针解析、SHA256、解压、冒烟、原子切换和失败时旧入口保留。

### 门禁

最终门禁命令及结果以本次验证输出为准：自动更新测试、离线 E2E、`affected-tests:run`、`make build`、`bun run lint`、`bun run format:check`、`bun run lint:boundary`。若某条门禁受仓库既有问题影响，必须在交付说明中列出具体命令和失败输出，不将其描述为全绿。

### 手动验证步骤

1. `sc-dev` 启动开发版，观察是否显示 transient message（首次启动无 pendingNotice，应无消息）
2. 设 `SID_CODE_AUTO_UPDATE=notify`，检查 settings.json 解析是否正确
3. 设 `SID_CODE_UPDATE_CHECK_INTERVAL_HOURS=0.001`（3.6 秒），确认检查节流行为
4. 查看 `~/.sid-code/updates/state.json`，确认 `lastCheckAt` / `consecutiveFailures` / `pendingNotice` 字段正确写入
5. 同时启动两个 `sc-dev` 实例，检查只有一个执行安装，另一个日志显示锁已被持有
6. 在隔离 HOME 下人工执行真实 stable 更新 smoke，确认当前版本、配置保留和失败保护
