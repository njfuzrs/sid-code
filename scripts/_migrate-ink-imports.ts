#!/usr/bin/env bun
// 机械重写: 把 sid-code consumer 文件里 `from "ink"` 的导入按符号映射改为 vendored ink 路径。
// 只处理"纯机械"符号; 含 Static/ResizeObserver/getBoundingBox/StyledChar*/render 的硬文件交给人工/agent。
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// 硬文件: 已人工处理(多符号或整文件改造)或交给测试基建阶段, 脚本跳过
const HARD_FILES = new Set([
  'src/ui/components/MainScreenLayout.tsx',   // Static (已人工)
  'src/ui/components/VirtualizedList.tsx',     // ResizeObserver (已人工)
  'src/ui/contexts/ScrollProvider.tsx',        // getBoundingBox (已人工)
  'src/ui/components/TableRenderer.tsx',        // StyledChar (已人工)
  'src/ui/fullscreen.ts',                       // render async (已人工)
  'src/ui/components/ShortcutsHelp.test.tsx',   // 测试基建
  'src/ui/components/CoreRendering.test.tsx',   // 测试基建
])

// 符号 → 生成 import 语句的函数 (P = ink 相对前缀)
type Gen = (P: string) => string
const VALUE_MAP: Record<string, Gen> = {
  Box: P => `import Box from "${P}/components/Box.js";`,
  Text: P => `import Text from "${P}/components/Text.js";`,
  useApp: P => `import useApp from "${P}/hooks/use-app.js";`,
  useInput: P => `import useInput from "${P}/hooks/use-input.js";`,
  useStdin: P => `import useStdin from "${P}/hooks/use-stdin.js";`,
  useStdout: P => `import useStdout from "${P}/_vendor/use-stdout.js";`,
  measureElement: P => `import measureElement from "${P}/measure-element.js";`,
  ResizeObserver: P => `import { ResizeObserver } from "${P}/_vendor/resize-observer.js";`,
  getBoundingBox: P => `import { getBoundingBox } from "${P}/_vendor/get-bounding-box.js";`,
  Static: P => `import Static from "${P}/_vendor/Static.js";`,
}
const TYPE_MAP: Record<string, Gen> = {
  DOMElement: P => `import type { DOMElement } from "${P}/dom.js";`,
  BoxProps: P => `import type { Props as BoxProps } from "${P}/components/Box.js";`,
  TextProps: P => `import type { Props as TextProps } from "${P}/components/Text.js";`,
}
const KNOWN = new Set([...Object.keys(VALUE_MAP), ...Object.keys(TYPE_MAP)])

function inkPrefix(file: string): string {
  // file like src/ui/components/Foo.tsx → depth = #segments after src/ minus filename
  const rel = file.replace(/^src\//, '')
  const depth = rel.split('/').length - 1
  return '../'.repeat(depth) + 'ink'
}

// 解析一条 import { ... } from "ink"; 行, 返回 {value:[], type:[]} 符号
function parseImportLine(line: string): { values: string[]; types: string[] } | null {
  const m = line.match(/import\s+\{([^}]*)\}\s+from\s+["']ink["']/)
  if (!m) return null
  const values: string[] = []
  const types: string[] = []
  for (let raw of m[1].split(',')) {
    raw = raw.trim()
    if (!raw) continue
    if (raw.startsWith('type ')) types.push(raw.slice(5).trim())
    else values.push(raw)
  }
  return { values, types }
}

const files = execSync('grep -rlnE "from [\\"\x27]ink[\\"\x27]" src/ --include="*.ts" --include="*.tsx"', { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).filter(f => !f.includes('/ink/'))

const report: string[] = []
for (const file of files) {
  if (HARD_FILES.has(file)) { report.push(`SKIP (hard): ${file}`); continue }
  const P = inkPrefix(file)
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  const out: string[] = []
  let changed = false
  let unknownSym = false
  for (const line of lines) {
    const parsed = parseImportLine(line)
    if (!parsed) { out.push(line); continue }
    // 检查是否有未知符号 → 若有, 整行保留 (该文件应被列为 hard, 报错)
    const all = [...parsed.values, ...parsed.types]
    const unknown = all.filter(s => !KNOWN.has(s))
    if (unknown.length) {
      unknownSym = true
      report.push(`!! UNKNOWN SYMBOLS in ${file}: ${unknown.join(', ')} — left untouched`)
      out.push(line)
      continue
    }
    // 生成替换行
    const newLines: string[] = []
    for (const v of parsed.values) newLines.push(VALUE_MAP[v](P))
    for (const t of parsed.types) newLines.push(TYPE_MAP[t](P))
    out.push(...newLines)
    changed = true
  }
  if (changed && !unknownSym) {
    writeFileSync(file, out.join('\n'))
    report.push(`OK: ${file}`)
  } else if (!changed) {
    report.push(`?? no ink import line matched: ${file}`)
  }
}
console.log(report.join('\n'))
console.log(`\nTotal: ${files.length} files, ${report.filter(r=>r.startsWith('OK')).length} rewritten, ${report.filter(r=>r.startsWith('SKIP')).length} skipped(hard)`)
