# sid-code 自动更新使用手册

> **适用对象**：sid-code 最终用户、团队管理员和企业环境维护者
>
> **功能版本**：自动更新机制
>
> **相关文档**：[自动更新功能实现澄清](./2026-09-16-auto-update-implementation-clarification.md)

## 1. 这项功能解决什么问题

sid-code 可以在启动后自动检查是否有新版本，并按照你的配置决定是否自动安装。

你不需要手动下载压缩包，也不需要在每次发布后执行更新命令。sid-code 会在后台完成版本检查和安装，正常使用过程不会等待网络请求或安装过程。

自动更新的完整用户流程是：

```text
启动 sid-code
  ↓
后台检查 stable 最新版本
  ↓
比较当前版本与线上版本
  ↓
根据 autoUpdate 配置决定行为
  ├─ off：不检查
  ├─ notify：只提示，不安装
  └─ auto：后台下载并安装
  ↓
安装完成后原子切换入口
  ↓
下次启动时显示结果通知
```

默认情况下，自动更新使用 stable 通道，并且最多每 24 小时检查一次。

## 2. 开始前：确认当前版本

查看当前 sid-code 版本：

```bash
sid-code --version
```

示例输出：

```text
sid-code v0.1.603 (TypeScript)
```

这里的版本号是 `0.1.603`。自动更新只识别完整的三段稳定版本号：

```text
x.y.z
```

以下版本格式不能作为稳定自动更新目标：

```text
0.1
v0.1.603
0.1.603-beta.1
latest
```

如果当前 sid-code 是 prerelease 或开发版本，自动更新会跳过，不会强行覆盖开发版本。

## 3. 第一次启动时会发生什么

首次启动 sid-code 时，自动更新模块会在 TUI 启动后异步运行：

1. 读取已有的更新通知；
2. 根据 `autoUpdate` 判断是否启用检查；
3. 判断距离上次检查是否已超过 24 小时；
4. 从 stable 发布源读取最新版本；
5. 比较线上版本与当前版本；
6. 根据模式执行提示或后台安装。

这个过程不会阻塞 sid-code 的主工作流。即使网络不可用，sid-code 也应该继续启动和工作。

自动更新使用的 stable 版本指针是：

```text
https://www.sid-code.cc/releases/sid-code/latest.txt
```

用户不需要直接访问或修改这个文件。

## 4. 选择自动更新模式

自动更新模式写在 `settings.json` 的顶层字段 `autoUpdate` 中。

```json
{
  "autoUpdate": "auto"
}
```

支持三种模式。

### 4.1 `auto`：自动下载安装

```json
{
  "autoUpdate": "auto"
}
```

这是默认模式。

当检测到线上版本高于当前版本时，sid-code 会：

1. 获取更新锁；
2. 启动后台安装进程；
3. 下载安装脚本和安装包；
4. 校验 SHA256；
5. 解压并执行新版本冒烟检查；
6. 通过原子操作切换版本入口；
7. 记录安装结果；
8. 在下次启动时显示“已自动更新”通知。

当前正在运行的 sid-code 进程不会被强行重启。安装完成后，后续新启动的 sid-code 使用新版本。

### 4.2 `notify`：只提示，不自动安装

```json
{
  "autoUpdate": "notify"
}
```

检测到新版本时只写入一条可用更新通知，不会自动下载或替换当前版本。

你可以在方便的时候手动执行：

```bash
sid-code update
```

推荐在企业环境、生产环境或需要人工安排升级窗口的机器上使用此模式。

### 4.3 `off`：关闭自动更新

```json
{
  "autoUpdate": "off"
}
```

`off` 模式会关闭自动更新检查，但不会禁用手动更新命令：

```bash
sid-code update
```

这适合需要固定版本、由管理员统一升级，或者暂时不希望 sid-code 访问发布源的环境。

## 5. 临时覆盖自动更新模式

如果不想修改 `settings.json`，可以使用环境变量临时覆盖配置。

临时关闭自动更新：

```bash
SID_CODE_AUTO_UPDATE=off sid-code
```

临时使用只提示模式：

```bash
SID_CODE_AUTO_UPDATE=notify sid-code
```

临时启用自动安装：

