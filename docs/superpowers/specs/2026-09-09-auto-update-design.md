# 实现设计方案：自动更新机制

> **前置依赖**：`2026-09-09-auto-update-requirements.md`
> **状态**：待实现
> **日期**：2026-09-09

## 1. 架构总览

```
┌────────────────────────────── CLI 进程（交互会话）──────────────────────────────┐
│ App 启动 ──► startAutoUpdateCheck()  [fire-and-forget, 不 await]                │
│                │                                                                │
│                ├─ 0. 消费 pendingNotice ──► transient message 提示               │
│                ├─ 1. settings.autoUpdate == "off"? ──► 结束                     │
│                ├─ 2. 节流：距 lastCheckAt < 24h? ──► 结束                       │
│                ├─ 3. fetch latest.txt（5s 超时）──失败──► 记日志，结束            │
│                ├─ 4. 格式校验 + semver 比较 ──不大于──► 结束（降级保护）          │
│                ├─ 4.5 若当前版本含 prerelease 标记（如 0.2.0-beta.1）──► warn + 结束（dev 版不应自动更新）│
│                ├─ "notify" 档：写 pendingNotice(available) ──► 结束              │
│                └─ "auto" 档：抢 mkdir 锁 ──► spawn detached 子进程 ──► 返回      │
└─────────────────────────────────────────────────────────────────────────────────┘
                                          │（父进程不等待，会话正常运行）
┌─────────────────────────────────── detached 子进程 ─────────────────────────────┐
│ bash: curl -fsSL install.sh | bash   （输出重定向 last-update.log）               │
│   install.sh 既有流程：读 latest.txt → 下载 tarball → sha256 → 解压到             │
│   versions/<v>/ → --version 冒烟 → ln -sfn 临时链接 + mv -f 原子切换              │
│ 子进程收尾：写 state.json（success/failed + 原因）→ pendingNotice → 释放锁        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 2. 代码落点（模块划分）

全部新增在 **`packages/core/src/update/`**（core 是 cli 的合法依赖方向；URL 常量从 `cli/command/update.ts` 上移到 core，消除跨包重复定义）。

### 2.1 新增模块清单

| 文件 | 职责 | 关键接口 |
| --- | --- | --- |
| `config.ts` | 发布源 URL 权威 + autoUpdate 配置解析 | `RELEASE_ORIGIN` / `INSTALL_URL` / `resolveAutoUpdateMode(settings): "off"\|"notify"\|"auto"` |
| `versions.ts` | 版本比较与格式校验 | `isValidVersion(s): boolean` / `compareVersions(a,b): -1\|0\|1` / `isPrereleaseVersion(s): boolean` |
| `state.ts` | `updates/state.json` 读写（原子写：tmp + rename） | `readUpdateState()` / `writeUpdateState(patch)` |
| `throttle.ts` | 24h 节流判定 | `shouldCheck(state, now): boolean` |
| `lock.ts` | mkdir 锁 + stale 回收 | `acquireLock(): Handle\|null` / `handle.release()` |
| `checker.ts` | 拉取并解析 latest.txt | `fetchLatestVersion(): string\|null`（5s 超时，失败返回 null） |
| `installer.ts` | spawn detached 安装子进程 | `spawnBackgroundInstall(targetVersion): void` |
| `notify.ts` | pendingNotice 写入/消费 | `consumePendingNotice(): Notice\|null` |
| `index.ts` | 编排入口 | `startAutoUpdateCheck(): void`（同步返回，内部异步） |

### 2.2 依赖方向

```
packages/cli  ────import────►  packages/core/src/update/
      │                                    │
      │                                    ▼
      │                          packages/core/src/config/settings/
      ▼                                    ▼
