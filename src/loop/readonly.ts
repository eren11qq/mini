// C4(docs/ISSUES.md):内置只读命令白名单 —— 只读 bash 段免弹且不产生规则(纯函数叶子,
// 照 danger/bash-parse 先例,只 import bash-parse 的类型)。数据表住本模块,不放工具、
// 不被 rules.json 覆盖(全允许防线仍由 rules.isValidSeed 把守)。
import type { Parsed, Seg } from "./bash-parse.ts";

// 裸只读命令:argv[0] 命中即只读(任意参数,出口条件另判)。
const READONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "pwd",
  "whoami",
  "date",
  "sort",
  "uniq",
  "tree",
]);

// 家族只读:argv[0]=键 且 argv[1]∈值集才算(git/node/npm 非只读默认,仅列子命令/flag)。
const READONLY_FAMILIES: Record<string, Set<string>> = {
  git: new Set(["status", "diff", "log", "show", "branch", "blame"]),
  node: new Set(["--version"]),
  npm: new Set(["ls"]),
};

// 写副作用 flag:首版只 `find`(issue 点名 `-delete` 类)。任一 token 精确命中 → 该段出局。
// flag 列表进同表、可手改增长。
const WRITE_FLAGS: Record<string, string[]> = {
  find: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf"],
};

function readOnlySeg(seg: Seg): boolean {
  if (seg.redirect || seg.substitution) return false;
  const [head, sub] = seg.tokens;
  if (head === undefined) return false;
  const writeFlags = WRITE_FLAGS[head];
  if (writeFlags && seg.tokens.some((t) => writeFlags.includes(t))) return false;
  if (READONLY_COMMANDS.has(head)) return true;
  return READONLY_FAMILIES[head]?.has(sub ?? "") === true;
}

export function readOnlyParsed(parsed: Parsed): boolean {
  if (!parsed.ok || parsed.segments.length === 0) return false;
  return parsed.segments.every(readOnlySeg);
}
