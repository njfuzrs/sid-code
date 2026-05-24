# evals/_legacy/

历史遗留代码归档目录。**所有 promptfoo 相关代码已于 2026-05-24 删除**。

## 历史回查

如果需要看旧的 promptfoo 实现（配置 / wrapper / yaml-to-tests 转换脚本 / promptfoo-sync）：

```bash
# 看最后一次完整状态（在删除 _legacy 物理文件之前）
git log --oneline --all -- 'evals/promptfoo/**' 'evals/_legacy/promptfoo/**' | head

# 恢复某个文件查看
git show <commit>:evals/promptfoo/promptfooconfig.yaml
git show <commit>:evals/promptfoo/lib/yaml-to-tests.ts
git show <commit>:evals/promptfoo/providers/sid-code-live.ts
git show <commit>:scripts/eval/promptfoo-sync.ts
```

关键 commit 参考：
- `43bd3d6 fix: 彻底清除promtfoo引用` — 删除前最后一次完整快照
- 更早的 commit 在 master 历史里完整保留

## 紧急回滚方案

如果 `eval-runner.ts` 完全不可用、必须临时回到 promptfoo（**极端情况**）：

```bash
# 1. 找到上次工作的 commit
git log --oneline -- evals/promptfoo/ | head -5

# 2. checkout 当时的整个 evals/promptfoo/ 目录
git checkout <commit> -- evals/promptfoo/

# 3. 恢复 promptfoo-sync.ts
git checkout <commit> -- scripts/eval/promptfoo-sync.ts

# 4. 恢复 package.json 的 eval:horizontal-* 脚本
git show <commit>:package.json | grep horizontal
```

但更推荐：直接修 `eval-runner.ts`。promptfoo 时代的双套 wrapper / 黑盒并发 / 评分公式重复等问题不值得重启。

## 为什么不留着

2026-05-24 用户明确指示删除：保留只会让新人 grep 'promptfoo' 撞到死代码，造成误导。
git history 已经是足够的"博物馆"，物理文件留在仓库只增加认知负担。