packages/core/src/config/paths/  ──getSidHome()──► ~/.sid-code/updates/
```

URL 常量原本在 `packages/cli/src/command/update.ts`，本次上移到 `core/update/config.ts`，`cli/command/update.ts` 改为 `import { RELEASE_ORIGIN, INSTALL_URL } from "@sid-code/core/update/config.ts"`。注释保留原注释文字（「必须走 https + 域名，不能退回 IP 直连」那段）。

## 3. 状态目录与文件

`~/.sid-code/updates/`（一律经 `getSidHome()` 派生，测试用 `SID_CONFIG_DIR` 重定向）：

```
updates/
├── state.json        # 唯一状态源
├── lock/             # mkdir 原子锁（目录存在 = 持锁）
│   └── meta.json     # { pid, startedAt, host }
└── last-update.log   # 子进程 stdout+stderr（每次覆盖写，天然不膨胀）
```

### 3.1 state.json schema

```jsonc
{
  "lastCheckAt": "2026-09-09T12:00:00.000Z",  // 节流依据
  "consecutiveFailures": 0,                    // ≥3 时提示一次并归零
  "lastAttempt": {
    "at": "...",
    "fromVersion": "0.1.603",
    "toVersion": "0.1.604",
    "status": "success" | "failed",
    "reason": "sha256-mismatch" | "network" | "smoke-test" | "install-exit:<code>" | null
  },
  "pendingNotice": {                            // 下次启动消费后即删
    "type": "updated" | "available" | "failed",
    "fromVersion": "...",
    "toVersion": "...",
    "createdAt": "..."
  }
}
```

### 3.2 原子写入

`writeUpdateState` 用 tmp + rename 避免写入中途崩溃留下半份 JSON。读取时 `JSON.parse` 失败回退到空 state（视为首次启动），同时记录 warn 到 debug log。

## 4. 锁与并发（需求 3.4）

### 4.1 版本号获取

**⚠️ 必须用 `getRawVersion()`，不是 `getVersion()`**

`packages/shared/src/version.ts` 定义：
```ts
export function getVersion(): string {
  return `sid-code v${pkg.version} (TypeScript)`;  // "sid-code v0.1.603 (TypeScript)"
}
export function getRawVersion(): string {
  return pkg.version;  // "0.1.603"
}
```

自动更新版本比较必须用 `getRawVersion()`（裸 x.y.z），否则 semver 比较永远失败。

### 4.2 prerelease / dev 版本处理

若 `getRawVersion()` 返回的字符串含 `-`（如 `0.2.0-beta.1`），视为 prerelease/dev 版本：
- 记录 warn 日志：`auto-update: skipping prerelease version ${version}`
- 静默结束检查，不发请求、不更新
- **不提示用户**（dev 用户不需要被自动更新打扰）

### 4.3 锁机制

- 抢锁 = `mkdirSync(lock/)`（mkdir 在 POSIX 上原子，EEXIST 即失败）
- 抢锁失败 → 读 `meta.json`，`startedAt` 距今 **>30min 判 stale** → 删锁重抢一次（防子进程被 kill 后死锁）
- 释放 = 子进程收尾时 `rm -rf lock/`（**写在子进程脚本里**，因为父进程 spawn 后不等待）
- 多实例同时启动：只有抢到锁的 spawn 安装，其余静默跳过；`install.sh` 的 `mv -f` 原子切换本身幂等，双保险

## 5. 安装子进程（需求 2 / 3.3）

### 5.1 spawn 命令

`installer.ts` spawn 的命令形如：

```bash
bash -c '
  set -o pipefail
  curl -fsSL --connect-timeout 10 --max-time 600 "$INSTALL_URL" | bash >"$LOG" 2>&1
  code=$?
  if [ $code -eq 0 ] && \
     [ "$("$TARGET_BIN" --version 2>/dev/null)" = "v$TARGET_VERSION" ]; then
    status=success
  else
    status=failed
  fi
  # 依 status 写 state.json（success/failed + reason）
  # success → pendingNotice.type="updated"；failed → consecutiveFailures+1
  rm -rf "$LOCK_DIR"
