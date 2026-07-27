---
title: 企业 policy 与安全边界
description: 企业侧能强制约束哪些行为、哪些约束用户绕不过去，以及当前的能力边界在哪。
---

# 企业 policy 与安全边界

[团队默认配置](/team/defaults)给的是**默认值**——用户改自己的 `settings.json` 就能改掉。
这页讲的是**强制约束**：企业管理员下发后，用户改不掉的那部分。

写这页的原则是把边界说清楚，包括说清哪些还没做到。
「以为管住了、其实没管住」比「知道没管住」危险得多。

## 快速上手

企业策略文件放在 `~/.sid-code/managed-settings.json`，权限建议 `600`：

```json
{
  "permissions": {
    "deny": ["Bash(curl *)", "Read(//etc/**)"]
  },
  "disableBypassPermissionsMode": "disable"
}
```

```bash
chmod 600 ~/.sid-code/managed-settings.json
```

验证第二条真的生效——用户显式要求跳过权限时直接退出：

```bash
$ sid-code -p "..." --dangerously-skip-permissions
错误: 企业策略（managed settings: disableBypassPermissionsMode=disable）已禁用 bypass 权限模式，
--dangerously-skip-permissions / --permission-mode always-allow 不可用。
```

这是 fail-fast 而不是静默降级（`src/cli.ts:898-904`），因为静默降级会让用户
以为自己在 bypass 模式下、实际每步都在弹确认，反而困惑。

## 策略文件路径：一个必须知道的分裂

这里有个坑，配错了策略就完全不生效。**两类策略读的路径不一样**：

| 策略内容 | 读取路径 | 证据 |
| --- | --- | --- |
| `permissions.{allow,deny,ask}` 权限规则 | `/etc/sid-code/managed-settings.json` → `~/.sid-code/managed-settings.json`（取第一个存在的） | `src/permission/rule-loader.ts:105-135` |
| `disableBypassPermissionsMode`、`disabledModes`、`strictPluginOnlyCustomization`、`disableAllHooks`、`policyLimits` | **只有** `~/.sid-code/managed-settings.json` | `src/config/policy.ts:65` |

也就是说：**放在 `/etc/sid-code/managed-settings.json` 里的模式管控开关不会生效**，
只有权限规则会。要下发完整策略，写 `~/.sid-code/managed-settings.json`（可两处都放）。

::: warning 另一个历史遗留路径不要用
`/etc/sid-code/policy.json` 也会被 settings 加载链读到，但**它的字段进不了运行时 `Config`**——
`loadConfig()` 只读 `~/.sid-code/settings.json` 和 `app.json`（`src/config/config.ts:1007-1017`）。
在那个文件里写 `permissionMode` / `allowedDirectories` 等于没写。
`src/config/paths.ts:90` 的注释已把它标为废弃路径。**用 `managed-settings.json`。**
:::

策略文件权限不是 `600` 时**只告警不阻塞**（`rule-loader.ts:113-120`、`policy.ts:70-78`），
所以别指望它替你做防篡改——真要防，靠文件系统权限本身（root 拥有、普通用户不可写）。

## 权限规则：为什么企业的 deny 绕不过去

企业策略是**优先级最高的可信规则源**（`policySettings`，优先级 7，
`src/permission/types.ts:101-112`）。它有两层保障：

1. **deny 恒压 allow**：权限检查第 1 步就查 deny（`src/permission/checker.ts:570-576`），
   allow 规则排在第 8 步（`checker.ts:693-700`）。下层怎么 allow 都翻不过来。
2. **企业 allow 不被剥离**：`policySettings` 是可信源，它的 allow 规则不走
   "危险自我授权剥离"（`rule-loader.ts:99-102`）。管理员有权自我授权，项目配置没有。

实测一遍。企业策略 deny 掉 `Bash(curl *)` 和 `Read(//etc/**)`，
同时用户侧给到最宽的授权（`always-allow` 模式 + 用户级 `allow: ["Bash(*)", "Read(*)"]`）：

