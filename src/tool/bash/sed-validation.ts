/**
 * sed 写操作检测
 * 检测 sed -i 命令并提取编辑信息
 */

/**
 * sed 写操作检测结果
 */
export interface SedWriteInfo {
  isSedWrite: boolean;
  targetFile?: string;
  editDescription?: string;
}

/**
 * 检测 sed 写操作并提取编辑信息
 *
 * 匹配模式：
 * - sed -i 's/old/new/g' file.txt
 * - sed -i.bak 's/old/new/' file.txt
 * - sed --in-place 's/old/new/' file.txt
 */
export function detectSedWrite(command: string): SedWriteInfo {
  // 匹配 sed -i 或 sed --in-place
  const sedMatch = command.match(
    /sed\s+(-i\S*|--in-place\S*)\s+(['"]?)s\/(.+?)\/(.+?)\/(g?)\2\s+(\S+)/
  );

  if (!sedMatch) {
    // 尝试更宽松的匹配（sed -i 后跟任意表达式）
    const looseMatch = command.match(
      /sed\s+(-i\S*|--in-place\S*)\s+.+?\s+(\S+)\s*$/
    );
    if (looseMatch) {
      return {
        isSedWrite: true,
        targetFile: looseMatch[2],
        editDescription: "sed 就地编辑",
      };
    }
    return { isSedWrite: false };
  }

  return {
    isSedWrite: true,
    targetFile: sedMatch[6],
    editDescription: `将 "${sedMatch[3]}" 替换为 "${sedMatch[4]}"${sedMatch[5] ? "（全局）" : ""}`,
  };
}
