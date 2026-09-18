---
title: 自动更新
description: 自动检测并安装新版本，支持 auto、notify、off 三种模式以及 stable、beta 通道。
---

# 自动更新

默认情况下，sid-code 会在后台检查稳定版通道有没有新版本，发现了就下载安装，
**下次启动才切过去**。正在跑的这次会话不会被替换。

这页讲三件事：怎么选更新模式、怎么手动更新、失败了会怎样。
安装本身（第一次装、指定版本、beta 通道）在[安装](/start/install)。

## 快速上手

三种模式，写在 `~/.sid-code/settings.json`：

```json
{
  "autoUpdate": "auto"
}
```

| 模式 | 行为 |
| --- | --- |
| `auto`（默认） | 后台静默下载并安装稳定版，下次启动生效 |
| `notify` | 发现新版本只提示，不下载。自己跑 `sid-code update` |
| `off` | 完全不检查。仍可随时 `sid-code update` |

环境变量 `SID_CODE_AUTO_UPDATE` 覆盖 settings（取值同样是 `off` / `notify` / `auto`），
适合 CI 或临时关掉：

```bash
SID_CODE_AUTO_UPDATE=off sid-code
```

手动更新（任何模式都能用）：

```bash
sid-code update                         # 装最新稳定版
SID_CODE_CHANNEL=beta sid-code update   # 装抢先版
sid-code update --version 0.1.602       # 装指定稳定版（回滚也走这条）
```

## 详细说明

### 自动更新只走稳定版

后台检查**只读**服务器的 `latest.txt`（稳定通道指针），安装子进程还会强制
`SID_CODE_CHANNEL=stable`，把你环境里继承来的 `beta` 盖掉。

这是刻意的：自动装不该把一台机器从稳定版悄悄切到抢先版。
想留在 beta，用手动更新并每次带上 `SID_CODE_CHANNEL=beta`——通道**不写进本地配置**，
下次不带变量就会回到稳定版。完整通道语义见[安装 · 抢先版](/start/install)。

### 检查频率

最多每 24 小时查一次，依据是 `~/.sid-code/updates/state.json` 里的 `lastCheckAt`。
网络失败、版本号非法都算「查过」，不会每开一次会话就打一次服务器。

### 装的时候不会动正在跑的进程

下载、SHA256 校验、冒烟测试都在后台子进程里做，通过版本化目录 + 软链接原子切换
（和 `install.sh` 是同一套）。当前这次会话继续用旧二进制，下次启动才走到新的。

多个 sid-code 同时开着时，只有抢到锁的那个去装，其余静默跳过。
锁在 `~/.sid-code/updates/lock/`，超过 30 分钟视为残留并回收。

### 失败了会怎样

装不上就不动旧入口，当前版本继续可用。连续失败 3 次才提示一次，避免刷屏。
详细过程在：

```bash
cat ~/.sid-code/updates/last-update.log
```

常见原因：访问不到 `www.sid-code.cc`、`~/.sid-code/` 没写权限、
已经有另一个实例在装。

### 回滚

没有「列出历史版本」的接口（`sid-code update --list` 会直接拒绝）。
知道要回到哪一版就指定版本号：

```bash
sid-code update --version 0.1.602
```

前提是服务器上还留着那个版本目录。配置和会话数据不受影响，只换二进制。

### 无头模式不自动更新

`-p` / `--print` 这条路径不跑自动检查——只有交互 TUI 启动时才会。
CI 和脚本不会在跑任务的当口自己改二进制。要更新，显式跑 `sid-code update`，
或在评测 / CI 的 settings 里写 `"autoUpdate": "off"`。

### 企业里怎么统一

团队默认配置可以定全员默认模式，例如先提示、不自动装：

```json
{
  "autoUpdate": "notify"
}
```

分发方式见[团队默认配置分发](/team/defaults)。个人 settings 和环境变量仍然可以覆盖。

开 `--debug` 时，检查 / 抢锁 / 安装的过程会进 `~/.sid-code/debug.log`，
分类是 `AUTO_UPDATE`。

## 相关

- [安装](/start/install) —— 第一次装、指定版本、beta 通道、卸载
- [settings.json 字段](/ref/settings) —— `autoUpdate` 的类型与缺省值
- [环境变量](/ref/env) —— `SID_CODE_AUTO_UPDATE`、`SID_CODE_CHANNEL`
- [CLI 参数与子命令](/ref/cli) —— `sid-code update` 的完整选项
- [更新日志](/changelog) —— 每个版本对用户有什么变化