```bash
SID_CODE_AUTO_UPDATE=auto sid-code
```

优先级如下：

```text
SID_CODE_AUTO_UPDATE > settings.json.autoUpdate > 默认值 auto
```

环境变量只影响当前命令或当前 shell 环境，不会自动写回 `settings.json`。

## 6. 自动更新发现新版本后的完整流程

假设当前版本是：

```text
0.1.603
```

线上 stable 版本是：

```text
0.1.604
```

### 6.1 `notify` 模式流程

```text
启动 sid-code
  ↓
发现 0.1.604 > 0.1.603
  ↓
写入 available 通知
  ↓
不下载、不安装、不替换入口
  ↓
下次启动显示可用更新提示
```

提示内容的语义类似：

```text
新版本 v0.1.604 可用，运行 sid-code update 更新
```

### 6.2 `auto` 模式流程

```text
启动 sid-code
  ↓
发现 0.1.604 > 0.1.603
  ↓
获取更新锁
  ↓
后台启动 install.sh
  ↓
下载并校验安装包
  ↓
安装到版本化目录
  ↓
执行新版本 --version 检查
  ↓
原子切换 sid-code 入口
  ↓
写入 updated 通知
  ↓
下次启动显示更新结果
```

安装期间当前正在运行的 sid-code 不会被中断。原子切换只影响之后新启动的进程。

### 6.3 当前版本已经是最新时

如果线上版本等于当前版本：

```text
线上 0.1.603 = 当前 0.1.603
```

不会下载或安装。

如果线上版本低于当前版本：

```text
线上 0.1.603 < 当前 0.1.604
```

同样不会降级。这可以保护已经安装较高版本或 beta 版本的用户。

## 7. 更新完成后如何确认

查看版本：

```bash
sid-code --version
```

查看更新状态：

```bash
cat ~/.sid-code/updates/state.json
```

查看更新日志：

```bash
cat ~/.sid-code/updates/last-update.log
```

成功状态通常包含：

```json
{
  "lastAttempt": {
    "fromVersion": "0.1.603",
    "toVersion": "0.1.604",
    "status": "success"
  },
  "pendingNotice": {
    "type": "updated"
  }
}
```

通知会在启动时消费一次。消费后，再次启动不会重复显示同一条通知。

## 8. 手动更新

### 8.1 更新到 stable 最新版本

```bash
sid-code update
```

这个命令会直接执行手动安装流程，默认使用 stable 通道。

`autoUpdate` 设置为 `off` 或 `notify` 时，手动更新仍然可用。

### 8.2 更新到 beta 版本

```bash
SID_CODE_CHANNEL=beta sid-code update
```

beta 通道用于体验较新的功能，但稳定性可能低于 stable。

通道变量不会被写入本地配置。下次不带变量执行：

```bash
sid-code update
```

会回到 stable 通道。

### 8.3 安装指定稳定版本

```bash
sid-code update --version 0.1.602
```

也可以使用环境变量：

```bash
SID_CODE_VERSION=0.1.602 sid-code update
```

指定版本必须是完整的稳定版本号：

```text
x.y.z
```

以下写法会被拒绝：

```bash
sid-code update --version 0.1
sid-code update --version v0.1.602
sid-code update --version 0.1.602-beta.1
sid-code update --version latest
```

### 8.4 查看帮助

```bash
sid-code update --help
```

或：

```bash
sid-code update -h
```

### 8.5 `--list` 当前不可用

```bash
sid-code update --list
```

当前会明确提示不支持该参数。

原因是发布服务器提供 stable 和 beta 两个通道指针，但目前没有提供历史版本列表接口。需要安装已知版本时，直接使用：

```bash
sid-code update --version x.y.z
```

## 9. 更新通道如何选择

| 场景 | 推荐方式 |
| --- | --- |
| 普通用户，希望自动获得稳定修复 | `auto` + stable |
| 企业环境，希望人工审批升级 | `notify` + stable |
| 固定版本、统一运维升级 | `off` |
| 体验最新功能 | 手动 `SID_CODE_CHANNEL=beta sid-code update` |
| 测试指定历史稳定版本 | `sid-code update --version x.y.z` |

自动更新始终固定使用 stable，不会因为用户 shell 中残留了 `SID_CODE_CHANNEL=beta` 而自动安装 beta。

