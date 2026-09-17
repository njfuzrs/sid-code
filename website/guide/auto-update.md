# 自动更新

sid-code 支持自动检测并安装新版本，让你始终使用最新的功能和修复。

## 工作原理

自动更新机制在后台运行，每次启动 sid-code 时检查是否有新版本可用：

1. **检测**：向 `www.sid-code.cc` 查询最新版本号
2. **节流**：最多每 24 小时检查一次，避免频繁请求
3. **下载**：发现新版本后，后台下载并原子切换到新版本
4. **通知**：下次启动时显示更新结果

整个过程在后台完成，不阻塞你的工作。

## 更新模式

通过 `settings.json` 的 `autoUpdate` 字段控制更新行为：

```json
{
  "autoUpdate": "auto"
}
```

三种模式：

| 模式 | 行为 |
|------|------|
| `auto` | **默认**：自动下载并安装新版本，下次启动生效 |
| `notify` | 检测到新版本时显示提示，但不自动安装。运行 `sid-code update` 手动更新 |
| `off` | 完全禁用自动更新。仍可通过 `sid-code update` 手动更新 |

也可以通过环境变量 `SID_CODE_AUTO_UPDATE` 覆盖 settings 配置（优先级更高）。

## 更新通道

sid-code 维护两个更新通道：

- **稳定版（stable）**：默认通道，经过充分测试的版本
- **抢先版（beta）**：包含最新功能但可能不够稳定的版本

默认使用稳定版通道。如需体验 beta 版本：

```bash
SID_CODE_CHANNEL=beta sid-code update
```

下次运行 `sid-code update` 时会回到稳定版通道，除非再次指定 `SID_CODE_CHANNEL=beta`。

## 查看当前版本

```bash
sid-code --version
```

输出示例：

```
sid-code v0.1.603 (TypeScript)
```

## 手动更新

即使 `autoUpdate` 设为 `off`，仍可随时手动更新：

```bash
sid-code update
```

这会检查并安装最新稳定版。如需安装 beta 版本：

```bash
SID_CODE_CHANNEL=beta sid-code update
```

也可以通过 CLI 参数安装指定的稳定版本：

```bash
sid-code update --version 0.1.602
```

版本号必须是完整的 `x.y.z` 稳定版格式。`--list` 当前不受支持，因为发布服务器只提供稳定版和 beta 通道指针，不提供历史版本清单。

## 更新失败怎么办

自动更新失败时，sid-code 会保持当前版本不变，并在下次启动时显示失败通知。

查看更新日志：

```bash
cat ~/.sid-code/updates/last-update.log
```

常见问题：

- **网络问题**：检查是否能访问 `www.sid-code.cc`
- **权限问题**：确保 `~/.sid-code/` 目录有写权限
- **进程占用**：如果多个 sid-code 实例同时运行，只有一个会执行更新，其余跳过

日志包含详细的错误信息，帮助定位问题。

## 回滚到旧版本

如果新版本出现问题，可以通过环境变量指定一个已发布的稳定版本：

```bash
SID_CODE_VERSION=0.1.602 sid-code update
```

版本号必须是完整的 `x.y.z` 稳定版本号。当前发布服务器只提供稳定版和 beta 通道指针，不提供历史版本清单，因此 `sid-code update --list` 不受支持。

如果需要体验 beta 版本：

```bash
SID_CODE_CHANNEL=beta sid-code update
```

回滚或切换通道不会修改配置和状态数据。

## 技术细节

### 原子切换

更新过程使用原子操作切换二进制文件：

1. 下载新版本到临时目录
2. 验证文件完整性（SHA256）
3. 通过符号链接原子切换到新版本

这意味着更新过程中如果中断（如断电），不会损坏已安装的版本。

### 锁机制

多个 sid-code 实例同时启动时，只有一个会执行更新检查。通过目录锁实现：

- 锁目录：`~/.sid-code/updates/lock/`
- 锁过期时间：30 分钟（防止崩溃后锁残留）
- 未抢到锁的实例静默跳过更新检查

### 状态文件

更新状态存储在 `~/.sid-code/updates/state.json`：

```json
{
  "lastCheckAt": "2026-09-14T12:00:00.000Z",
  "consecutiveFailures": 0,
  "lastAttempt": {
    "at": "2026-09-14T12:00:00.000Z",
    "fromVersion": "0.1.602",
    "toVersion": "0.1.603",
    "status": "success"
  },
  "pendingNotice": null
}
```

- `lastCheckAt`：上次检查时间（用于 24 小时节流）
- `consecutiveFailures`：连续失败次数
- `lastAttempt`：最后一次更新尝试的详情
- `pendingNotice`：待显示的通知（消费后清空）

## 企业环境

在企业环境中，可以通过团队默认配置统一控制更新行为：

```json
// team-defaults.json
{
  "autoUpdate": "notify"
}
```

这样所有团队成员的 sid-code 默认使用 `notify` 模式，检测到新版本时提示但不自动安装，由团队成员自行决定何时更新。

也可以完全禁用自动更新：

```json
{
  "autoUpdate": "off"
}
```

## 调试

启用详细日志查看自动更新过程：

```bash
SID_CODE_DEBUG=auto-update sid-code
```

这会输出更新检查、下载、安装的详细日志到终端。

## 相关资源

- [CLI 参数参考](/ref/cli-args) — `sid-code update` 命令的完整选项
- [settings 字段参考](/ref/settings) — `autoUpdate` 字段的详细说明
- [环境变量参考](/ref/env-vars) — `SID_CODE_AUTO_UPDATE` 等环境变量
