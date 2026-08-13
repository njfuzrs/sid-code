<!--
标题请用 Conventional Commits 格式，控制在 70 字符内，例如：
  fix(tool): 修复 bash 超时在慢机器上不生效
识别的 type：feat / fix / refactor / perf / docs / style / test / build / ci / chore
（CHANGELOG.md 是从 git 历史机械生成的，格式不对会被归到「其他」组）
-->

## 改了什么

<!-- 一两句话说清这个 PR 做了什么。一个 PR 一件事。 -->

## 为什么这么改

<!--
说清动机与取舍，这部分比「改了什么」更有价值：
 - 修 bug：根因是什么？为什么是这个改法而不是别的？
 - 加功能：解决什么实际问题？
 - 如果否决过其他方案，写一句为什么否决——省下后来人重走一遍的时间。
关联 issue：Fixes #123
-->

## 怎么验证的

<!-- 贴真实输出，不要只写「测试通过」。失败也如实贴，比隐去更有用。 -->

```text
bun test              →
make build            →
bun run lint          →
bun run format:check  →
bun run lint:boundary →
```

CI 有两个 job、五道门禁，上面五条本地全跑绿基本就不会红：

- [ ] `bun test` 全绿（0 fail）
- [ ] `make build` 成功（末尾 `--self-check` 通过）
- [ ] `bun run lint` 通过（oxlint）
- [ ] `bun run format:check` 通过（红了跑 `bun run format` 再 `git add`）
- [ ] `bun run lint:boundary` 通过（动了跨包导入必跑）
- [ ] 带了覆盖本次改动的测试（bug 修复要有能复现原问题的用例）
- [ ] 用 `sc-dev` 实际跑过（**不是 `sc`**，那是线上版，验证不到本地改动）

## 自查

- [ ] **只改了与本次任务相关的文件**（`git status` 里别人的在途改动没动过；
      没用过 `rm` / `git checkout --` / `git restore` / `git reset --hard` / `git clean`）
- [ ] 没跑 `make build-bump` 或 `./scripts/release.sh`（版本号只在发布流程里变）
- [ ] 没新增类型错误（CI 暂不含 `tsc --noEmit`，靠自觉）
- [ ] 没提交密钥、内网地址、本机绝对路径
- [ ] 改了 `packages/cli/src/{help,cli}.ts` / `packages/core/src/{tool,config,hook}/` /
      `packages/cli/src/command/` 的话，跑过 `bun run docs:gen-reference`
      并提交了 `website/ref/` 与 `website/public/llms.txt` 的改动
- [ ] 测试若会写 `~/.sid-code/`，已重定向到 tmpdir
      （见 [CONTRIBUTING.md](../CONTRIBUTING.md) 的测试约定——违反它的测试**会全绿**）
- [ ] 改动涉及 `packages/tui-renderer/src/`（分包前的 `src/ink/`）的话，
      读过 [NOTICE](../NOTICE) 第 1 节
- [ ] 分支不是 `main`（从 `main` 切出的 `<type>/<描述>` 短命分支），且已装 git hook
      （`bun run install-hooks`）

## 破坏性变更

<!-- 有的话写在这里：影响什么、用户需要做什么。没有就写「无」。 -->

无