'
```

### 5.2 关键细节

- `spawn(..., { detached: true, stdio: ["ignore", logFd, logFd] })` + `unref()`：父进程退出/会话结束不影响安装。**stdio 采用 redirect 模式**（实测：Bun.spawn detached + stdio: "ignore" 在 macOS ARM 上可靠，但 redirect 能保留子进程输出到 `last-update.log`，debuggability 显著优于 ignore）
- **env 净化**：子进程 env **显式设 `SID_CODE_CHANNEL="stable"`**（覆盖任何继承值，包括用户 shell rc 残留的 `beta`），同时删除 `SID_CODE_VERSION`（允许 install.sh 默认行为）。保留 `SID_CODE_RELEASE_HOST`/`SID_CODE_INSTALL_URL`（企业镜像场景）与 `HOME`/`PATH`。代码示例：
  ```ts
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.SID_CODE_CHANNEL = "stable";  // 显式覆盖，不依赖 delete + 默认值
  delete env.SID_CODE_VERSION;      // 允许 install.sh 按 latest.txt 决定版本
  env.SID_CODE_AUTO_UPDATE = "1";   // 标记自动更新来源，供日志排查
  ```
- 注入 `SID_CODE_AUTO_UPDATE=1`：`install.sh` 侧无感知也不依赖它（留给日志排查与将来埋点），不为此改 `install-template.sh`
- 成败判定以「`install.sh` 退出码 + 切换后软链目标 `--version` 输出 == 目标版本」双重校验，任一不符记 `failed`

### 5.3 实测验证（2026-09-09）

在 macOS ARM 上用 Bun 1.3.14 实测 detached spawn 行为：

| 测试 | stdio 模式 | 子进程输出量 | 父进程退出后子进程 | env 净化 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 基础 | `ignore` | 6 行 | 跑完、写 state ✅ | `SID_CODE_CHANNEL` 正确 unset ✅ | ✅ 通过 |
| 重定向 | `redirect` | 6 行 | 同上 + child.log 保留 ✅ | 同上 | ✅ 通过 |
| 压力 | `ignore` | 50 行 | 跑完、写 state ✅ | 同上 | ✅ 通过 |
| 压力 | `redirect` | 50 行 | 同上 + child.log 53 行 ✅ | 同上 | ✅ 通过 |

**结论**：
- Bun.spawn detached + `unref()` 在 macOS ARM 上完全可靠，父进程退出后子进程继续运行
- `stdio: "ignore"` 不触发 SIGPIPE（Bun 实现正确处理了这条路径）
- **采用 `redirect` 模式**：输出重定向到 `last-update.log`，保留 debuggability
- `delete env.SID_CODE_CHANNEL` 和显式设值都工作正常；设计选择显式设 `"stable"`（更鲁棒，不依赖 Bun 的 undefined 处理）

## 6. 通知（需求 2.1）

| 场景 | 提示文案（示意） | 通道 |
| --- | --- | --- |
| auto 档更新成功 | `sid-code 已自动更新到 v0.1.604（原 v0.1.603）。/changelog 查看变更` | 下次启动 transient message |
| notify 档发现新版 | `新版本 v0.1.604 可用，运行 sid-code update 更新` | 下次启动 transient message |
| 连续失败 ≥3 次 | `自动更新连续 3 次失败（原因: network），当前保持 v0.1.603。日志: ~/.sid-code/updates/last-update.log` | 提示一次后计数归零 |

消费即删（`consumePendingNotice` 原子清空），同一条通知只展示一次。

### 6.1 React Context wiring 细节

`transientMessage` 是 React Context（`UIStateContext`），只能在 React 组件树内用 `useContext(UIStateContext).showTransientMessage(text, type)` 拿到。

**挂点位置**：`packages/cli/src/ui/App.tsx` 的 `TUIApp` 组件的 `useEffect`（行 ~575-600，与 `startDeferredPrefetches` 同层）。

**wiring 步骤**：
```tsx
// packages/cli/src/ui/App.tsx
import { useUIState } from "./contexts/UIStateContext.tsx";
import { consumePendingNotice } from "@sid-code/core/update/notify.ts";

