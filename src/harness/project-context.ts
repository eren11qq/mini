// H3 S-b:cwd 向上找项目上下文。裁决(plan H3 判卷):跨目录恒近者赢 —— 从 cwd 逐层
// 往上,首个命中即返回;同目录 AGENTS.md > CLAUDE.md(用户裁决,AGENTS 为跨工具标准)。
// root = 向上停点(含):缺省走到文件系统根;测试传入锁边界。皆无 = null。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";

const CANDIDATES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface FoundContext {
  path: string;
  content: string;
}

export function findProjectContext(opts: { cwd: string; root?: string }): FoundContext | null {
  const stop = opts.root ?? parsePath(opts.cwd).root;
  let cur = opts.cwd;
  for (;;) {
    for (const name of CANDIDATES) {
      const file = join(cur, name);
      if (existsSync(file)) {
        return { path: file, content: readFileSync(file, "utf8") };
      }
    }
    if (cur === stop || cur === dirname(cur)) return null; // 命中停点 / 到根仍无
    cur = dirname(cur);
  }
}