## 10. 更新失败时用户会看到什么

如果检查或安装失败，sid-code 会保留当前可用版本，不会用损坏的新版本覆盖当前入口。

可能的失败原因包括：

- 无法访问发布服务器；
- DNS、代理或 TLS 连接失败；
- 下载超时；
- 安装包 SHA256 校验失败；
- 安装包损坏；
- 目录权限不足；
- 磁盘空间不足；
- 新版本冒烟检查失败；
- 多个 sid-code 实例同时更新。

自动更新失败不会阻塞当前会话。连续失败达到 3 次后，sid-code 会显示一次失败通知，然后重新计算失败次数。

失败时查看日志：

```bash
cat ~/.sid-code/updates/last-update.log
```

查看状态：

```bash
cat ~/.sid-code/updates/state.json
```

失败状态类似：

```json
{
  "lastAttempt": {
    "status": "failed",
    "reason": "install-exit:22"
  },
  "pendingNotice": {
    "type": "failed"
  }
}
```

### 10.1 网络问题处理

先确认 stable 指针是否可以访问：

```bash
curl -fsSL \
  --connect-timeout 10 \
  --max-time 20 \
  https://www.sid-code.cc/releases/sid-code/latest.txt
```

如果当前网络不可用：

1. 当前版本会继续正常使用；
2. 自动更新不会强制安装；
3. 后续检查仍受 24 小时节流控制；
4. 网络恢复后再重新检查；
5. 不需要删除状态文件或手动替换二进制。

### 10.2 权限问题处理

确认 sid-code 相关目录可写：

```bash
ls -ld ~/.sid-code
ls -ld ~/.sid-code/updates
ls -ld ~/.local/bin
```

不要随意使用 `sudo sid-code update`，因为这可能改变配置目录、PATH 和文件所有者。应先确认当前安装方式和目录权限，再按实际环境修复。

### 10.3 多实例同时运行

多个 sid-code 实例同时启动时，只有一个实例会执行更新检查或安装，其他实例会跳过。

更新锁目录：

```bash
~/.sid-code/updates/lock/
```

锁默认超过 30 分钟后会被视为 stale，并允许后续检查回收。通常不需要手动删除锁目录。

## 11. 回退到指定版本

如果新版本出现问题，可以安装一个已知存在的稳定版本：

```bash
sid-code update --version 0.1.602
```

或者：

```bash
SID_CODE_VERSION=0.1.602 sid-code update
```

回退只会替换 sid-code 二进制入口，不会修改：

- settings 配置；
- 会话数据；
- 项目代码；
- 更新状态的其他字段。

注意：当前发布服务器没有历史版本列表接口，因此你必须知道要安装的具体版本号。

当前实现不提供“新版本启动失败后自动回退”。安装脚本会在切换入口前执行版本冒烟检查，尽量阻止不可启动版本被切换；如果已经切换且版本确实存在运行问题，应使用已知版本号手动更新回退。

## 12. 更新过程中数据是否安全

更新只替换 sid-code 的安装入口和版本目录，不修改你的项目代码和会话数据。

更新过程具有以下保护：

1. 新版本先下载到临时位置；
2. 安装包先执行 SHA256 校验；
3. 新版本先执行 `--version` 冒烟检查；
4. 通过检查后才切换入口；
5. 入口切换采用原子操作；
6. 旧版本目录不会立即删除；
7. 失败时保持旧版本入口。

因此在下载中断、进程退出或机器重启等情况下，通常不会留下半个不可用的当前版本。

## 13. 更新文件位置

自动更新相关文件位于：

```text
~/.sid-code/updates/state.json
~/.sid-code/updates/last-update.log
~/.sid-code/updates/lock/
```

| 路径 | 用途 |
| --- | --- |
| `state.json` | 保存检查、安装和通知状态 |
| `last-update.log` | 保存安装脚本输出和错误信息 |
| `lock/` | 防止多个进程同时安装 |

不要手动编辑 `state.json`，除非你正在进行隔离测试或故障排查。不要直接删除 `lock/`，优先退出重复运行的 sid-code 并等待 stale 锁回收。

## 14. 企业环境配置建议