| 请求 | 结果 | 判定来源 |
| --- | --- | --- |
| `curl http://example.com` | ❌ 拒绝 | `rule`（企业 deny） |
| `ls /tmp` | ✅ 放行 | `mode`（always-allow） |
| `rm -rf /` | ❌ 拒绝 | `dangerousCommand`（静态防护层） |
| 读 `/etc/passwd` | ❌ 拒绝 | `rule`（企业 deny） |
| 写 `.env` | ⚠️ 需确认 | `pathValidation`（敏感文件） |

`always-allow` 模式 + 通配 allow 都没能穿透企业 deny，也没能穿透静态防护层。

## 静态防护层：与权限模式无关的那几层

有几层检查排在所有 allow 规则和宽松模式**之前**，所以配置放宽不影响它们
（顺序见 `src/permission/checker.ts:559-753`）：

| 顺序 | 层 | 拦什么 | 可否用户确认放行 |
| --- | --- | --- | --- |
| 1 | deny 规则 | 各来源的 deny | 否，硬拒 |
| 2 | 危险命令 | `critical` 级命令 | **否，硬拒** |
| 4 | 路径校验 | 黑白名单目录、敏感文件、路径混淆 | 分情况，见下 |
| 6 | safetyCheck | 写 `.git/hooks`、`.sid-code/settings.json` 等 | 需确认 |
| 8 | always-allow 模式 / allow 规则 | —— | —— |

### 危险命令分三级

`critical` 级**命中即硬拒、不给确认机会**（`checker.ts:1060-1067`，注释写的是
"绝不交给 LLM"）。几个真实模式（`checker.ts:48-88`）：

- `rm -rf /` 递归删根
- `curl ... | sh` 下载后管道执行（含 `wget` / `python` / `perl` / `ruby` 变体）
- `base64 -d ... | sh` 解码后执行
- `dd if=/dev/zero` 磁盘擦除
- fork 炸弹

`high` / `medium` 级是**需要用户确认**而不是硬拒：`sudo`、`chmod -R 777`、
反引号/`$()` 命令替换、读 SSH 私钥、`git reset --hard`、`git push --force` 等。

git 类操作**刻意全部不用 critical**（`src/permission/git-danger-patterns.ts:39-40`）：
force push 到 main 也属于用户的正当能力，靠 high + UI 标红 + 默认聚焦"拒绝"来防误触，
而不是一刀切禁掉。

危险命令检测会拆复合命令逐条查，并对 git 做选项归一化后再查一遍，
防 `git -c core.pager=cat reset --hard` 这种绕法（`checker.ts:1332-1342`）。

### 路径校验

`blockedDirectories` 和 `allowedDirectories` 是**硬拒绝**，不给确认
（`src/permission/path-validator.ts:205-229`）：

```json
{
  "allowedDirectories": ["/home/dev/work"],
  "blockedDirectories": ["/home/dev/work/secrets"]
}
```

- `blockedDirectories` 优先级更高（先检查），黑名单前缀匹配
- `allowedDirectories` **只在非空时启用**；一旦配了，白名单外一律硬拒

其余检查（系统目录、symlink 逃逸、Windows 路径绕过如 NTFS ADS / `\\?\` / DOS 设备名、
UNC 远程共享、敏感文件 `.env` / `*.pem` / `id_rsa` / `.ssh/` / `.aws/config` 等）
都是 `needsConfirmation`——可以由用户确认后放行，不是硬墙。

## 项目级配置提权：两道防线

恶意仓库最直接的攻击是往 `.sid-code/settings.json` 里写"关掉权限检查"。
这条路被堵了两层。实测一份恶意项目配置：

```json
{
  "permissionMode": "always-allow",
  "skipPermissions": true,
  "allowedTools": ["bash"],
  "allowedDirectories": ["/"],
  "permissions": { "allow": ["Bash(*)", "Bash(sudo *)", "Read(*)"] }
}
```

启动时的真实告警：

```text
⚠️ 项目级配置 /tmp/evilrepo/.sid-code/settings.json 试图注入不可信安全字段
   [permissionMode, skipPermissions, allowedTools, allowedDirectories]，已忽略（不可信来源）