function TUIApp() {
  const { showTransientMessage } = useUIState();
  
  useEffect(() => {
    // 既有的 deferred prefetch
    import("../entrypoints/deferred-prefetch.ts")
      .then(({ startDeferredPrefetches }) => startDeferredPrefetches(true))
      .catch(() => {});
    
    // 新增：自动更新检查 + 通知消费
    import("@sid-code/core/update/index.ts")
      .then(({ startAutoUpdateCheck }) => {
        const notice = consumePendingNotice();
        if (notice) {
          const text = formatNoticeText(notice);  // 本地 helper
          showTransientMessage(text, TransientMessageType.Hint);
        }
        startAutoUpdateCheck();
      })
      .catch(() => {});
    
    return () => {};
  }, []);
  
  // ... 其余逻辑
}
```

**非交互模式（`--print`）**：没有 React 树，这条路径直接跳过。自动更新检查只在交互 TUI 会话中运行。

## 7. 边界情况处理矩阵（需求 3 逐条）

| # | 场景 | 行为 | 实现层 |
| --- | --- | --- | --- |
| 3.1 | DNS 失败/连接重置/下载中断/代理认证失败/TLS 错误 | fetch 5s 超时 + curl `-f --connect-timeout 10 --max-time 600`；失败静默记 state+log，24h 节流即天然退避 | `checker` / `installer` |
| 3.2 | 哈希不匹配/包损坏 | `install.sh` 既有 sha256 门禁，失败即中止、**不切软链**，子进程记 `failed(reason=install-exit:N)` | `install.sh`（复用） |
| 3.2 | 版本号格式非法 | `/^\d+\.\d+\.\d+$/` 不过 → 视为更新源异常，静默退出 | `versions.ts` |
| 3.2 | 签名验证失败 | 当前信任基线为 sha256+HTTPS，无签名环节（范围外，§8 明示） | — |
| 3.3 | 权限不足/磁盘不足 | `install.sh` 失败 → 同 3.2 路径；不重试不阻塞 | `install.sh`（复用） |
| 3.3 | 目标路径被占用 | `ln -sfn` 临时名 + `mv -f` 原子替换，POSIX 下不存在「占用」失败形态 | `install.sh`（既有） |
| 3.3 | 旧版本卸载失败 | **不卸载旧版本** —— 版本化目录保留即回滚素材，无此失败形态 | 架构决策 |
| 3.3 | 新版本启动失败 | 切换**前**冒烟测试拦截（见 3.5 行） | `install.sh`（既有） |
| 3.4 | 多实例并发更新 | mkdir 锁 + stale 回收 + `mv -f` 幂等 | `lock.ts` |
| 3.5 | 新版装后无法启动 → 回退 | 防线前置：冒烟不过不切软链；已切换后损坏的二进制无法自救（诚实边界），旧版本目录保留、人工回退 = 一条 `ln -sfn`；§10 文档给出手动回退指引 | `install.sh` + 文档 |
| 3.6 | 线上版本低于当前（beta 用户/手动装高版） | `compareVersions(latest, current) > 0` 才继续，等于/小于一律不动 | `versions.ts` |
| — | 当前版本是 prerelease / dev 构建 | warn 日志 + 静默结束，不发请求不更新（dev 用户不应被自动更新打扰） | `versions.ts` / `index.ts` |
| 3.7 | 更新源不可用 | 全链路 try/catch，任何异常不上抛到主流程，保留当前版本静默失败；连续 ≥3 次才提示一次 | `index.ts` 编排 |

## 8. 配置设计

### 8.1 settings.json 字段

```typescript
// packages/core/src/config/settings/types.ts
SettingsSchema = lazySchema(() =>
  z.object({
    // ... 既有字段
    /**
     * 自动更新模式
     * - "auto"（默认）：检测到新版本后台静默下载安装，下次启动生效
     * - "notify"：只检测并提示，不自动下载
     * - "off"：关闭自动更新
     */
    autoUpdate: z.enum(["off", "notify", "auto"]).optional(),
  }).passthrough(),
);
```

### 8.2 优先级

env `SID_CODE_AUTO_UPDATE` > `settings.json` 的 `autoUpdate` > 默认值 `"auto"`。

非法 enum 值（如手抖写 `"always"`）：warn 后回退到默认值 `"auto"`，不抛错。

### 8.3 老用户迁移

`mergeMissingTopLevelKeys` 团队默认值机制自动补字段，**零迁移动作**。

## 9. 测试计划（需求 4）

### 9.1 单测（`packages/core/tests/update/`）

全部遵守 CONTRIBUTING 落盘隔离铁律：`SID_CONFIG_DIR` → tmpdir，存/恢复原值、`getSidHome()` 派生路径、微任务排干。

- `versions.test.ts`：大于/等于/小于/多段数字/非法格式/空串
- `throttle.test.ts`：首次、23h59m、24h01m、state 损坏回退
- `lock.test.ts`：获取/互斥/stale 回收/释放
- `state.test.ts`：原子写、并发 patch、损坏文件容错
- `notify.test.ts`：写入/消费即删/无通知
- `config.test.ts`：env > settings > 默认三级优先级、非法 enum 值回退

### 9.2 集成（`packages/core/tests/update/integration.test.ts`）

- `Bun.serve` mock 发布源（latest.txt + tarball + sha256 + 假 install 脚本），`SID_CODE_RELEASE_HOST` 指向它，`BIN_DIR` / `VERSIONS_DIR` 经 env 重定向 tmpdir
- 走通：检测 → 下载 → 校验 → 切换 → state 写 success → pendingNotice
- 失败路径：sha256 不匹配、latest.txt 404、latest.txt 内容非法、脚本非零退出
- 降级保护：latest < current 时不发起任何请求

### 9.3 e2e（不自动化，理由入库）

真二进制自更新依赖真发布源与真软链切换，CI 上是 flake 源且会污染 runner；**发布流程第 7 步**已有人工 `sid-code update` 端到端核验兜底。

## 10. 文档计划（需求 5）

### 10.1 website 页面

`website/guide/auto-update.md` 新增一页，内容：

- 三种模式语义
- `settings.json` 与 env 配置法
- 通知形态（下次启动 transient message）
- 日志位置（`~/.sid-code/updates/last-update.log`）
- 手动回退指引（`ls ~/.local/share/sid-code/versions/` → `ln -sfn <dir>/sid-code ~/.local/bin/sid-code`）
- FAQ：如何暂停、如何查看上次失败原因、beta 用户行为

### 10.2 参考页与 llms.txt

动了 `packages/core/src/config/` 需跑 `bun run docs:gen-reference`，重新生成 `website/ref/`（settings 字段页）与 `llms.txt`，一并提交。

### 10.3 changelog

发版时 curated changelog 条目（用户视角一句话）。

## 11. 风险与工作量

### 11.1 风险与对策

| 风险 | 对策 |
| --- | --- |
| detached 子进程状态写回失败（被 kill/OOM） | stale 锁 30min 回收 + state 只在子进程收尾写，写失败仅丢一次通知，不影响正确性 |
| 启动性能回退 | 检查全程 fire-and-forget，不进 bootstrap 零导入快速路径，挂在 App mount 后（与 deferred-prefetch 同层） |
| `install.sh` 行为漂移 | 不复制其逻辑，只消费其退出码；`install.sh` 变更自动被继承（单一事实源的收益） |
| 自动更新静默坏死 | 连续失败 ≥3 次提示一次（§6） |
| 用户 shell rc 残留 `SID_CODE_CHANNEL=beta` 污染自动更新 | spawn 子进程时**显式设 `SID_CODE_CHANNEL="stable"`**（§5.2） |
| 误用 `getVersion()` 导致自动更新形同虚设 | 全链路统一用 `getRawVersion()`（§4.1），测试覆盖 |
| prerelease / dev 版本被错误更新 | `versions.ts` 检测 `-` 标记并跳过（§4.2） |

### 11.2 工作量估计

- `core/src/update/`：~500 行（含 React Context wiring 的 ~30 行复杂度）
- `cli/command/update.ts` 重构：~10 行
- `cli/ui/App.tsx` 挂点：~30 行
- 测试：~700 行
- website 一页 + docs:gen-reference 重新生成：~100 行
- **总计约 2–3 天开发 + 测试/文档**

单 PR 可容纳（独立上线 / 独立回滚 —— 默认值改 `"off"` 即全局停用 / 一次 review 完）。

## 12. 实施顺序（执行 checklist）

1. 切分支 `feat/auto-update`
2. 实现 `core/src/update/` 模块（按 §2.1 文件清单）
3. 改 `cli/command/update.ts` 复用 core 的 URL 常量
4. 改 `cli/ui/App.tsx` 挂启动 hook
5. 写单测 + 集成测试
6. website 新页 + `bun run docs:gen-reference`
7. `make build` 验证构建（grep warning）
8. `bun run affected-tests:run`（选测）+ 提 PR 前跑一次 `bun test` 全量
9. `bun run lint` / `format:check` / `lint:boundary`（动跨包导入）
10. Agent Note（`.agents/notes/proposed/feature/2026-09-09-auto-update-mechanism.md`）
11. 提交（conventional commits 中文）+ push + 开 PR
