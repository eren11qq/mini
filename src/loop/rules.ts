// T2 AC-T2-7/8:rules.json 持久化(DECISIONS T4:项目目录、明文、手删即撤销、仅前缀、禁全允许)。
// 明文数组 [{tool,prefix}]。读写走 node:fs 回调形态 —— 错误是回调参数不是异常,
// 守住 loop 源零 try-catch 约束(L1-2 must-not)。文件缺失/读败 = 无规则,手删即撤销的正路。
// JSON 语法错(手改坏文件)不在 AC 场景:parse throw = 显式崩,不静默吞。
import { readFile, writeFile } from "node:fs";

export interface Rule {
  tool: string;
  prefix: string;
}

export function loadRules(path: string): Promise<Rule[]> {
  return new Promise((resolve) => {
    readFile(path, "utf8", (err, data) => {
      if (err) return resolve([]);
      const parsed: unknown = JSON.parse(data);
      resolve(
        Array.isArray(parsed)
          ? (parsed.filter(
              (r) =>
                typeof r === "object" &&
                r !== null &&
                typeof (r as Rule).tool === "string" &&
                typeof (r as Rule).prefix === "string",
            ) as Rule[])
          : [],
      );
    });
  });
}

// always → 追加落盘,返回含新规则的列表(同 run 内缓存同步)。
// 写失败(只读目录等)不崩:规则只是优化,丢了下次重新弹 = 安全默认。
export function appendRule(path: string, rule: Rule): Promise<Rule[]> {
  return loadRules(path).then((rules) => {
    const next = [...rules, rule];
    return new Promise<Rule[]>((resolve) => {
      writeFile(path, JSON.stringify(next, null, 2) + "\n", () => resolve(next));
    });
  });
}

// AC-T2-8 + C2:全允许防线 —— `*`/空/空家族 `:*` 永不接受为规则种子(写侧拒 + 读侧滤)。
export function isValidSeed(prefix: string): boolean {
  return prefix.length > 0 && prefix !== "*" && prefix !== ":*";
}

// C1:`path:` 前缀 = 分段 glob(`*` 段内不跨 `/`,`**` 跨段)。元字符全逃逸,无 throw 路径。
function globToRe(pat: string): RegExp {
  const re = pat
    .split("**")
    .map((seg) =>
      seg
        .split("*")
        .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${re}$`);
}

// C2:规则匹配器 = 纯字符串语义,零工具名知识。`path:` = 文件 glob;`xxx:*` 后缀 =
// token 前缀家族(规则 token 序列是输入 token 序列的前缀,`git status:*` 命中
// `git status -sb`);其余 = 整串相等。
export function ruleMatches(rule: Rule, input: string): boolean {
  const p = rule.prefix;
  if (p.startsWith("path:") && input.startsWith("path:")) {
    return globToRe(p.slice(5)).test(input.slice(5));
  }
  if (p.endsWith(":*")) {
    const want = p.slice(0, -2).trim().split(/\s+/);
    const got = input.trim().split(/\s+/);
    return want.length > 0 && want[0] !== "" && want.every((t, i) => got[i] === t);
  }
  return p === input;
}
