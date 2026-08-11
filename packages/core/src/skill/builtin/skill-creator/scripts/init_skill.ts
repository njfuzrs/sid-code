#!/usr/bin/env bun
/**
 * Skill 初始化脚本
 * 自动生成 Skill 目录结构和模板文件
 *
 * 用法：
 *   bun run init_skill.ts <skill-name> [mode]
 *
 * 参数：
 *   skill-name: Skill 名称（slug 格式）
 *   mode: 执行模式（activate 或 delegate，默认 delegate）
 *
 * 示例：
 *   bun run init_skill.ts code-review delegate
 *   bun run init_skill.ts pdf-processor activate
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// 解析命令行参数
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("错误: 缺少 Skill 名称参数");
  console.error("用法: bun run init_skill.ts <skill-name> [mode]");
  process.exit(1);
}

const skillName = args[0];
const mode = args[1] || "delegate";

// 验证 Skill 名称
if (!/^[a-z0-9][a-z0-9-_]*$/i.test(skillName)) {
  console.error(`错误: Skill 名称 "${skillName}" 不符合 slug 格式`);
  console.error("名称只能包含字母、数字、连字符和下划线，且必须以字母或数字开头");
  process.exit(1);
}

// 验证模式
if (mode !== "activate" && mode !== "delegate") {
  console.error(`错误: 模式 "${mode}" 无效，只能是 activate 或 delegate`);
  process.exit(1);
}

// 确定 Skill 目录（尊重 SID_CONFIG_DIR 覆盖，与主程序配置根一致）
const sidHome = process.env.SID_CONFIG_DIR?.trim() || join(homedir(), ".sid-code");
const skillsDir = join(sidHome, "skills");
if (!existsSync(skillsDir)) {
  mkdirSync(skillsDir, { recursive: true });
}

// 根据模式选择文件结构
if (mode === "delegate") {
  // 扁平文件模式
  const skillFile = join(skillsDir, `${skillName}.md`);

  if (existsSync(skillFile)) {
    console.error(`错误: Skill 文件已存在: ${skillFile}`);
    process.exit(1);
  }

  const template = `---
name: ${skillName}
description: TODO: 添加 Skill 描述
when-to-use: TODO: 说明何时使用此 Skill
mode: delegate
allowed-tools: read, write, grep
max-turns: 10
timeout-mins: 2
---

# ${skillName}

## 功能说明

TODO: 详细说明 Skill 的功能和使用方法

## 使用示例

TODO: 提供具体的使用示例

## 注意事项

TODO: 列出使用时的注意事项
`;

  writeFileSync(skillFile, template, "utf-8");
  console.log(`✓ 已创建 Skill 文件: ${skillFile}`);
  console.log("\n下一步:");
  console.log("1. 编辑文件，填写 TODO 部分");
  console.log("2. 根据需要调整 allowed-tools、max-turns、timeout-mins");
  console.log("3. 重启 sid-code 以加载新 Skill");

} else {
  // 子目录模式（activate）
  const skillDir = join(skillsDir, skillName);

  if (existsSync(skillDir)) {
    console.error(`错误: Skill 目录已存在: ${skillDir}`);
    process.exit(1);
  }

  // 创建目录结构
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(join(skillDir, "scripts"));
  mkdirSync(join(skillDir, "references"));
  mkdirSync(join(skillDir, "assets"));

  // 创建 SKILL.md
  const skillMd = `---
name: ${skillName}
description: TODO: 添加 Skill 描述
when-to-use: TODO: 说明何时使用此 Skill
mode: activate
---

# ${skillName}

## 功能说明

TODO: 详细说明 Skill 的功能和使用方法

## 可用资源

### scripts/
可执行脚本，LLM 可通过 bash 工具执行：
- TODO: 列出脚本及其用途

### references/
参考文档，LLM 可通过 read 工具按需读取：
- TODO: 列出文档及其内容

### assets/
输出资源（模板、图片等），LLM 在生成输出时使用：
- TODO: 列出资源及其用途

## 使用示例

TODO: 提供具体的使用示例

## 注意事项

TODO: 列出使用时的注意事项
`;

  writeFileSync(join(skillDir, "SKILL.md"), skillMd, "utf-8");

  // 创建示例脚本
  const exampleScript = `#!/usr/bin/env bun
/**
 * 示例脚本
 * TODO: 添加脚本说明
 */

console.log("Hello from ${skillName}!");
`;

  writeFileSync(join(skillDir, "scripts", "example.ts"), exampleScript, "utf-8");

  // 创建示例参考文档
  const exampleRef = `# 参考文档

TODO: 添加参考文档内容

## API 说明

TODO: 如果有 API，在此说明

## 最佳实践

TODO: 列出最佳实践
`;

  writeFileSync(join(skillDir, "references", "README.md"), exampleRef, "utf-8");

  // 创建示例资源文件
  const exampleAsset = `<!-- 示例模板 -->
TODO: 添加模板内容
`;

  writeFileSync(join(skillDir, "assets", "template.md"), exampleAsset, "utf-8");

  console.log(`✓ 已创建 Skill 目录: ${skillDir}`);
  console.log("\n目录结构:");
  console.log(`${skillName}/`);
  console.log("  ├── SKILL.md");
  console.log("  ├── scripts/");
  console.log("  │   └── example.ts");
  console.log("  ├── references/");
  console.log("  │   └── README.md");
  console.log("  └── assets/");
  console.log("      └── template.md");
  console.log("\n下一步:");
  console.log("1. 编辑 SKILL.md，填写 TODO 部分");
  console.log("2. 在 scripts/ 中添加实际的脚本");
  console.log("3. 在 references/ 中添加参考文档");
  console.log("4. 在 assets/ 中添加模板或资源文件");
  console.log("5. 重启 sid-code 以加载新 Skill");
}