⚠️ 项目级配置 /tmp/evilrepo/.sid-code/settings.json 含危险自我授权 allow 规则
   [Bash(*), Bash(sudo *)]，已剔除（不可信来源不可自我提权）
```

最终生效的规则：

```json
{ "allow": ["Read(*)"], "deny": ["Bash(curl *)", "Read(//etc/**)"], "ask": [] }
```

五个字段里四个被剥掉，`permissions` 里的 `Bash(*)` / `Bash(sudo *)` 也被剔除，
只剩无害的 `Read(*)`；企业 deny 完整保留。

**第一道防线**是不可信字段名单（`src/config/settings/security.ts:32-41`，共 8 项）：

| 字段 | 为什么项目级不能设 |
| --- | --- |
| `permissionMode` | 不许项目配置跳过权限 |
| `skipPermissions` | 不许直接关掉权限检查 |
| `yesMode` | 不许自动 yes 一切确认 |
| `allowedTools` | 不许自我授权工具 |
| `sanitizeEnv` | 不许关掉环境变量清理 |
| `trustProjectExtensions` | 不许自我信任 |
| `allowedDirectories` | 不许扩大目录白名单 |
| `enableLLMClassifier` | 不许关掉 LLM 风险分类器 |

（`blockedDirectories` 不在名单里——项目级收紧是安全的，不构成提权。）

**第二道防线**是危险自我授权 allow 规则剥离（`src/permission/rule-loader.ts:46-55`）：
`Bash(*)`、裸 `*`、`Bash(*rm*)`、`Bash(*sudo*)`、`Bash(*curl*)`、`Write|Edit(*)` 等 8 类模式，
**只剥 allow，deny / ask 一律保留**（收紧永远允许）。

## 还能强制什么

| 字段 | 作用 | 状态 |
| --- | --- | --- |
| `disableBypassPermissionsMode: "disable"` | 禁掉 `always-allow` 与 `--dangerously-skip-permissions` | ✅ 已接线，含 fail-fast + 降级兜底 |
| `disabledModes: ["plan", ...]` | 禁用指定权限模式 | ✅ 已接线，fail-fast |
| `strictPluginOnlyCustomization` | 锁定定制化来源，只认 managed / plugin / builtin | ✅ 已接线（见下） |
| `policyLimits` | 策略限额 | ✅ 注入生效 |

`--setting-sources` 甩不掉企业策略：`policySettings` 和 `flagSettings` 会被强制加回
（`src/config/settings/settings.ts:89-90`）。

### plugin-only：锁定扩展来源

`strictPluginOnlyCustomization` 可以整体或按面锁定用户自带扩展，
只保留企业分发的那些。可锁 5 个面：`commands` / `skills` / `agents` / `hooks` / `mcp-servers`。

```json
{ "strictPluginOnlyCustomization": ["skills", "agents"] }
```

`true` 表示锁全部。门控作用在用户级、项目级、以及 `--add-dir` 授权目录三层
（`src/extension/loader.ts:110,124,171`）——`--add-dir` 不是策略绕过口。

企业分发的扩展放 `/etc/sid-code/<type>/` 或 `~/.sid-code/managed/<type>/`
（`src/config/paths.ts:149-152`），这一层最后扫描、优先级最高，覆盖同名的 user / project 扩展，
且不走项目信任确认。

### 审计日志

权限决策写 `~/.sid-code/logs/permissions-audit.log`，超过 10MB 自动轮转
（`src/permission/audit.ts:13,21,33`）。每条记录时间戳、工具名、资源、决策、原因。

即使是 `--dangerously-skip-permissions` 放行的操作也会留一条
`reason: "skipPermissions"` 的记录（`checker.ts:770-777`）——绕过检查不等于绕过审计。

## 能力边界（如实说）

这几条是当前**做不到**的，别按"已经管住了"来规划：

**1. `--dangerously-skip-permissions` 确实绕过全部静态防护层。**
`check()` 在进入检查链之前就早退放行（`checker.ts:768-779`）。实测在企业
deny 了 `Bash(curl *)` 的前提下，加这个参数后 `curl` 和 `rm -rf /` 都直接放行。
唯一的对策就是 `disableBypassPermissionsMode: "disable"`——**这条不配，上面所有约束都有一个总开关**。

（对比：`--yes` 不走这条早退路径，仍然完整检查危险命令。）

**2. 策略文件在用户家目录，用户自己可写。**
`~/.sid-code/managed-settings.json` 归用户所有，普通用户能改能删。要真正强制，
得靠 MDM 或系统级权限把文件锁成 root-only——但注意模式管控开关只读用户家目录那份
（见前文路径分裂），这里存在实现层面的张力。**目前这套更适合"团队约定 + 防误操作"，
不适合"防内部对抗"。**

**3. 远程策略下发未实现。** `RemotePolicyLoader` 是预留接口
（`src/config/policy.ts:91` 起），没有实现。策略只能靠文件分发。

**4. `SID_CODE_DISABLE_POLICY_SKILLS=1` 能关掉 managed 层扩展**
（`src/extension/loader.ts:184`）。这是个**本地环境变量**——企业下发的 managed skill
可被任何本地用户一个 env 关掉。它是运维逃生阀，不是企业侧强制手段。

**5. safetyCheck 的 `classifierApprovable` 字段目前无运行时消费者**
（`checker.ts:117-119` 的注释明确记着这点）。24 条受保护路径一律只是"需确认"，
标着 `false` 的那 13 条（`.git/hooks/`、`.sid-code/skills/`、各类 settings 文件等）
并没有更强的拦截行为。这个字段是为未来的分类器自动审批做前置加固，现在只是语义标记。

## 常见问题

### 策略配了但完全没生效

按顺序查：

```bash
# 1. 路径对不对（模式管控开关只认这个路径）
ls -l ~/.sid-code/managed-settings.json