企业可以通过团队默认配置统一设置：

```json
{
  "autoUpdate": "notify"
}
```

这样团队成员会收到新版本提示，但不会在工作过程中自动替换二进制。升级由个人或管理员在合适时间执行：

```bash
sid-code update
```

如果企业要求完全禁止自动检查：

```json
{
  "autoUpdate": "off"
}
```

手动更新是否允许，需要结合企业网络策略、文件权限和发布审批流程自行管理。

## 15. 用户日常使用建议

### 推荐方案 A：普通个人用户

配置：

```json
{
  "autoUpdate": "auto"
}
```

日常只需要正常启动 sid-code。发现新版本时，后台自动安装；下次启动查看更新通知即可。

### 推荐方案 B：生产或企业用户

配置：

```json
{
  "autoUpdate": "notify"
}
```

看到通知后，在维护窗口手动执行：

```bash
sid-code update
```

### 推荐方案 C：固定版本用户

配置：

```json
{
  "autoUpdate": "off"
}
```

需要升级时明确指定版本：

```bash
sid-code update --version 0.1.602
```

### 推荐方案 D：beta 体验用户

只在需要时显式指定 beta：

```bash
SID_CODE_CHANNEL=beta sid-code update
```

不要把 `SID_CODE_CHANNEL=beta` 永久写入 shell 配置，除非你明确希望所有手动更新都使用 beta。

## 16. 常见问题

### Q1：自动更新会不会打断当前任务？

不会。检查和安装在后台进行，当前已经启动的 sid-code 进程不会被强制重启。新版本通常在下一次启动时使用。

### Q2：每次启动都会访问网络吗？

不会。自动更新默认每 24 小时最多检查一次。

### Q3：我设置了 `off`，还能手动更新吗？

可以。`off` 只关闭自动检查，不影响：

```bash
sid-code update
```

### Q4：notify 模式会下载文件吗？

不会。notify 模式只检查版本并写入提示，不启动安装进程。

### Q5：beta 用户会被自动降级到 stable 吗？

不会。自动更新只有在线版本严格高于当前版本时才会继续。当前版本高于 stable 指针时，不会降级。

### Q6：我执行了一次 beta 更新，下次会一直使用 beta 吗？

不会。通道通过环境变量临时指定，不写入本地配置。下次不带 `SID_CODE_CHANNEL=beta` 时回到 stable。

### Q7：为什么没有 `sid-code update --list`？

当前发布服务器只提供 stable 和 beta 指针，没有历史版本列表接口。因此需要直接指定已知版本号。

### Q8：更新失败会不会把当前版本弄坏？

设计上不会。安装包先校验和冒烟，切换失败或安装失败时保持旧版本入口。

### Q9：如何确认更新是否成功？

执行：

```bash
sid-code --version
cat ~/.sid-code/updates/state.json
cat ~/.sid-code/updates/last-update.log
```

### Q10：如何查看更详细的自动更新日志？

```bash
SID_CODE_DEBUG=auto-update sid-code
```

同时可以查看：

```bash
cat ~/.sid-code/updates/last-update.log
```

## 17. 最简使用流程

如果你只想正常使用自动更新，只需要：

```bash
# 查看当前版本
sid-code --version

# 正常启动，默认自动检查并按配置更新
sid-code

# 下次启动时确认更新通知
sid-code --version
```

如果你希望手动控制：

```bash
# settings.json 设置 notify
# 检测到新版本后手动执行
sid-code update
```

如果你需要指定版本：

```bash
sid-code update --version 0.1.602
```

如果你需要暂时关闭自动更新：

```bash
SID_CODE_AUTO_UPDATE=off sid-code
```

## 18. 当前功能边界

当前已支持：

- stable 自动检查；
- beta 手动更新；
- `auto`、`notify`、`off` 三种模式；
- 指定稳定版本安装；
- SHA256 校验；
- 原子切换；
- 失败保护；
- 并发锁；
- 更新状态和通知。

当前不支持：

- `sid-code update --list` 历史版本列表；
- 代码签名验证；
- 新版本启动失败后的客户端自动回退；
- 客户端旧版本目录自动清理；
- Windows 安装链路。

这些能力不应被当前使用手册描述为已提供功能。