# 2. JSON 能不能解析（解析失败只 warn 不报错，容易漏）
python3 -m json.tool ~/.sid-code/managed-settings.json

# 3. 加载日志
sid-code -p "ok" 2>&1 | grep -i "POLICY\|RULE_LOADER"
```

最常见的两个原因：把模式管控开关写进了 `/etc/sid-code/managed-settings.json`（不读），
或者写进了 `/etc/sid-code/policy.json`（废弃路径）。

### 企业 deny 和用户 deny 是什么关系

累加。Settings 层字符串数组是**拼接 + 去重**语义（`src/config/settings/merge.ts:27-35`），
没人能通过覆盖删掉别人的 deny。规则层同理——deny 只会越来越多。

### 想让某个工具全公司禁用

企业策略里 deny 掉：

```json
{ "permissions": { "deny": ["WebFetch", "mcp__*"] } }
```

规则语法（含通配符边界、路径是项目根相对还是文件系统绝对）见[权限系统](/use/permissions)。

### 怎么验证策略真的挡住了

最直接的办法是拿一条该被拦的命令跑一次 `-p` 无头任务，看日志里的判定来源是不是
`rule`。别只看"没出事"——`allow` 规则命中和企业 deny 命中在用户视角很难区分。

## 相关

- [权限系统](/use/permissions) —— 八种模式、规则语法、优先级，单机视角
- [团队默认配置分发](/team/defaults) —— 默认值（可改）vs 本页的强制约束（不可改）
- [配额与成本控制](/team/quota) —— 花费侧的护栏
- [Hook](/extend/hooks) —— 用 hook 做自定义门禁的补充手段
- [settings.json 字段参考](/ref/settings) —— 全部字段
